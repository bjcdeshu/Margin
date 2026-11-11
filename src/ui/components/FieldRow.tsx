import type { ComponentChildren } from 'preact';

export interface FieldRowProps {
  label: ComponentChildren;
  hint?: ComponentChildren;
  badge?: ComponentChildren;
  stacked?: boolean;
  children: ComponentChildren;
}

export function FieldRow({
  label,
  hint,
  badge,
  stacked = false,
  children,
}: FieldRowProps) {
  return (
    <div class={stacked ? 'mp-field-row mp-field-row--stacked' : 'mp-field-row'}>
      <div class="mp-field-meta">
        <div class="mp-field-label-line">
          <span class="mp-field-label">{label}</span>
          {badge}
        </div>
        {hint ? <div class="mp-field-hint">{hint}</div> : null}
      </div>
      <div class="mp-field-control">{children}</div>
    </div>
  );
}
