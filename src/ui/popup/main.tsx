import { render } from 'preact';
import '@shared/tokens.css';
import '../components/paper.css';
import { PopupApp } from './PopupApp';

const mount = document.getElementById('app');
if (mount) {
  render(<PopupApp />, mount);
}
