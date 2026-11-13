import { BRAND } from '@shared/brand';
import {
  isExtensionContextValid,
  requestRuntimeWarmup,
} from '@shared/messaging';
import {
  evaluateAutoTranslateDecision,
  type AutoTranslateDecision,
} from '@shared/page-language';
import { getMarginConfig, onMarginConfigChanged } from '@shared/storage';
import type {
  AnyTabMessage,
  MarginConfig,
  TabCommandMessage,
  TabPageState,
  TranslationScene,
} from '@shared/types';
import {
  isUnsupportedBrowserUrl,
  isUrlExcluded,
  matchesAnyUrlGlob,
} from '@shared/url-match';
import { samplePageProseForLanguageDetection } from './dom-walker';
import { HoverTranslator } from './hover-translate';
import {
  InputQuickTranslator,
  type InputBatchTransportFn,
} from './input-translate';
import { WebpageRenderer, type BatchTransportFn } from './renderer';
import {
  SelectionPopover,
  type SelectionTransportFn,
} from './selection-popover';

export * from './dom-walker';
export * from './rich-text';
export * from './renderer';
export * from './input-translate';
export * from './hover-translate';
export * from './selection-popover';

export const FOREIGN_SAMPLE_THRESHOLD = 24;
export const TWEET_FOREIGN_SAMPLE_THRESHOLD = 18;
export const HYDRATION_THROTTLE_MS = 60;
const HYDRATION_MAX_WINDOW_MS = 12_000;
const HYDRATION_MAX_CHECKS = 200;

const TWEET_NOISE_TOKEN_RE =
  /(?:https?:\/\/\S+|\bwww\.\S+|\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b|@[A-Za-z0-9_.-]+|#[\p{L}\p{N}_-]+)/gu;

function countMeaningfulSampleLetters(sample: string): number {
  if (!sample) return 0;
  const cleaned = sample.replace(TWEET_NOISE_TOKEN_RE, ' ');
  return cleaned.match(/\p{L}/gu)?.length ?? 0;
}

type HandledTabCommandType = Exclude<
  TabCommandMessage['type'],
  'margin:cmd:translate-context-image'
>;

function resolveAutoTranslateModeRank(cfg: MarginConfig): number {
  const mode = cfg.webpage.autoTranslateMode;
  if (mode === 'foreign') return 2;
  if (mode === 'whitelist') return 1;
  if (mode === 'off') return 0;
  return cfg.webpage.autoTranslateMatches ? 1 : 0;
}

function didAutoTranslateBecomeMorePermissive(
  prev: MarginConfig,
  next: MarginConfig,
  currentUrl: string,
): boolean {
  if (resolveAutoTranslateModeRank(next) > resolveAutoTranslateModeRank(prev)) {
    return true;
  }
  if (
    next.urlRules.includeMatches.some(
      (pat) => !prev.urlRules.includeMatches.includes(pat),
    )
  ) {
    return true;
  }
  if (
    matchesAnyUrlGlob(currentUrl, next.urlRules.includeMatches) &&
    !matchesAnyUrlGlob(currentUrl, prev.urlRules.includeMatches)
  ) {
    return true;
  }
  if (
    isUrlExcluded(currentUrl, prev.urlRules) &&
    !isUrlExcluded(currentUrl, next.urlRules)
  ) {
    return true;
  }
  const prevLangs = (prev.webpage.autoTranslateLanguages ?? [])
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  const nextLangs = (next.webpage.autoTranslateLanguages ?? [])
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  if (
    (prevLangs.length > 0 && nextLangs.length === 0) ||
    nextLangs.some((l) => !prevLangs.includes(l))
  ) {
    return true;
  }
  return false;
}

function isMarginInternalMutation(mutation: MutationRecord): boolean {
  let curr: Node | null = mutation.target;
  while (curr) {
    if (curr.nodeType === Node.ELEMENT_NODE) {
      const el = curr as Element;
      if (
        el.hasAttribute('data-margin-injected') ||
        el.hasAttribute('data-margin-host') ||
        el.getAttribute('data-margin-orig-wrap') === 'true'
      ) {
        return true;
      }
    }
    curr = curr.parentNode;
  }

  if (mutation.type === 'childList') {
    const externalAddedOrRemoved = (list: NodeList): boolean => {
      for (let i = 0; i < list.length; i++) {
        const node = list[i];
        if (node.nodeType !== Node.ELEMENT_NODE) {
          return true;
        }
        const el = node as Element;
        if (
          !el.hasAttribute('data-margin-injected') &&
          !el.hasAttribute('data-margin-host') &&
          el.getAttribute('data-margin-orig-wrap') !== 'true'
        ) {
          return true;
        }
      }
      return false;
    };
    if (
      (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0) &&
      !externalAddedOrRemoved(mutation.addedNodes) &&
      !externalAddedOrRemoved(mutation.removedNodes)
    ) {
      return true;
    }
  }

  return false;
}

export interface MarginContentControllerOptions {
  config: MarginConfig;
  doc?: Document;
  getUrl?: () => string;
  transport?: BatchTransportFn & InputBatchTransportFn & SelectionTransportFn;
  warmup?: (payload?: {
    providerId?: string;
    scene?: TranslationScene;
  }) => Promise<{ ok: boolean; warmedProviderId?: string }>;
  now?: () => number;
}

export class MarginContentController {
  private config: MarginConfig;
  private readonly doc: Document;
  private readonly getUrl: () => string;
  private readonly now: () => number;
  private readonly warmup: (payload?: {
    providerId?: string;
    scene?: TranslationScene;
  }) => Promise<{ ok: boolean; warmedProviderId?: string }>;

  readonly renderer: WebpageRenderer;
  readonly inputTranslator: InputQuickTranslator;
  readonly hoverTranslator: HoverTranslator;
  readonly selectionPopover: SelectionPopover;

  private manuallyEnabled = false;
  private manuallyDisabledInSession = false;
  private autoTranslated = false;
  private detectedPageLang: string | undefined;
  private mounted = false;
  private hadRuntimeIdAtMount = false;
  private spaFollowUpTimer: ReturnType<typeof setTimeout> | null = null;
  private hydrationObserver: MutationObserver | null = null;
  private hydrationThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  private hydrationMaxTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private lastHydrationCheckAt: number | null = null;
  private hydrationCheckCount = 0;
  private unsubscribeStorage: (() => void) | null = null;
  private cleanupRuntimeMessage: (() => void) | null = null;
  private cleanupDomListeners: (() => void) | null = null;

  private readonly lastTriggerRecord = new Map<
    HandledTabCommandType,
    { source: 'cmd' | 'key'; at: number }
  >();

  constructor(options: MarginContentControllerOptions) {
    this.config = options.config;
    this.doc = options.doc ?? document;
    this.getUrl =
      options.getUrl ??
      (() =>
        this.doc.location?.href ||
        (typeof location !== 'undefined' ? location.href : ''));
    this.now = options.now ?? (() => Date.now());
    this.warmup = options.warmup ?? requestRuntimeWarmup;

    this.renderer = new WebpageRenderer({
      config: this.config,
      doc: this.doc,
      getUrl: this.getUrl,
      transport: options.transport,
      onManualStop: () => {
        this.stopHydrationObserver();
        this.clearSpaFollowUpTimer();
        this.manuallyDisabledInSession = true;
        this.manuallyEnabled = false;
        this.autoTranslated = false;
      },
    });

    this.inputTranslator = new InputQuickTranslator({
      config: this.config,
      doc: this.doc,
      getUrl: this.getUrl,
      now: this.now,
      transport: options.transport,
      isUrlExcluded: () => this.isExplicitlyDomainExcluded(),
    });

    this.hoverTranslator = new HoverTranslator({
      config: this.config,
      renderer: this.renderer,
      doc: this.doc,
      isUrlExcluded: () => this.isExplicitlyDomainExcluded(),
    });

    this.selectionPopover = new SelectionPopover({
      config: this.config,
      doc: this.doc,
      getUrl: this.getUrl,
      now: this.now,
      transport: options.transport,
      isUrlExcluded: () => this.isExplicitlyDomainExcluded(),
    });
  }

  isExplicitlyDomainExcluded(): boolean {
    return matchesAnyUrlGlob(this.getUrl(), this.config.urlRules.excludeMatches);
  }

  isCurrentUrlExcluded(): boolean {
    return isUrlExcluded(this.getUrl(), this.config.urlRules);
  }

  getPageState(): TabPageState {
    const base = this.renderer.getPageState();
    return {
      ...base,
      autoTranslated: base.active ? this.autoTranslated : false,
      ...(this.detectedPageLang ? { detectedPageLang: this.detectedPageLang } : {}),
    };
  }

  clearPageCache(): void {
    this.renderer.clearCache();
  }

  evaluateAutoTranslate(): AutoTranslateDecision {
    const currentUrl = this.getUrl();
    const htmlLang =
      this.doc.documentElement?.getAttribute('lang')?.trim() || undefined;
    const sampleText = samplePageProseForLanguageDetection(this.doc.body);
    let decision = evaluateAutoTranslateDecision({
      url: currentUrl,
      targetLang: this.config.targetLang,
      webpage: this.config.webpage,
      urlRules: this.config.urlRules,
      htmlLang,
      sampleText,
      manuallyDisabledInSession: this.manuallyDisabledInSession,
    });

    if (decision.reason === 'awaiting-content' && this.doc.body) {
      const tweetNodes = this.doc.body.querySelectorAll('[data-testid="tweetText"]');
      for (let i = 0; i < tweetNodes.length; i++) {
        const tweetSample = samplePageProseForLanguageDetection(tweetNodes[i], 360);
        if (countMeaningfulSampleLetters(tweetSample) >= TWEET_FOREIGN_SAMPLE_THRESHOLD) {
          const tweetDecision = evaluateAutoTranslateDecision({
            url: currentUrl,
            targetLang: this.config.targetLang,
            webpage: this.config.webpage,
            urlRules: this.config.urlRules,
            htmlLang,
            sampleText: `${tweetSample} ${tweetSample}`,
            manuallyDisabledInSession: this.manuallyDisabledInSession,
          });
          if (tweetDecision.reason !== 'awaiting-content') {
            decision = tweetDecision;
            break;
          }
        }
      }
    }

    if (decision.reason !== 'manual-session-off') {
      this.detectedPageLang = decision.detectedLang;
    }
    return decision;
  }

  shouldAutoTranslateCurrentUrl(): boolean {
    return this.evaluateAutoTranslate().shouldTranslate;
  }

  enablePageTranslation(manual = false): void {
    this.stopHydrationObserver();
    this.manuallyEnabled = manual;
    this.autoTranslated = !manual;
    if (manual) {
      this.manuallyDisabledInSession = false;
    }
    this.renderer.enablePageTranslation();
  }

  disablePageTranslation(): void {
    this.stopHydrationObserver();
    this.clearSpaFollowUpTimer();
    this.manuallyEnabled = false;
    this.autoTranslated = false;
    this.renderer.restorePage();
  }

  private stopHydrationObserver(): void {
    if (this.hydrationThrottleTimer !== null) {
      clearTimeout(this.hydrationThrottleTimer);
      this.hydrationThrottleTimer = null;
    }
    if (this.hydrationMaxTimeoutTimer !== null) {
      clearTimeout(this.hydrationMaxTimeoutTimer);
      this.hydrationMaxTimeoutTimer = null;
    }
    this.lastHydrationCheckAt = null;
    this.hydrationObserver?.disconnect();
    this.hydrationObserver = null;
    this.hydrationCheckCount = 0;
  }

  private attemptAutoTranslateCheck(): void {
    if (
      !this.mounted ||
      this.renderer.isActive ||
      this.manuallyDisabledInSession
    ) {
      this.stopHydrationObserver();
      return;
    }
    if (!isExtensionContextValid(this.hadRuntimeIdAtMount)) {
      this.destroy({ contextInvalidated: true });
      return;
    }

    this.lastHydrationCheckAt = this.now();
    this.hydrationCheckCount += 1;
    const decision = this.evaluateAutoTranslate();
    if (decision.shouldTranslate && !this.renderer.isActive) {
      this.enablePageTranslation(false);
      return;
    }
    if (
      !decision.needsHydrationRecheck ||
      this.hydrationCheckCount >= HYDRATION_MAX_CHECKS
    ) {
      this.stopHydrationObserver();
    }
  }

  private startHydrationObserver(): void {
    if (this.hydrationObserver || typeof MutationObserver === 'undefined') {
      return;
    }
    const body = this.doc.body;
    if (!body) return;

    this.hydrationCheckCount = 0;
    this.lastHydrationCheckAt = null;

    const onMutations = (mutations: MutationRecord[]) => {
      if (
        !this.mounted ||
        this.renderer.isActive ||
        this.manuallyDisabledInSession
      ) {
        this.stopHydrationObserver();
        return;
      }
      if (!isExtensionContextValid(this.hadRuntimeIdAtMount)) {
        this.destroy({ contextInvalidated: true });
        return;
      }

      let hasExternalMutation = false;
      for (let i = 0; i < mutations.length; i++) {
        if (!isMarginInternalMutation(mutations[i])) {
          hasExternalMutation = true;
          break;
        }
      }
      if (!hasExternalMutation) {
        return;
      }

      const nowMs = this.now();
      const elapsed =
        this.lastHydrationCheckAt === null
          ? Number.POSITIVE_INFINITY
          : nowMs - this.lastHydrationCheckAt;

      if (elapsed >= HYDRATION_THROTTLE_MS && this.hydrationThrottleTimer === null) {
        this.attemptAutoTranslateCheck();
        return;
      }

      if (this.hydrationThrottleTimer !== null) {
        return;
      }

      const waitMs = Math.max(1, HYDRATION_THROTTLE_MS - Math.max(0, elapsed));
      this.hydrationThrottleTimer = setTimeout(() => {
        this.hydrationThrottleTimer = null;
        this.attemptAutoTranslateCheck();
      }, waitMs);
    };

    this.hydrationObserver = new MutationObserver(onMutations);
    this.hydrationObserver.observe(body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['is-empty', 'hidden'],
    });

    this.hydrationMaxTimeoutTimer = setTimeout(() => {
      this.hydrationMaxTimeoutTimer = null;
      this.stopHydrationObserver();
    }, HYDRATION_MAX_WINDOW_MS);
  }

  private runAutoTranslateEvaluation(): void {
    if (this.renderer.isActive) {
      this.stopHydrationObserver();
      return;
    }
    const decision = this.evaluateAutoTranslate();
    if (decision.shouldTranslate) {
      this.enablePageTranslation(false);
      return;
    }
    if (decision.needsHydrationRecheck && !this.manuallyDisabledInSession) {
      this.startHydrationObserver();
    } else {
      this.stopHydrationObserver();
    }
  }

  private clearSpaFollowUpTimer(): void {
    if (this.spaFollowUpTimer !== null) {
      clearTimeout(this.spaFollowUpTimer);
      this.spaFollowUpTimer = null;
    }
  }

  dispatchRuntimeMessage(
    message: unknown,
    sendResponse: (response?: unknown) => void,
  ): boolean | undefined {
    if (!message || typeof message !== 'object') return undefined;
    const cmd = message as Partial<AnyTabMessage>;
    if (cmd.type === 'margin:cmd:get-page-state') {
      sendResponse(this.getPageState());
      return false;
    }
    if (cmd.type === 'margin:cmd:clear-page-cache') {
      this.renderer.clearCache();
      sendResponse({ ok: true });
      return false;
    }
    if (
      cmd.type === 'margin:cmd:toggle-page' ||
      cmd.type === 'margin:cmd:translate-whole-page' ||
      cmd.type === 'margin:cmd:toggle-mask' ||
      cmd.type === 'margin:cmd:translate-input'
    ) {
      void this.handleCommand(
        { type: cmd.type } as TabCommandMessage,
        'cmd',
      ).then((res) => {
        sendResponse({
          ok: true,
          result: res,
          state: this.getPageState(),
        });
      });
      return true;
    }
    // Leave `margin:cmd:translate-context-image` untouched for `image-entry.ts`
    return undefined;
  }

  mount(): void {
    if (this.mounted) return;
    const currentUrl = this.getUrl();
    if (isUnsupportedBrowserUrl(currentUrl)) {
      return;
    }

    this.mounted = true;
    this.hadRuntimeIdAtMount = Boolean(globalThis.chrome?.runtime?.id);

    if (!this.isCurrentUrlExcluded()) {
      void this.warmup({ scene: 'webpage' });
    }

    this.inputTranslator.mount();
    this.hoverTranslator.mount();
    this.selectionPopover.mount();

    this.runAutoTranslateEvaluation();

    // Subscribe to live configuration changes
    this.unsubscribeStorage = onMarginConfigChanged((nextConfig) => {
      this.applyConfigUpdate(nextConfig);
    });

    // Listen for background TabCommandMessages
    if (
      typeof globalThis.chrome !== 'undefined' &&
      globalThis.chrome?.runtime?.onMessage
    ) {
      const runtimeListener = (
        message: unknown,
        _sender: chrome.runtime.MessageSender,
        sendResponse: (response?: unknown) => void,
      ): boolean | undefined => this.dispatchRuntimeMessage(message, sendResponse);

      chrome.runtime.onMessage.addListener(runtimeListener);
      this.cleanupRuntimeMessage = () => {
        try {
          chrome.runtime.onMessage.removeListener(runtimeListener);
        } catch {
          // Ignore removal errors when extension context is invalidated
        }
      };
    }

    // Bind in-page keyboard shortcuts & SPA navigation listeners
    const win = this.doc.defaultView ?? window;

    const onKeyDown = (ev: KeyboardEvent) => {
      if (!isExtensionContextValid(this.hadRuntimeIdAtMount)) {
        this.destroy({ contextInvalidated: true });
        return;
      }

      if (
        !ev.altKey ||
        ev.ctrlKey ||
        ev.metaKey ||
        ev.shiftKey ||
        ev.isComposing ||
        ev.repeat
      ) {
        return;
      }

      const code = ev.code || `Key${ev.key.toUpperCase()}`;
      let cmdType: HandledTabCommandType | null = null;
      if (code === 'KeyA') {
        cmdType = 'margin:cmd:toggle-page';
      } else if (code === 'KeyW') {
        cmdType = 'margin:cmd:translate-whole-page';
      } else if (code === 'KeyM') {
        cmdType = 'margin:cmd:toggle-mask';
      } else if (code === 'KeyI') {
        cmdType = 'margin:cmd:translate-input';
      }

      if (cmdType) {
        ev.preventDefault();
        void this.handleCommand({ type: cmdType }, 'key');
      }
    };

    const onUrlChange = () => {
      if (!isExtensionContextValid(this.hadRuntimeIdAtMount)) {
        this.destroy({ contextInvalidated: true });
        return;
      }

      this.renderer.invalidatePageContextCache();
      this.renderer.updateConfig(this.config);

      if (
        (this.autoTranslated || !this.manuallyEnabled) &&
        this.renderer.isPageTranslationActive() &&
        this.isCurrentUrlExcluded()
      ) {
        this.disablePageTranslation();
        return;
      }

      if (!this.renderer.isPageTranslationActive()) {
        this.stopHydrationObserver();
        this.runAutoTranslateEvaluation();
      }

      if (this.renderer.isPageTranslationActive()) {
        this.renderer.rescanSubtree(this.doc.body);
        this.clearSpaFollowUpTimer();
        this.spaFollowUpTimer = setTimeout(() => {
          this.spaFollowUpTimer = null;
          if (!this.mounted || !this.renderer.isPageTranslationActive()) return;
          if (!isExtensionContextValid(this.hadRuntimeIdAtMount)) {
            this.destroy({ contextInvalidated: true });
            return;
          }
          this.renderer.invalidatePageContextCache();
          this.renderer.rescanSubtree(this.doc.body);
        }, 250);
      }
    };

    win.addEventListener('keydown', onKeyDown, false);
    win.addEventListener('popstate', onUrlChange);
    win.addEventListener('hashchange', onUrlChange);
    win.addEventListener('yt-navigate-finish', onUrlChange);
    this.doc.addEventListener('yt-navigate-finish', onUrlChange);

    this.cleanupDomListeners = () => {
      win.removeEventListener('keydown', onKeyDown, false);
      win.removeEventListener('popstate', onUrlChange);
      win.removeEventListener('hashchange', onUrlChange);
      win.removeEventListener('yt-navigate-finish', onUrlChange);
      this.doc.removeEventListener('yt-navigate-finish', onUrlChange);
    };
  }

  applyConfigUpdate(nextConfig: MarginConfig): void {
    const prevConfig = this.config;
    const currentUrl = this.getUrl();
    this.config = nextConfig;
    this.renderer.updateConfig(nextConfig);
    this.inputTranslator.updateConfig(nextConfig);
    this.hoverTranslator.updateConfig(nextConfig);
    this.selectionPopover.updateConfig(nextConfig);

    if (!this.mounted) return;

    if (this.isExplicitlyDomainExcluded()) {
      this.stopHydrationObserver();
      this.selectionPopover.close();
      this.inputTranslator.cancelInFlight();
      if (this.renderer.isActive) {
        this.disablePageTranslation();
      }
      return;
    }

    if (
      isUrlExcluded(currentUrl, nextConfig.urlRules) &&
      this.renderer.isActive &&
      (this.autoTranslated || !this.manuallyEnabled)
    ) {
      this.disablePageTranslation();
      return;
    }

    if (!this.renderer.isActive) {
      if (didAutoTranslateBecomeMorePermissive(prevConfig, nextConfig, currentUrl)) {
        this.manuallyDisabledInSession = false;
      }
      this.runAutoTranslateEvaluation();
    }
  }

  private isDuplicateCrossSourceTrigger(
    type: HandledTabCommandType,
    source: 'cmd' | 'key',
  ): boolean {
    const currentNow = this.now();
    const prev = this.lastTriggerRecord.get(type);
    this.lastTriggerRecord.set(type, { source, at: currentNow });
    if (prev && prev.source !== source && currentNow - prev.at <= 1200) {
      return true;
    }
    return false;
  }

  async handleCommand(
    command: AnyTabMessage,
    source: 'cmd' | 'key' = 'cmd',
  ): Promise<boolean> {
    if (command.type === 'margin:cmd:translate-context-image') {
      return false;
    }
    if (command.type === 'margin:cmd:get-page-state') {
      return this.renderer.isActive;
    }
    if (command.type === 'margin:cmd:clear-page-cache') {
      this.renderer.clearCache();
      return true;
    }

    if (this.isDuplicateCrossSourceTrigger(command.type, source)) {
      return false;
    }

    switch (command.type) {
      case 'margin:cmd:toggle-page': {
        this.stopHydrationObserver();
        if (this.renderer.isActive) {
          this.clearSpaFollowUpTimer();
          this.manuallyDisabledInSession = true;
          this.manuallyEnabled = false;
          this.autoTranslated = false;
          return this.renderer.togglePageTranslation();
        }
        this.manuallyDisabledInSession = false;
        this.manuallyEnabled = true;
        this.autoTranslated = false;
        return this.renderer.togglePageTranslation();
      }
      case 'margin:cmd:translate-whole-page': {
        this.stopHydrationObserver();
        this.manuallyDisabledInSession = false;
        this.manuallyEnabled = true;
        this.autoTranslated = false;
        await this.renderer.translateWholePage();
        return true;
      }
      case 'margin:cmd:toggle-mask': {
        return this.renderer.toggleGlobalMask();
      }
      case 'margin:cmd:translate-input': {
        return this.inputTranslator.translateActiveElement();
      }
    }
  }

  destroy(options: { contextInvalidated?: boolean } = {}): void {
    this.mounted = false;
    this.stopHydrationObserver();
    this.clearSpaFollowUpTimer();
    try {
      this.unsubscribeStorage?.();
    } catch {
      // Ignore storage unsubscribe errors when extension context is invalidated
    }
    this.unsubscribeStorage = null;
    try {
      this.cleanupRuntimeMessage?.();
    } catch {
      // Ignore runtime message cleanup errors when extension context is invalidated
    }
    this.cleanupRuntimeMessage = null;
    this.cleanupDomListeners?.();
    this.cleanupDomListeners = null;

    this.hoverTranslator.destroy();
    this.inputTranslator.destroy();
    this.selectionPopover.destroy();
    this.renderer.destroy(options);

    const globalBag = globalThis as Record<string, unknown>;
    const bootstrapKey = `__${BRAND.slug}_content_controller__`;
    if (globalBag[bootstrapKey] === this) {
      delete globalBag[bootstrapKey];
    }
  }
}

export async function bootstrapMarginContentScript(): Promise<MarginContentController | null> {
  const globalBag = globalThis as Record<string, unknown>;
  const bootstrapKey = `__${BRAND.slug}_content_controller__`;
  const bootstrapPromiseKey = `__${BRAND.slug}_content_bootstrap_promise__`;

  if (globalBag[bootstrapKey]) {
    return globalBag[bootstrapKey] as MarginContentController;
  }
  if (globalBag[bootstrapPromiseKey]) {
    return globalBag[bootstrapPromiseKey] as Promise<MarginContentController | null>;
  }

  const currentUrl = typeof location !== 'undefined' ? location.href : '';
  if (isUnsupportedBrowserUrl(currentUrl)) {
    return null;
  }

  let initPromise!: Promise<MarginContentController | null>;
  let earlyRuntimeListener:
    | ((
        message: unknown,
        sender: chrome.runtime.MessageSender,
        sendResponse: (response?: unknown) => void,
      ) => boolean | undefined)
    | null = null;

  if (
    typeof globalThis.chrome !== 'undefined' &&
    globalThis.chrome?.runtime?.onMessage
  ) {
    earlyRuntimeListener = (
      message: unknown,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response?: unknown) => void,
    ): boolean | undefined => {
      if (!message || typeof message !== 'object') return undefined;
      const cmd = message as Partial<AnyTabMessage>;
      if (
        cmd.type !== 'margin:cmd:get-page-state' &&
        cmd.type !== 'margin:cmd:clear-page-cache' &&
        cmd.type !== 'margin:cmd:toggle-page' &&
        cmd.type !== 'margin:cmd:translate-whole-page' &&
        cmd.type !== 'margin:cmd:toggle-mask' &&
        cmd.type !== 'margin:cmd:translate-input'
      ) {
        return undefined;
      }

      void initPromise
        .then((ctrl) => {
          if (!ctrl) {
            sendResponse({ ok: false });
            return;
          }
          ctrl.dispatchRuntimeMessage(message, sendResponse);
        })
        .catch(() => {
          sendResponse({ ok: false });
        });
      return true;
    };
    chrome.runtime.onMessage.addListener(earlyRuntimeListener);
  }

  initPromise = (async () => {
    try {
      const configPromise = getMarginConfig();
      if (typeof document !== 'undefined' && document.readyState === 'loading') {
        await new Promise<void>((resolve) => {
          document.addEventListener('DOMContentLoaded', () => resolve(), {
            once: true,
          });
        });
      }
      const config = await configPromise;
      const controller = new MarginContentController({ config });
      controller.mount();
      globalBag[bootstrapKey] = controller;
      return controller;
    } finally {
      delete globalBag[bootstrapPromiseKey];
      if (earlyRuntimeListener && globalThis.chrome?.runtime?.onMessage) {
        try {
          chrome.runtime.onMessage.removeListener(earlyRuntimeListener);
        } catch {
          // Ignore removal errors when extension context is invalidated
        }
      }
    }
  })();

  globalBag[bootstrapPromiseKey] = initPromise;
  return initPromise;
}

// Auto-bootstrap when injected as an MV3 Chrome extension content script
if (
  typeof globalThis.chrome !== 'undefined' &&
  Boolean(globalThis.chrome?.runtime?.id) &&
  typeof document !== 'undefined'
) {
  void bootstrapMarginContentScript();
}
