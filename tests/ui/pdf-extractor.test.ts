import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { describe, expect, it } from 'vitest';
import { PdfApp } from '../../src/pdf/PdfApp';
import {
  extractParagraphsFromTextItems,
  joinWrappedPdfLines,
} from '../../src/pdf/pdf-extractor';

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
});
