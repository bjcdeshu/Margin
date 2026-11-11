import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { BRAND } from '@shared/brand';
import { SUPPORTED_LANGUAGES, createDefaultMarginConfig } from '@shared/constants';
import {
  requestBatchTranslation,
  requestImageTranslation,
} from '@shared/messaging';
import {
  getMarginConfig,
  onMarginConfigChanged,
  saveMarginConfig,
} from '@shared/storage';
import type {
  MarginConfig,
  UiColorMode,
  VisionBoxRegion,
} from '@shared/types';
import {
  SegmentedControl,
  StatusPill,
  formatLanguageOption,
  shortLabelForColorMode,
  useUiColorMode,
} from '../ui/components';
import {
  canvasToScaledWebpDataUrl,
  extractParagraphsFromTextItems,
  type RawPdfTextItem,
} from './pdf-extractor';

type PdfThemeMode = 'none' | 'mask';

interface PageTranslationState {
  extracted: boolean;
  isLikelyScanned: boolean;
  paragraphs: string[];
  translations: Record<number, string>;
  translatingText: boolean;
  visionLoading: boolean;
  visionRegions?: VisionBoxRegion[];
  visionFallbackText?: string;
  error?: string;
}

let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null;

async function loadPdfJsLazy(): Promise<typeof import('pdfjs-dist')> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist').then((mod) => {
      const workerUrl =
        typeof globalThis.chrome !== 'undefined' &&
        typeof chrome.runtime?.getURL === 'function'
          ? chrome.runtime.getURL('pdf.worker.min.mjs')
          : './pdf.worker.min.mjs';
      mod.GlobalWorkerOptions.workerSrc = workerUrl;
      return mod;
    });
  }
  return pdfjsPromise;
}

interface PdfPageRowProps {
  pageNumber: number;
  totalPages: number;
  pdfDoc: PDFDocumentProxy;
  zoom: number;
  docTitle: string;
  docUrl: string;
  sourceLang: string;
  targetLang: string;
  pdfTheme: PdfThemeMode;
  lang: 'zh-CN' | 'en';
}

function PdfPageRow({
  pageNumber,
  totalPages,
  pdfDoc,
  zoom,
  docTitle,
  docUrl,
  sourceLang,
  targetLang,
  pdfTheme,
  lang,
}: PdfPageRowProps) {
  const rowRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [inView, setInView] = useState(pageNumber <= 2);
  const [state, setState] = useState<PageTranslationState>({
    extracted: false,
    isLikelyScanned: false,
    paragraphs: [],
    translations: {},
    translatingText: false,
    visionLoading: false,
  });

  useEffect(() => {
    const el = rowRef.current;
    if (!el || inView) return;
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin: '800px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [inView]);

  const translateParagraphBatch = useCallback(
    async (paragraphs: string[]) => {
      if (paragraphs.length === 0) return;
      setState((prev) => ({ ...prev, translatingText: true, error: undefined }));

      const chunkSize = 10;
      try {
        for (let offset = 0; offset < paragraphs.length; offset += chunkSize) {
          const slice = paragraphs.slice(offset, offset + chunkSize);
          const response = await requestBatchTranslation({
            requestId: `pdf-p${pageNumber}-${offset}-${Date.now()}`,
            scene: 'pdf',
            fromLang: sourceLang,
            toLang: targetLang,
            items: slice.map((text, idx) => ({ id: offset + idx + 1, text })),
            context: {
              url: docUrl,
              domain: 'pdf.margin.local',
              title: docTitle,
            },
          });

          if (!response.ok) {
            setState((prev) => ({
              ...prev,
              error: response.error?.message || 'PDF batch translation failed',
            }));
            break;
          }

          setState((prev) => {
            const nextMap = { ...prev.translations };
            for (const out of response.items) {
              nextMap[out.id - 1] = out.trans;
            }
            return { ...prev, translations: nextMap };
          });
        }
      } catch (err) {
        setState((prev) => ({
          ...prev,
          error: err instanceof Error ? err.message : String(err),
        }));
      } finally {
        setState((prev) => ({ ...prev, translatingText: false }));
      }
    },
    [pageNumber, sourceLang, targetLang, docUrl, docTitle],
  );

  // Render Canvas & Extract Text once visible
  useEffect(() => {
    if (!inView) return;
    let cancelled = false;

    void (async () => {
      try {
        const page = await pdfDoc.getPage(pageNumber);
        if (cancelled) return;

        const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;
        const viewport = page.getViewport({ scale: zoom });
        const canvas = canvasRef.current;

        if (canvas) {
          canvas.width = Math.floor(viewport.width * dpr);
          canvas.height = Math.floor(viewport.height * dpr);
          canvas.style.width = `${Math.floor(viewport.width)}px`;
          canvas.style.height = `${Math.floor(viewport.height)}px`;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            await page.render({ canvasContext: ctx, viewport }).promise;
          }
        }

        if (!state.extracted && !cancelled) {
          const content = await page.getTextContent();
          if (cancelled) return;
          const extracted = extractParagraphsFromTextItems(
            content.items as unknown as RawPdfTextItem[],
          );
          setState((prev) => ({
            ...prev,
            extracted: true,
            isLikelyScanned: extracted.isLikelyScanned,
            paragraphs: extracted.paragraphs,
          }));

          if (!extracted.isLikelyScanned && extracted.paragraphs.length > 0) {
            void translateParagraphBatch(extracted.paragraphs);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setState((prev) => ({
            ...prev,
            error: err instanceof Error ? err.message : String(err),
          }));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [inView, pdfDoc, pageNumber, zoom]);

  const handleVisionScanTranslate = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    setState((prev) => ({ ...prev, visionLoading: true, error: undefined }));
    try {
      const imageDataUrl = canvasToScaledWebpDataUrl(canvas, 1536, 0.86);
      const res = await requestImageTranslation({
        requestId: `pdf-vision-p${pageNumber}-${Date.now()}`,
        imageDataUrl,
        fromLang: sourceLang,
        toLang: targetLang,
        pageUrl: docUrl,
      });

      if (!res.ok) {
        setState((prev) => ({
          ...prev,
          visionLoading: false,
          error: res.error?.message || 'Vision translation failed',
        }));
        return;
      }

      setState((prev) => ({
        ...prev,
        visionLoading: false,
        visionRegions: res.regions,
        visionFallbackText: res.fallbackFullText,
      }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        visionLoading: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  };

  const transClass =
    pdfTheme === 'mask'
      ? 'mp-pdf-para-trans mp-pdf-para-trans--mask'
      : 'mp-pdf-para-trans';

  return (
    <section ref={rowRef} class="mp-pdf-page-row" data-page-number={pageNumber}>
      <div class="mp-pdf-canvas-pane">
        <canvas ref={canvasRef} class="mp-pdf-canvas" />
      </div>

      <div class="mp-pdf-reading-pane">
        <div class="mp-pdf-page-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <StatusPill tone="mono">
              {lang === 'en'
                ? `Page ${pageNumber} / ${totalPages}`
                : `第 ${pageNumber} / ${totalPages} 页`}
            </StatusPill>
            {state.extracted && state.isLikelyScanned ? (
              <StatusPill tone="accent">
                {lang === 'en' ? 'Scanned / Image Page' : '扫描页 / 图片页'}
              </StatusPill>
            ) : null}
            {state.translatingText ? (
              <StatusPill tone="neutral">
                {lang === 'en' ? 'Translating…' : '正在翻译段落…'}
              </StatusPill>
            ) : null}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            {state.paragraphs.length > 0 ? (
              <button
                type="button"
                class="mp-btn mp-btn--sm"
                disabled={state.translatingText}
                onClick={() => void translateParagraphBatch(state.paragraphs)}
              >
                ↻ {lang === 'en' ? 'Retranslate' : '重译本页'}
              </button>
            ) : null}

            <button
              type="button"
              class={state.isLikelyScanned ? 'mp-btn mp-btn--solid mp-btn--sm' : 'mp-btn mp-btn--sm'}
              disabled={!inView || state.visionLoading}
              onClick={() => void handleVisionScanTranslate()}
            >
              {state.visionLoading
                ? lang === 'en'
                  ? 'Vision OCR & Translating…'
                  : '视觉模型识别翻译中…'
                : lang === 'en'
                  ? 'Translate Scanned Page (Vision)'
                  : '视觉模型翻译扫描页'}
            </button>
          </div>
        </div>

        {state.error ? (
          <div class="mp-editorial-note" style={{ borderLeftColor: 'var(--danger-ink)' }}>
            {state.error}
          </div>
        ) : null}

        {!inView ? (
          <p class="mp-muted" style={{ fontSize: '12.5px' }}>
            {lang === 'en'
              ? 'Scroll closer to render and translate this page…'
              : '滚动至此区域时自动加载并翻译本页…'}
          </p>
        ) : null}

        {state.visionRegions && state.visionRegions.length > 0 ? (
          <div>
            {state.visionRegions.map((reg, idx) => (
              <div key={idx} class="mp-pdf-para">
                {reg.src ? <div class="mp-pdf-para-src">{reg.src}</div> : null}
                <div class={transClass} tabIndex={0}>
                  {reg.trans}
                </div>
              </div>
            ))}
          </div>
        ) : state.visionFallbackText ? (
          <div class="mp-pdf-para">
            <div class={transClass} tabIndex={0} style={{ whiteSpace: 'pre-wrap' }}>
              {state.visionFallbackText}
            </div>
          </div>
        ) : null}

        {state.paragraphs.map((para, idx) => (
          <div key={idx} class="mp-pdf-para">
            <div class="mp-pdf-para-src">{para}</div>
            <div class={transClass} tabIndex={0}>
              {state.translations[idx] ?? (
                <span class="mp-muted" style={{ fontSize: '12.5px' }}>
                  {state.translatingText
                    ? lang === 'en'
                      ? 'Translating…'
                      : '译文生成中…'
                    : '—'}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function PdfApp() {
  const [config, setConfig] = useState<MarginConfig>(() => createDefaultMarginConfig());
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [docTitle, setDocTitle] = useState<string>('');
  const [docUrl, setDocUrl] = useState<string>('local://pdf');
  const [urlInput, setUrlInput] = useState<string>('');
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [zoom, setZoom] = useState(1.15);
  const [pdfTheme, setPdfTheme] = useState<PdfThemeMode>('none');

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useUiColorMode(config.uiColorMode);

  const openPdfFromDataOrUrl = useCallback(
    async (source: { url?: string; data?: ArrayBuffer; name: string }) => {
      setLoadingDoc(true);
      setDocError(null);
      try {
        const pdfjs = await loadPdfJsLazy();
        const task = source.data
          ? pdfjs.getDocument({ data: new Uint8Array(source.data) })
          : pdfjs.getDocument({ url: source.url! });
        const loaded = await task.promise;
        setPdfDoc(loaded);
        setDocTitle(source.name);
        setDocUrl(source.url ?? `file://${encodeURIComponent(source.name)}`);
      } catch (err) {
        setDocError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoadingDoc(false);
      }
    },
    [],
  );

  useEffect(() => {
    let active = true;
    void getMarginConfig().then((loaded) => {
      if (!active) return;
      setConfig(loaded);
      setPdfTheme(loaded.webpage.theme === 'mask' ? 'mask' : 'none');
    });

    const unsub = onMarginConfigChanged((incoming) => {
      if (active) setConfig(incoming);
    });

    // Support ?file=<url>
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const fileUrl = params.get('file');
      if (fileUrl) {
        setUrlInput(fileUrl);
        const guessedName = fileUrl.split('/').pop()?.split('?')[0] || 'Document.pdf';
        void openPdfFromDataOrUrl({ url: fileUrl, name: guessedName });
      }
    }

    return () => {
      active = false;
      unsub();
    };
  }, [openPdfFromDataOrUrl]);

  const handleLocalFile = async (file?: File) => {
    if (!file) return;
    const buf = await file.arrayBuffer();
    await openPdfFromDataOrUrl({ data: buf, name: file.name });
  };

  const lang = config.interfaceLang;
  const targetLangOptions = SUPPORTED_LANGUAGES.filter((l) => l.code !== 'auto');

  const pageNumbers = pdfDoc
    ? Array.from({ length: pdfDoc.numPages }, (_, idx) => idx + 1)
    : [];

  return (
    <div
      class="mp-pdf-shell"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer?.files?.[0];
        if (file) void handleLocalFile(file);
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,application/pdf"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = (e.currentTarget as HTMLInputElement).files?.[0];
          if (file) void handleLocalFile(file);
        }}
      />

      <header class="mp-pdf-topbar">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '12px', flexWrap: 'wrap' }}>
          <span class="mp-wordmark" style={{ fontSize: '22px' }}>
            {BRAND.name} · PDF
          </span>
          {pdfDoc ? (
            <StatusPill tone="mono">
              {docTitle} · {pdfDoc.numPages} {lang === 'en' ? 'pages' : '页'}
            </StatusPill>
          ) : (
            <span class="mp-muted" style={{ fontSize: '12.5px' }}>
              {lang === 'en'
                ? 'Two-Column Quiet Paper Bilingual Reader'
                : '双栏纸面双语 PDF 阅读器（无页数限制）'}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          {pdfDoc ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <button
                type="button"
                class="mp-btn mp-btn--sm"
                onClick={() => setZoom((z) => Math.max(0.65, Math.round((z - 0.15) * 100) / 100))}
              >
                −
              </button>
              <StatusPill tone="mono">{Math.round(zoom * 100)}%</StatusPill>
              <button
                type="button"
                class="mp-btn mp-btn--sm"
                onClick={() => setZoom((z) => Math.min(2.4, Math.round((z + 0.15) * 100) / 100))}
              >
                +
              </button>
            </div>
          ) : null}

          <SegmentedControl
            ariaLabel={lang === 'en' ? 'PDF Translation Theme' : 'PDF 译文样式'}
            options={[
              { value: 'none', label: lang === 'en' ? 'Clean' : '无样式' },
              { value: 'mask', label: lang === 'en' ? 'Blur Mask' : '模糊遮罩 Mask' },
            ]}
            value={pdfTheme}
            onChange={(next: PdfThemeMode) => setPdfTheme(next)}
          />

          <select
            class="mp-select"
            aria-label={lang === 'en' ? 'Target Language' : '目标语言'}
            value={config.targetLang}
            onChange={(e) => {
              const nextLang = (e.currentTarget as HTMLSelectElement).value;
              const updated = structuredClone(config);
              updated.targetLang = nextLang;
              setConfig(updated);
              void saveMarginConfig(updated);
            }}
          >
            {targetLangOptions.map((entry) => (
              <option key={entry.code} value={entry.code}>
                {formatLanguageOption(entry.code, lang)}
              </option>
            ))}
          </select>

          <SegmentedControl
            ariaLabel={lang === 'en' ? 'Color Theme' : '界面主题'}
            options={[
              { value: 'paper', label: shortLabelForColorMode('paper', lang) },
              { value: 'night', label: shortLabelForColorMode('night', lang) },
              { value: 'system', label: shortLabelForColorMode('system', lang) },
            ]}
            value={config.uiColorMode}
            onChange={(mode: UiColorMode) => {
              const updated = structuredClone(config);
              updated.uiColorMode = mode;
              setConfig(updated);
              void saveMarginConfig(updated);
            }}
          />

          <button
            type="button"
            class="mp-btn mp-btn--solid"
            onClick={() => fileInputRef.current?.click()}
          >
            {lang === 'en' ? 'Open Local PDF…' : '选择本地 PDF…'}
          </button>
        </div>
      </header>

      {docError ? (
        <div style={{ maxWidth: '720px', margin: '18px auto 0', width: '100%', padding: '0 24px' }}>
          <div class="mp-editorial-note" style={{ borderLeftColor: 'var(--danger-ink)' }}>
            {docError}
          </div>
        </div>
      ) : null}

      {!pdfDoc ? (
        <div class="mp-pdf-dropzone-wrap">
          <div
            class={
              dragging
                ? 'mp-pdf-dropzone mp-pdf-dropzone--dragging'
                : 'mp-pdf-dropzone'
            }
          >
            <h1 class="mp-serif-heading" style={{ fontSize: '26px' }}>
              {lang === 'en'
                ? 'Drop a PDF here to read bilingually'
                : '拖入 PDF 文档，开启左右双栏双语精读'}
            </h1>
            <p class="mp-muted" style={{ margin: 0, maxWidth: '460px', fontSize: '13.5px' }}>
              {lang === 'en'
                ? 'Zero page-count cap. Text pages stream paragraph-by-paragraph with hyphenation repair and inline formula protection; scanned pages translate in 1 click via Vision-LLM.'
                : '无页数上限；原生文本页自动合并跨行连字符并保护行内公式，扫描件与图表页支持一键调用多模态视觉模型翻译。'}
            </p>

            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', justifyContent: 'center', marginTop: '6px' }}>
              <button
                type="button"
                class="mp-btn mp-btn--solid"
                disabled={loadingDoc}
                onClick={() => fileInputRef.current?.click()}
              >
                {loadingDoc
                  ? lang === 'en'
                    ? 'Loading PDF…'
                    : '正在打开 PDF…'
                  : lang === 'en'
                    ? 'Choose Local .pdf File'
                    : '选择本地 .pdf 文件'}
              </button>
            </div>

            <div style={{ display: 'flex', gap: '8px', width: '100%', maxWidth: '460px', marginTop: '8px' }}>
              <input
                type="url"
                class="mp-input mp-input--mono"
                style={{ flex: 1 }}
                placeholder="https://arxiv.org/pdf/....pdf"
                value={urlInput}
                onInput={(e) => setUrlInput((e.currentTarget as HTMLInputElement).value)}
              />
              <button
                type="button"
                class="mp-btn"
                disabled={!urlInput.trim() || loadingDoc}
                onClick={() => {
                  const trimmed = urlInput.trim();
                  if (!trimmed) return;
                  const name = trimmed.split('/').pop()?.split('?')[0] || 'Remote.pdf';
                  void openPdfFromDataOrUrl({ url: trimmed, name });
                }}
              >
                {lang === 'en' ? 'Open URL' : '打开链接'}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <main class="mp-pdf-stream">
          {pageNumbers.map((pageNumber) => (
            <PdfPageRow
              key={`${docTitle}-${pageNumber}`}
              pageNumber={pageNumber}
              totalPages={pdfDoc.numPages}
              pdfDoc={pdfDoc}
              zoom={zoom}
              docTitle={docTitle}
              docUrl={docUrl}
              sourceLang={config.sourceLang}
              targetLang={config.targetLang}
              pdfTheme={pdfTheme}
              lang={lang}
            />
          ))}
        </main>
      )}
    </div>
  );
}
