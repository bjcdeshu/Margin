import { render } from 'preact';
import { BRAND } from '@shared/brand';

// Wave 0 entry stub — owned & implemented in full by Wave 1 `ui-pdf-vision`.
function PopupRoot() {
  return (
    <main style={{ padding: '16px', minWidth: '300px' }}>
      <h1 style={{ fontFamily: 'var(--font-serif)', margin: 0, fontSize: '20px' }}>
        {BRAND.name}
      </h1>
    </main>
  );
}

const mount = document.getElementById('app');
if (mount) {
  render(<PopupRoot />, mount);
}
