import { BRAND } from '@shared/brand';
import { isExtensionContextValid } from '@shared/messaging';
import { getMarginConfig, onMarginConfigChanged } from '@shared/storage';
import type {
  AnyTabMessage,
  MarginConfig,
  TabCommandMessage,
  TabPageState,
} from '@shared/types';
import {
  isUnsupportedBrowserUrl,
  isUrlExcluded,
  matchesAnyUrlGlob,
  shouldAutoTranslateUrl,
} from '@shared/url-match';
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

type HandledTabCommandType = Exclude<
  TabCommandMessage['type'],
  'margin:cmd:translate-context-image'
>;

export interface MarginContentControllerOptions {
  config: MarginConfig;
  doc?: Document;
  getUrl?: () => string;
  transport?: BatchTransportFn & InputBatchTransportFn & SelectionTransportFn;
  now?: () => number;
}

export class MarginContentController {
  private config: MarginConfig;
  private readonly doc: Document;
  private readonly getUrl: () => string;
  private readonly now: () => number;

  readonly renderer: WebpageRenderer;
  readonly inputTranslator: InputQuickTranslator;
  readonly hoverTranslator: HoverTranslator;
  readonly selectionPopover: SelectionPopover;

  private manuallyEnabled = false;
  private mounted = false;
  private hadRuntimeIdAtMount = false;
  private spaFollowUpTimer: ReturnType<typeof setTimeout> | null = null;
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

    this.renderer = new WebpageRenderer({
      config: this.config,
      doc: this.doc,
      getUrl: this.getUrl,
      transport: options.transport,
    });

    this.inputTranslator = new InputQuickTranslator({
      config: this.config,
      doc: this.doc,
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
    return this.renderer.getPageState();
  }

  clearPageCache(): void {
    this.renderer.clearCache();
  }

  shouldAutoTranslateCurrentUrl(): boolean {
    return shouldAutoTranslateUrl(
      this.getUrl(),
      this.config.urlRules,
      this.config.webpage.autoTranslateMatches,
    );
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
      sendResponse(this.renderer.getPageState());
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
          state: this.renderer.getPageState(),
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

    this.inputTranslator.mount();
    this.hoverTranslator.mount();
    this.selectionPopover.mount();

    if (this.shouldAutoTranslateCurrentUrl()) {
      this.renderer.enablePageTranslation();
    }

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
        !this.manuallyEnabled &&
        this.renderer.isPageTranslationActive() &&
        this.isCurrentUrlExcluded()
      ) {
        this.clearSpaFollowUpTimer();
        this.renderer.restorePage();
        return;
      }

      if (
        !this.renderer.isPageTranslationActive() &&
        this.shouldAutoTranslateCurrentUrl()
      ) {
        this.renderer.enablePageTranslation();
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
    this.config = nextConfig;
    this.renderer.updateConfig(nextConfig);
    this.inputTranslator.updateConfig(nextConfig);
    this.hoverTranslator.updateConfig(nextConfig);
    this.selectionPopover.updateConfig(nextConfig);

    if (!this.mounted) return;

    if (this.isExplicitlyDomainExcluded()) {
      this.selectionPopover.close();
      this.inputTranslator.cancelInFlight();
      if (this.renderer.isActive) {
        this.manuallyEnabled = false;
        this.renderer.restorePage();
      }
      return;
    }

    if (
      !this.manuallyEnabled &&
      this.renderer.isActive &&
      this.isCurrentUrlExcluded()
    ) {
      this.renderer.restorePage();
    } else if (!this.renderer.isActive && this.shouldAutoTranslateCurrentUrl()) {
      this.renderer.enablePageTranslation();
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
        const nextState = this.renderer.togglePageTranslation();
        this.manuallyEnabled = nextState;
        return nextState;
      }
      case 'margin:cmd:translate-whole-page': {
        this.manuallyEnabled = true;
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
