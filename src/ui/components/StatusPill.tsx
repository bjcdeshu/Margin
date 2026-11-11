import type { ComponentChildren } from 'preact';

export type StatusPillTone = 'neutral' | 'accent' | 'ok' | 'danger' | 'mono';

export interface StatusPillProps {
  tone?: StatusPillTone;
  title?: string;
  dataTestId?: string;
  children: ComponentChildren;
}

export function StatusPill({
  tone = 'neutral',
  title,
  dataTestId,
  children,
}: StatusPillProps) {
  const toneClass =
    tone === 'neutral'
      ? 'mp-pill'
      : tone === 'mono'
        ? 'mp-pill mp-pill--mono'
        : `mp-pill mp-pill--${tone}`;

  return (
    <span class={toneClass} title={title} data-testid={dataTestId}>
      {children}
    </span>
  );
}
