import { useEffect } from 'preact/hooks';
import type { UiColorMode } from '@shared/types';

export function resolveDisplayMode(mode: UiColorMode): 'paper' | 'night' {
  if (mode === 'night') return 'night';
  if (mode === 'paper') return 'paper';
  if (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  ) {
    return 'night';
  }
  return 'paper';
}

export function applyUiColorModeToDocument(
  mode: UiColorMode,
  doc: Document = document,
): 'paper' | 'night' {
  const resolved = resolveDisplayMode(mode);
  const root = doc.documentElement;
  root.dataset.uiColorMode = mode;
  root.dataset.displayMode = resolved;
  return resolved;
}

export function useUiColorMode(mode: UiColorMode): void {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    applyUiColorModeToDocument(mode, document);

    if (
      mode !== 'system' ||
      typeof window === 'undefined' ||
      typeof window.matchMedia !== 'function'
    ) {
      return;
    }

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      applyUiColorModeToDocument('system', document);
    };
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    }
    return undefined;
  }, [mode]);
}
