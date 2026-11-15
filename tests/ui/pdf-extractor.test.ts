import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { resetMemoryStorageForTests } from '@shared/storage';
import { PdfApp, validateRemotePdfUrl } from '../../src/pdf/PdfApp';
import {
  extractParagraphsFromTextItems,
  joinWrappedPdfLines,
} from '../../src/pdf/pdf-extractor';

const mockGetDocument = vi.fn();
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: (...args: unknown[]) => mockGetDocument(...args),
}));

describe('PDF Paragraph Extractor & Quiet Paper PDF Studio', () => {
  it('joins soft ASCII line-wrap hyphens while preserving compound capitalized/numeric hyphens', () => {
    expect(joinWrappedPdfLines('We propose a novel trans-', 'former architecture.')).toBe(
      'We propose a novel transformer architecture.',
    );
    expect(joinWrappedPdfLines('Encoded in UTF-', '8 format')).toBe(
      'Encoded in UTF-8 format',
    );
    expect(joinWrappedPdfLines('Multi-Head Self-', 'Attention layer')).toBe(
      'Multi-Head Self-Attention layer',
    );
  });

  it('groups wrapped PDF lines into paragraphs, preserves inline formulas, and detects scanned pages', () => {
    const textPage = extractParagraphsFromTextItems([
      { str: 'Attention mechanisms compute ', transform: [1, 0, 0, 12, 72, 700], height: 12 },
      { str: '∑ α_i v_i = Softmax(QK^T)V ', transform: [1, 0, 0, 12, 230, 700], height: 12, hasEOL: true },
      { str: 'across sequence representation-', transform: [1, 0, 0, 12, 72, 684], height: 12, hasEOL: true },
      { str: 's without recurrence.', transform: [1, 0, 0, 12, 72, 668], height: 12, hasEOL: true },
      // Large vertical jump -> second paragraph
      { str: '2. Experimental Setup', transform: [1, 0, 0, 16, 72, 620], height: 16, hasEOL: true },
    ]);

    expect(textPage.isLikelyScanned).toBe(false);
    expect(textPage.paragraphs).toHaveLength(2);
    expect(textPage.paragraphs[0]).toContain('∑ α_i v_i = Softmax(QK^T)V');
    expect(textPage.paragraphs[0]).toContain('representations without recurrence.');
    expect(textPage.paragraphs[1]).toBe('2. Experimental Setup');

    const scannedPage = extractParagraphsFromTextItems([
      { str: '12', transform: [1, 0, 0, 10, 300, 40], height: 10 },
    ]);
    expect(scannedPage.isLikelyScanned).toBe(true);
  });

  it('separates 13pt numbered academic section headings from 11pt body paragraphs', () => {
    const academicPage = extractParagraphsFromTextItems([
      {
        str: '1. Editorial Typography and Cognitive Calm',
        transform: [1, 0, 0, 13, 72, 720],
        height: 13,
        hasEOL: true,
      },
      {
        str: 'Warm paper surfaces with subtle contrast reduce visual fatigue across long',
        transform: [1, 0, 0, 11, 72, 700],
        height: 11,
        hasEOL: true,
      },
      {
        str: 'technical papers and bilingual reading sessions.',
        transform: [1, 0, 0, 11, 72, 685],
        height: 11,
        hasEOL: true,
      },
    ]);

    expect(academicPage.paragraphs).toEqual([
      '1. Editorial Typography and Cognitive Calm',
      'Warm paper surfaces with subtle contrast reduce visual fatigue across long technical papers and bilingual reading sessions.',
    ]);
  });

  it('renders Quiet Paper PDF Reader dropzone, mask toggle, and local/URL controls without loading pdfjs eagerly', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => {
      render(h(PdfApp, null), container);
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Margin · PDF');
    expect(container.textContent).toContain('拖入 PDF 文档');
    expect(container.textContent).toContain('模糊遮罩 Mask');
    expect(container.textContent).toContain('选择本地 .pdf 文件');

    render(null, container);
    container.remove();
  });

  it('orders two-column academic PDF regions left-column then right-column across horizontal gutters while keeping full-width spanning headers and footers', () => {
    const twoColumnPage = extractParagraphsFromTextItems([
      // Spanning title/header band at top
      {
        str: 'Speculative Decoding Across Two-Column Research Layouts: A Comprehensive Study',
        transform: [1, 0, 0, 14, 72, 750],
        width: 448,
        height: 14,
      },
      // Interleaved left (x=72..268) and right (x=312..508) column tokens WITHOUT hasEOL on matching Y baselines
      {
        str: 'Left column first line introduces',
        transform: [1, 0, 0, 10, 72, 680],
        width: 196,
        height: 10,
      },
      {
        str: 'Right column first line discusses',
        transform: [1, 0, 0, 10, 312, 680],
        width: 196,
        height: 10,
      },
      {
        str: 'parallel draft verification steps',
        transform: [1, 0, 0, 10, 72, 666],
        width: 196,
        height: 10,
      },
      {
        str: 'empirical latency benchmarks on',
        transform: [1, 0, 0, 10, 312, 666],
        width: 196,
        height: 10,
      },
      {
        str: 'for autoregressive transformers.',
        transform: [1, 0, 0, 10, 72, 652],
        width: 185,
        height: 10,
      },
      {
        str: 'long-context reasoning workloads.',
        transform: [1, 0, 0, 10, 312, 652],
        width: 192,
        height: 10,
      },
      // Spanning figure caption at bottom
      {
        str: 'Figure 1: Throughput scaling across single-column and multi-column PDF benchmarks.',
        transform: [1, 0, 0, 10, 72, 580],
        width: 448,
        height: 10,
      },
    ]);

    expect(twoColumnPage.isLikelyScanned).toBe(false);
    expect(twoColumnPage.paragraphs).toEqual([
      'Speculative Decoding Across Two-Column Research Layouts: A Comprehensive Study',
      'Left column first line introduces parallel draft verification steps for autoregressive transformers.',
      'Right column first line discusses empirical latency benchmarks on long-context reasoning workloads.',
      'Figure 1: Throughput scaling across single-column and multi-column PDF benchmarks.',
    ]);
  });

  it('hardens pdf.html privilege boundary, destroys prior PDFDocumentProxy & remounts same-filename opens, cancels rapid-zoom renders, and re-translates on targetLang change', async () => {
    resetMemoryStorageForTests();
    mockGetDocument.mockReset();

    // 1. manifest.json MUST NOT expose pdf.html in web_accessible_resources
    const manifestPath = resolve(process.cwd(), 'public/manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      web_accessible_resources?: Array<{ resources?: string[] }>;
    };
    const exposedResources = (manifest.web_accessible_resources ?? []).flatMap(
      (entry) => entry.resources ?? [],
    );
    expect(exposedResources).not.toContain('pdf.html');

    // 2. validateRemotePdfUrl strictly allows http:/https: only
    expect(validateRemotePdfUrl('https://arxiv.org/pdf/2501.00001.pdf')).toBe(
      'https://arxiv.org/pdf/2501.00001.pdf',
    );
    expect(validateRemotePdfUrl('http://example.com/paper.pdf')).toBe(
      'http://example.com/paper.pdf',
    );
    expect(validateRemotePdfUrl('file:///etc/passwd')).toBeNull();
    expect(validateRemotePdfUrl('javascript:alert(1)')).toBeNull();
    expect(validateRemotePdfUrl('data:application/pdf;base64,JVBERi0=')).toBeNull();
    expect(validateRemotePdfUrl('chrome-extension://abc/secret.pdf')).toBeNull();

    // 3. Framed ?file= auto-load MUST be blocked when window.top !== window.self
    const origLocationSearch = window.location.search;
    window.history.replaceState(
      {},
      '',
      '/?file=https%3A%2F%2Farxiv.org%2Fpdf%2F2501.00001.pdf',
    );
    const topSpy = vi
      .spyOn(window, 'top', 'get')
      .mockReturnValue({} as unknown as Window);

    const framedContainer = document.createElement('div');
    document.body.appendChild(framedContainer);
    await act(async () => {
      render(h(PdfApp, null), framedContainer);
      await Promise.resolve();
    });
    expect(mockGetDocument).not.toHaveBeenCalled();
    render(null, framedContainer);
    framedContainer.remove();
    topSpy.mockRestore();
    window.history.replaceState({}, '', origLocationSearch || '/');

    // 4. Lifecycle: docLoadId remounts same-filename PDFs, prevDoc.destroy() runs, zoom cancels prior renderTask, and targetLang switch re-translates!
    const origChrome = (globalThis as Record<string, unknown>).chrome;
    const batchCalls: Array<{ toLang: string; texts: string[] }> = [];
    (globalThis as Record<string, unknown>).chrome = {
      runtime: {
        sendMessage: vi.fn(
          async (msg: {
            type: string;
            payload?: { toLang: string; items: Array<{ id: number; text: string }> };
          }) => {
            if (msg.type === 'margin:translate-batch' && msg.payload) {
              const { toLang, items } = msg.payload;
              batchCalls.push({
                toLang,
                texts: items.map((i) => i.text),
              });
              return {
                ok: true,
                requestId: 'pdf-req',
                providerId: 'google-free',
                model: 'gtx',
                items: items.map((it) => ({
                  id: it.id,
                  trans: `[${toLang}] ${it.text}`,
                })),
              };
            }
            return { ok: true };
          },
        ),
      },
    };

    const ctxSpy = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({
        setTransform: vi.fn(),
      } as unknown as CanvasRenderingContext2D);

    const cancelSpies: Array<ReturnType<typeof vi.fn>> = [];
    const makeFakePdfDoc = (paragraphText: string) => {
      const destroySpy = vi.fn(async () => {});
      let firstRenderHold = true;
      const doc = {
        numPages: 1,
        destroy: destroySpy,
        getPage: vi.fn(async () => ({
          getViewport: ({ scale }: { scale: number }) => ({
            width: 600 * scale,
            height: 800 * scale,
          }),
          render: () => {
            const cancel = vi.fn();
            cancelSpies.push(cancel);
            if (firstRenderHold) {
              firstRenderHold = false;
              let rejectRender!: (err: unknown) => void;
              const promise = new Promise<void>((_res, rej) => {
                rejectRender = rej;
              });
              return {
                cancel: () => {
                  cancel();
                  const cancelErr = new Error('Rendering cancelled');
                  cancelErr.name = 'RenderingCancelledException';
                  rejectRender(cancelErr);
                },
                promise,
              };
            }
            return { cancel, promise: Promise.resolve() };
          },
          getTextContent: async () => ({
            items: [
              {
                str: paragraphText,
                transform: [1, 0, 0, 12, 72, 700],
                width: 380,
                height: 12,
                hasEOL: true,
              },
            ],
          }),
        })),
      };
      return { doc, destroySpy };
    };

    const pdf1 = makeFakePdfDoc(
      'First paper abstract describing transformer attention scaling laws.',
    );
    const pdf2 = makeFakePdfDoc(
      'Second distinct paper opened under the identical filename paper.pdf.',
    );
    mockGetDocument
      .mockReturnValueOnce({ promise: Promise.resolve(pdf1.doc), destroy: vi.fn() })
      .mockReturnValueOnce({ promise: Promise.resolve(pdf2.doc), destroy: vi.fn() });

    const flushPdfEffects = async () => {
      for (let i = 0; i < 5; i++) {
        await act(async () => {
          await new Promise((r) => setTimeout(r, 10));
        });
      }
    };

    const makePdfFile = (bytes: number[], name: string): File => {
      const u8 = new Uint8Array(bytes);
      const f = new File([u8], name, { type: 'application/pdf' });
      if (typeof f.arrayBuffer !== 'function') {
        Object.defineProperty(f, 'arrayBuffer', {
          value: async () => u8.buffer.slice(0),
        });
      }
      return f;
    };

    const container = document.createElement('div');
    document.body.appendChild(container);

    try {
      await act(async () => {
        render(h(PdfApp, null), container);
        await Promise.resolve();
      });

      const fileInput = container.querySelector(
        'input[type="file"]',
      ) as HTMLInputElement;
      const fileA = makePdfFile([37, 80, 68, 70], 'paper.pdf');
      Object.defineProperty(fileInput, 'files', {
        configurable: true,
        value: [fileA],
      });
      await act(async () => {
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await flushPdfEffects();

      expect(container.textContent).toContain(
        '[zh-CN] First paper abstract describing transformer attention scaling laws.',
      );

      // Rapid zoom `+` cancels the in-flight canvas renderTask cleanly without setting state.error!
      const zoomInBtn = Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === '+',
      ) as HTMLButtonElement;
      await act(async () => {
        zoomInBtn.click();
      });
      await flushPdfEffects();
      expect(cancelSpies[0]).toHaveBeenCalledTimes(1);
      expect(container.querySelector('.mp-editorial-note')).toBeNull();

      // Switch targetLang in topbar -> re-translates already-extracted page 1 automatically!
      const langSelect = container.querySelector(
        'select.mp-select',
      ) as HTMLSelectElement;
      await act(async () => {
        langSelect.value = 'ja';
        langSelect.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await flushPdfEffects();
      expect(batchCalls.some((c) => c.toLang === 'ja')).toBe(true);
      expect(container.textContent).toContain(
        '[ja] First paper abstract describing transformer attention scaling laws.',
      );

      // Open a SECOND different file with the SAME filename `paper.pdf` -> destroys pdf1 and replaces row state!
      const fileB = makePdfFile([37, 80, 68, 70, 50], 'paper.pdf');
      Object.defineProperty(fileInput, 'files', {
        configurable: true,
        value: [fileB],
      });
      await act(async () => {
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await flushPdfEffects();

      expect(pdf1.destroySpy).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain(
        '[ja] Second distinct paper opened under the identical filename paper.pdf.',
      );
      expect(container.textContent).not.toContain(
        'First paper abstract describing transformer attention scaling laws.',
      );
    } finally {
      render(null, container);
      container.remove();
      ctxSpy.mockRestore();
      (globalThis as Record<string, unknown>).chrome = origChrome;
    }
  });
});
