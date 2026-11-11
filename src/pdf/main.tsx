import { render } from 'preact';
import { BRAND } from '@shared/brand';

// Wave 0 entry stub — owned & implemented in full by Wave 1 `ui-pdf-vision`.
function PdfReaderRoot() {
  return (
    <main style={{ padding: '24px' }}>
      <h1 style={{ fontFamily: 'var(--font-serif)', margin: 0, fontSize: '24px' }}>
        {BRAND.name} · PDF Reader
      </h1>
    </main>
  );
}

const mount = document.getElementById('app');
if (mount) {
  render(<PdfReaderRoot />, mount);
}
