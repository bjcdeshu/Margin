import type { ComponentChildren, JSX } from 'preact';

/* --------------------------------------------------------------------------
 * Crisp 16px stroke micro-icons (1.4px hairline, round caps).
 * Purely decorative: always aria-hidden, never contribute textContent.
 * ------------------------------------------------------------------------ */

export type IconName =
  | 'sun'
  | 'moon'
  | 'auto'
  | 'gear'
  | 'globe'
  | 'arrow-up-right'
  | 'chevron-right'
  | 'chevron-down'
  | 'languages'
  | 'columns'
  | 'type'
  | 'cursor'
  | 'pointer'
  | 'file'
  | 'bolt'
  | 'restore'
  | 'check'
  | 'x'
  | 'plus'
  | 'search'
  | 'key'
  | 'database'
  | 'cpu'
  | 'sparkle'
  | 'book'
  | 'shield'
  | 'link'
  | 'eye'
  | 'refresh'
  | 'trash'
  | 'download'
  | 'upload'
  | 'film'
  | 'route'
  | 'layers'
  | 'pulse'
  | 'lock';

const ICON_PATHS: Record<IconName, JSX.Element> = {
  sun: (
    <>
      <circle cx="8" cy="8" r="2.9" />
      <path d="M8 1.6v1.3M8 13.1v1.3M1.6 8h1.3M13.1 8h1.3M3.5 3.5l.9.9M11.6 11.6l.9.9M3.5 12.5l.9-.9M11.6 4.4l.9-.9" />
    </>
  ),
  moon: <path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8Z" />,
  auto: (
    <>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M8 2.4v11.2A5.6 5.6 0 0 0 8 2.4Z" fill="currentColor" stroke="none" />
    </>
  ),
  gear: (
    <>
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 1.8l1 1.5 1.8-.4.5 1.8 1.7.7-.6 1.7 1 1.4-1.4 1 .3 1.8-1.8.3-.8 1.6L8 12.9l-1.7.8-.8-1.6-1.8-.3.3-1.8-1.4-1 1-1.4-.6-1.7 1.7-.7.5-1.8 1.8.4Z" />
    </>
  ),
  globe: (
    <>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M2.2 8h11.6M8 2.2c1.6 1.6 2.4 3.5 2.4 5.8S9.6 12.2 8 13.8M8 2.2C6.4 3.8 5.6 5.7 5.6 8s.8 4.2 2.4 5.8" />
    </>
  ),
  'arrow-up-right': <path d="M5 11l6-6M6 5h5v5" />,
  'chevron-right': <path d="M6.5 4l4 4-4 4" />,
  'chevron-down': <path d="M4 6.5l4 4 4-4" />,
  languages: (
    <>
      <path d="M2 3.5h6.5M5.2 2v1.5M3.3 3.5c.6 2.4 2.1 4.1 4.2 5M7.2 3.5c-.5 2.6-2.2 4.6-4.7 5.6" />
      <path d="M8.6 14l2.6-6.2L13.8 14M9.5 12h3.4" />
    </>
  ),
  columns: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.6" />
      <path d="M8 3v10M4.2 6h2M4.2 8.4h2M9.8 6h2M9.8 8.4h2" />
    </>
  ),
  type: <path d="M3 4V3h10v1M8 3v10M6.2 13h3.6" />,
  cursor: <path d="M5 2.5h2M5 13.5h2M6 2.5v11M10 5.5l3 2.5-3 2.5" />,
  pointer: <path d="M4 2.5l8.5 5-3.6.9-1.7 3.4L4 2.5Z" />,
  file: (
    <>
      <path d="M4 1.8h5.2L12.4 5v9.2H4Z" />
      <path d="M9 1.8V5.2h3.4M6 8.6h4.4M6 11h3" />
    </>
  ),
  bolt: <path d="M8.8 1.8L3.6 9h4l-.6 5.2L12.4 7h-4Z" />,
  restore: (
    <>
      <path d="M3 3.2v3.2h3.2" />
      <path d="M3.4 6.2A5.2 5.2 0 1 1 3.2 9.6" />
    </>
  ),
  check: <path d="M3.4 8.4l2.9 2.8 6.3-6.4" />,
  x: <path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" />,
  plus: <path d="M8 3.2v9.6M3.2 8h9.6" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4.4" />
      <path d="M10.3 10.3L13.6 13.6" />
    </>
  ),
  key: (
    <>
      <circle cx="5.4" cy="10.6" r="2.8" />
      <path d="M7.4 8.6l5.4-5.4M10.8 5.2l1.6 1.6M9.4 6.6l1.2 1.2" />
    </>
  ),
  database: (
    <>
      <ellipse cx="8" cy="3.8" rx="5" ry="1.9" />
      <path d="M3 3.8v8.4c0 1 2.2 1.9 5 1.9s5-.9 5-1.9V3.8M3 8c0 1 2.2 1.9 5 1.9S13 9 13 8" />
    </>
  ),
  cpu: (
    <>
      <rect x="4" y="4" width="8" height="8" rx="1.4" />
      <path d="M6.4 1.8V4M9.6 1.8V4M6.4 12v2.2M9.6 12v2.2M1.8 6.4H4M1.8 9.6H4M12 6.4h2.2M12 9.6h2.2" />
    </>
  ),
  sparkle: (
    <path d="M8 1.8c.4 2.9 1.3 3.8 4.2 4.2-2.9.4-3.8 1.3-4.2 4.2-.4-2.9-1.3-3.8-4.2-4.2 2.9-.4 3.8-1.3 4.2-4.2ZM12.4 10.4c.2 1.2.6 1.6 1.8 1.8-1.2.2-1.6.6-1.8 1.8-.2-1.2-.6-1.6-1.8-1.8 1.2-.2 1.6-.6 1.8-1.8Z" />
  ),
  book: (
    <>
      <path d="M2.4 3.2c1.9-.6 3.9-.4 5.6.8v9.6c-1.7-1.2-3.7-1.4-5.6-.8Z" />
      <path d="M13.6 3.2c-1.9-.6-3.9-.4-5.6.8v9.6c1.7-1.2 3.7-1.4 5.6-.8Z" />
    </>
  ),
  shield: (
    <>
      <path d="M8 1.8l5 1.9v4c0 3.1-2.1 5.5-5 6.5-2.9-1-5-3.4-5-6.5v-4Z" />
      <path d="M5.8 8l1.6 1.6 2.9-3" />
    </>
  ),
  link: (
    <path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.8.8M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.3 9a2.6 2.6 0 0 0 3.7 3.7l.8-.8" />
  ),
  eye: (
    <>
      <path d="M1.6 8s2.3-4.6 6.4-4.6S14.4 8 14.4 8s-2.3 4.6-6.4 4.6S1.6 8 1.6 8Z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  refresh: (
    <>
      <path d="M13 3.2v3.2H9.8" />
      <path d="M12.6 6.2A5.2 5.2 0 1 0 12.8 9.6" />
    </>
  ),
  trash: (
    <>
      <path d="M2.8 4.2h10.4M6.2 4.2V2.6h3.6v1.6M4.2 4.2l.6 9.2h6.4l.6-9.2" />
      <path d="M6.8 6.8v4.2M9.2 6.8v4.2" />
    </>
  ),
  download: <path d="M8 2.4v8M4.8 7.4L8 10.6l3.2-3.2M2.8 13.4h10.4" />,
  upload: <path d="M8 10.6v-8M4.8 5.6L8 2.4l3.2 3.2M2.8 13.4h10.4" />,
  film: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.6" />
      <path d="M2 10.4h12M5 13v-2.6M8 13v-2.6M11 13v-2.6M6.6 5.4v3l2.6-1.5Z" />
    </>
  ),
  route: (
    <>
      <circle cx="4" cy="12" r="1.6" />
      <circle cx="12" cy="4" r="1.6" />
      <path d="M5.6 12h3.6a2.4 2.4 0 0 0 0-4.8H6.8a2.4 2.4 0 0 1 0-4.8h3.6" />
    </>
  ),
  layers: (
    <>
      <path d="M8 2.2l6 3.2-6 3.2-6-3.2Z" />
      <path d="M2 8.4l6 3.2 6-3.2M2 11.2l6 3.2 6-3.2" />
    </>
  ),
  pulse: <path d="M1.8 8h2.8l1.6-3.6 3 7.2 1.6-3.6h3.4" />,
  lock: (
    <>
      <rect x="3.2" y="7" width="9.6" height="7" rx="1.6" />
      <path d="M5.4 7V5a2.6 2.6 0 0 1 5.2 0v2" />
    </>
  ),
};

export interface IconProps {
  name: IconName;
  size?: number;
  class?: string;
  strokeWidth?: number;
}

export function Icon({ name, size, class: extraClass, strokeWidth = 1.4 }: IconProps) {
  return (
    <svg
      class={extraClass ? `mp-icon ${extraClass}` : 'mp-icon'}
      viewBox="0 0 16 16"
      width={size ?? 14}
      height={size ?? 14}
      fill="none"
      stroke="currentColor"
      stroke-width={strokeWidth}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

/* --------------------------------------------------------------------------
 * Keycap
 * ------------------------------------------------------------------------ */
export function Kbd({ children }: { children: ComponentChildren }) {
  return <kbd class="mp-kbd">{children}</kbd>;
}

/* --------------------------------------------------------------------------
 * Inset settings group (macOS / Linear style): one quiet surface,
 * hairline-divided FieldRows inside. Optional eyebrow label above.
 * ------------------------------------------------------------------------ */
export interface SettingGroupProps {
  label?: ComponentChildren;
  dataTestId?: string;
  children: ComponentChildren;
}

export function SettingGroup({ label, dataTestId, children }: SettingGroupProps) {
  return (
    <>
      {label ? <div class="mp-group-label">{label}</div> : null}
      <div class="mp-group" data-testid={dataTestId}>
        {children}
      </div>
    </>
  );
}

/* --------------------------------------------------------------------------
 * Collapsible drawer built on native <details> (children stay in the DOM
 * when closed, so form values remain queryable & submittable).
 * ------------------------------------------------------------------------ */
export interface CollapsibleSectionProps {
  title: ComponentChildren;
  hint?: ComponentChildren;
  meta?: ComponentChildren;
  icon?: IconName;
  defaultOpen?: boolean;
  quiet?: boolean;
  dataTestId?: string;
  bodyClass?: string;
  children: ComponentChildren;
}

export function CollapsibleSection({
  title,
  hint,
  meta,
  icon,
  defaultOpen = false,
  quiet = false,
  dataTestId,
  bodyClass,
  children,
}: CollapsibleSectionProps) {
  return (
    <details
      class={quiet ? 'mp-advanced-details mp-advanced-details--quiet' : 'mp-advanced-details'}
      data-testid={dataTestId}
      open={defaultOpen}
    >
      <summary class="mp-advanced-summary">
        <span class="mp-advanced-summary-main">
          {icon ? <Icon name={icon} /> : null}
          <span>{title}</span>
          {hint ? <span class="mp-advanced-summary-hint">{hint}</span> : null}
        </span>
        <span class="mp-advanced-summary-meta">
          {meta}
          <span class="mp-advanced-chevron" aria-hidden="true">
            <Icon name="chevron-right" size={12} />
          </span>
        </span>
      </summary>
      <div class={bodyClass ? `mp-advanced-body ${bodyClass}` : 'mp-advanced-body'}>
        {children}
      </div>
    </details>
  );
}

/* --------------------------------------------------------------------------
 * Editorial badge: tiny dot + label pill (live state indicator).
 * ------------------------------------------------------------------------ */
export interface EditorialBadgeProps {
  tone?: 'neutral' | 'accent' | 'ok' | 'danger';
  pulse?: boolean;
  dot?: boolean;
  title?: string;
  dataTestId?: string;
  children: ComponentChildren;
}

export function EditorialBadge({
  tone = 'neutral',
  pulse = false,
  dot = true,
  title,
  dataTestId,
  children,
}: EditorialBadgeProps) {
  const toneClass = tone === 'neutral' ? 'mp-pill' : `mp-pill mp-pill--${tone}`;
  return (
    <span class={toneClass} title={title} data-testid={dataTestId}>
      {dot ? (
        <span class={pulse ? 'mp-dot mp-dot--pulse' : 'mp-dot'} aria-hidden="true" />
      ) : null}
      {children}
    </span>
  );
}

/* --------------------------------------------------------------------------
 * Metric block (serif tabular figure + uppercase eyebrow)
 * ------------------------------------------------------------------------ */
export interface MetricProps {
  label: ComponentChildren;
  value: ComponentChildren;
  unit?: ComponentChildren;
  caption?: ComponentChildren;
  icon?: IconName;
  dataTestId?: string;
}

export function Metric({ label, value, unit, caption, icon, dataTestId }: MetricProps) {
  return (
    <div class="mp-metric" data-testid={dataTestId}>
      <span class="mp-metric-label">
        {icon ? <Icon name={icon} size={12} /> : null}
        {label}
      </span>
      <span class="mp-metric-value">
        {value}
        {unit ? <span class="mp-metric-unit">{unit}</span> : null}
      </span>
      {caption ? <span class="mp-metric-caption">{caption}</span> : null}
    </div>
  );
}

/* --------------------------------------------------------------------------
 * Empty state
 * ------------------------------------------------------------------------ */
export function EmptyState({
  title,
  children,
}: {
  title: ComponentChildren;
  children?: ComponentChildren;
}) {
  return (
    <div class="mp-empty">
      <strong>{title}</strong>
      {children ? <span>{children}</span> : null}
    </div>
  );
}

/* --------------------------------------------------------------------------
 * Sub-section heading inside an .mp-section
 * ------------------------------------------------------------------------ */
export function SubHead({
  title,
  actions,
}: {
  title: ComponentChildren;
  actions?: ComponentChildren;
}) {
  return (
    <div class="mp-subhead">
      <span class="mp-subhead-title">{title}</span>
      {actions ? <div class="mp-row">{actions}</div> : null}
    </div>
  );
}
