/**
 * Ironclad Shadow DOM CSS reset + Quiet Paper / Unbow Warm Editorial design tokens.
 *
 * Enforces `:host { all: initial !important; font-size: 16px !important; }` and explicit
 * `px` sizing so host-page `html { font-size }` (rem scaling) or aggressive CSS rules
 * never distort Margin's in-page widgets (selection popover, hover card, input pill, image overlay).
 */
export const SHADOW_HOST_RESET_CSS = /* css */ `
:host {
  all: initial !important;
  font-size: 16px !important;
  line-height: 1.5 !important;
  font-family: "Segoe UI Variable", "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", ui-sans-serif, system-ui, sans-serif !important;
  color-scheme: light dark;
  --paper: #fbfaf6;
  --paper-soft: #f2eee4;
  --paper-warm: #f7f0e4;
  --ink: #20211f;
  --ink-soft: rgba(32, 33, 31, 0.86);
  --muted: #67635a;
  --muted-soft: #8d877a;
  --rule: rgba(199, 188, 167, 0.34);
  --rule-soft: rgba(199, 188, 167, 0.18);
  --rule-strong: rgba(140, 90, 33, 0.34);
  --accent: #b9833d;
  --accent-soft: #ecddb9;
  --link: #8c5a21;
  --link-hover: #6f4417;
  --action-solid: #8c5a21;
  --action-solid-hover: #6f4417;
  --action-solid-ink: #fbfaf6;
  --control-border: #b9833d;
  --focus-ring: #8c5a21;
  --state-hover-surface: rgba(140, 90, 33, 0.06);
  --state-pressed-surface: rgba(140, 90, 33, 0.11);
  --radius-frame: 5px;
  --radius-control: 4px;
  --radius-modal: 8px;
  --motion-fast: 160ms;
  --motion-standard: 220ms;
  --ease-standard: cubic-bezier(0.2, 0.72, 0.2, 1);
}

:host([data-display-mode="night"]) {
  --paper: #151411;
  --paper-soft: #211f1a;
  --paper-warm: #242119;
  --ink: #ece4d2;
  --ink-soft: rgba(236, 228, 210, 0.86);
  --muted: #aaa18d;
  --muted-soft: #817764;
  --rule: rgba(135, 116, 83, 0.26);
  --rule-soft: rgba(135, 116, 83, 0.14);
  --rule-strong: rgba(201, 148, 85, 0.3);
  --accent: #c99455;
  --accent-soft: #453725;
  --link: #ddb16f;
  --link-hover: #f0c98f;
  --action-solid: #c99455;
  --action-solid-hover: #ddb16f;
  --action-solid-ink: #151411;
  --control-border: #817764;
  --focus-ring: #ddb16f;
  --state-hover-surface: rgba(221, 177, 111, 0.08);
  --state-pressed-surface: rgba(221, 177, 111, 0.14);
}

@media (prefers-color-scheme: dark) {
  :host([data-display-mode="system"]) {
    --paper: #151411;
    --paper-soft: #211f1a;
    --paper-warm: #242119;
    --ink: #ece4d2;
    --ink-soft: rgba(236, 228, 210, 0.86);
    --muted: #aaa18d;
    --muted-soft: #817764;
    --rule: rgba(135, 116, 83, 0.26);
    --rule-soft: rgba(135, 116, 83, 0.14);
    --rule-strong: rgba(201, 148, 85, 0.3);
    --accent: #c99455;
    --accent-soft: #453725;
    --link: #ddb16f;
    --link-hover: #f0c98f;
    --action-solid: #c99455;
    --action-solid-hover: #ddb16f;
    --action-solid-ink: #151411;
    --control-border: #817764;
    --focus-ring: #ddb16f;
    --state-hover-surface: rgba(221, 177, 111, 0.08);
    --state-pressed-surface: rgba(221, 177, 111, 0.14);
  }
}

*, *::before, *::after {
  box-sizing: border-box;
}
`;
