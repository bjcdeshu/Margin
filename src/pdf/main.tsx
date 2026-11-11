import { render } from 'preact';
import '@shared/tokens.css';
import '../ui/components/paper.css';
import './pdf.css';
import { PdfApp } from './PdfApp';

const mount = document.getElementById('app');
if (mount) {
  render(<PdfApp />, mount);
}
