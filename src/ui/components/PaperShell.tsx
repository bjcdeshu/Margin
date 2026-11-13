import { Fragment, type ComponentChildren } from 'preact';
import { BRAND } from '@shared/brand';
import { Icon, type IconName } from './PaperPrimitives';

export interface NavRailItem<T extends string = string> {
  id: T;
  label: string;
  subtitle?: string;
  /** Optional rail section heading; a heading renders whenever it changes. */
  group?: string;
  /** Optional crisp micro-icon shown before the label. */
  icon?: IconName;
}

export interface PaperShellProps<T extends string = string> {
  subtitle?: string;
  headerActions?: ComponentChildren;
  navItems?: readonly NavRailItem<T>[];
  activeNav?: T;
  onSelectNav?: (id: T) => void;
  navAriaLabel?: string;
  /** Optional quiet footer under the rail (version, shortcuts). */
  navFooter?: ComponentChildren;
  /** Optional editorial masthead rendered above the active tab content. */
  masthead?: ComponentChildren;
  children: ComponentChildren;
}

export function PaperShell<T extends string = string>({
  subtitle,
  headerActions,
  navItems,
  activeNav,
  onSelectNav,
  navAriaLabel = 'Settings Navigation',
  navFooter,
  masthead,
  children,
}: PaperShellProps<T>) {
  let lastGroup: string | undefined;

  return (
    <div class="mp-studio-shell">
      <header class="mp-studio-topbar">
        <div class="mp-studio-brand">
          <span class="mp-studio-brand-mark" aria-hidden="true">
            M
          </span>
          <span class="mp-wordmark">{BRAND.name}</span>
          {subtitle ? (
            <>
              <span class="mp-studio-brand-divider" aria-hidden="true" />
              <span class="mp-studio-subtitle">{subtitle}</span>
            </>
          ) : null}
        </div>
        {headerActions ? <div class="mp-studio-actions">{headerActions}</div> : null}
      </header>

      <div class="mp-studio-body">
        {navItems && navItems.length > 0 ? (
          <nav class="mp-nav-rail" role="tablist" aria-label={navAriaLabel}>
            {navItems.map((item) => {
              const active = item.id === activeNav;
              const heading =
                item.group && item.group !== lastGroup ? (
                  <div class="mp-nav-group-label" role="presentation">
                    {item.group}
                  </div>
                ) : null;
              lastGroup = item.group ?? lastGroup;
              return (
                <Fragment key={item.id}>
                  {heading}
                  <button
                    type="button"
                    role="tab"
                    class="mp-nav-item"
                    aria-selected={active ? 'true' : 'false'}
                    onClick={() => onSelectNav?.(item.id)}
                  >
                    <span class="mp-nav-item-line">
                      {item.icon ? <Icon name={item.icon} /> : null}
                      <span>{item.label}</span>
                    </span>
                    {item.subtitle ? (
                      <span
                        class={
                          item.icon
                            ? 'mp-nav-item-sub mp-nav-item-sub--indented'
                            : 'mp-nav-item-sub'
                        }
                      >
                        {item.subtitle}
                      </span>
                    ) : null}
                  </button>
                </Fragment>
              );
            })}
            {navFooter ? <div class="mp-nav-footer">{navFooter}</div> : null}
          </nav>
        ) : null}

        <main class="mp-studio-main">
          {masthead}
          {children}
        </main>
      </div>
    </div>
  );
}
