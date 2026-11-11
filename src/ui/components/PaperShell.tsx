import type { ComponentChildren } from 'preact';
import { BRAND } from '@shared/brand';

export interface NavRailItem<T extends string = string> {
  id: T;
  label: string;
  subtitle?: string;
}

export interface PaperShellProps<T extends string = string> {
  subtitle?: string;
  headerActions?: ComponentChildren;
  navItems?: readonly NavRailItem<T>[];
  activeNav?: T;
  onSelectNav?: (id: T) => void;
  navAriaLabel?: string;
  children: ComponentChildren;
}

export function PaperShell<T extends string = string>({
  subtitle,
  headerActions,
  navItems,
  activeNav,
  onSelectNav,
  navAriaLabel = 'Settings Navigation',
  children,
}: PaperShellProps<T>) {
  return (
    <div class="mp-studio-shell">
      <header class="mp-studio-topbar">
        <div class="mp-studio-brand">
          <span class="mp-wordmark">{BRAND.name}</span>
          {subtitle ? <span class="mp-studio-subtitle">{subtitle}</span> : null}
        </div>
        {headerActions ? <div class="mp-studio-actions">{headerActions}</div> : null}
      </header>

      <div class="mp-studio-body">
        {navItems && navItems.length > 0 ? (
          <nav class="mp-nav-rail" role="tablist" aria-label={navAriaLabel}>
            {navItems.map((item) => {
              const active = item.id === activeNav;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  class="mp-nav-item"
                  aria-selected={active ? 'true' : 'false'}
                  onClick={() => onSelectNav?.(item.id)}
                >
                  <span>{item.label}</span>
                  {item.subtitle ? <span class="mp-nav-item-sub">{item.subtitle}</span> : null}
                </button>
              );
            })}
          </nav>
        ) : null}

        <main class="mp-studio-main">{children}</main>
      </div>
    </div>
  );
}
