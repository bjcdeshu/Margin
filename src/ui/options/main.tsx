import { render } from 'preact';
import '@shared/tokens.css';
import '../components/paper.css';
import '../components/paper-tabs.css';
import { OptionsApp } from './OptionsApp';

const mount = document.getElementById('app');
if (mount) {
  render(<OptionsApp />, mount);
}
