import { beforeEach, describe, expect, it } from 'vitest';
import { createDefaultMarginConfig } from '@shared/constants';
import { resetMemoryStorageForTests } from '@shared/storage';
import {
  canonicalizeConfigSnapshot,
  createSaveTracker,
  normalizeConfigForSave,
} from '../../src/ui/components/save-tracker';

describe('Snapshot-Verified Save State (save-tracker)', () => {
  beforeEach(() => {
    resetMemoryStorageForTests();
  });

  it('never shows Saved on initial read-only hydration or external storage sync', () => {
    const tracker = createSaveTracker();
    const history: string[] = [];
    tracker.subscribe((s) => history.push(s.status));

    const initial = createDefaultMarginConfig();
    tracker.hydrateReadOnly(initial);
    expect(tracker.getState().status).toBe('idle');

    // Simulate background/another-tab storage sync via onMarginConfigChanged
    const externalUpdate = createDefaultMarginConfig();
    externalUpdate.webpage.theme = 'mask';
    const matched = tracker.observePersisted(externalUpdate);

    expect(matched).toBe(false);
    expect(tracker.getState().status).toBe('idle');
    expect(history).not.toContain('saved');
  });

  it('transitions to Saved ONLY when a user-initiated write matches the persisted snapshot', () => {
    const tracker = createSaveTracker();
    const base = createDefaultMarginConfig();
    tracker.hydrateReadOnly(base);

    const edited = structuredClone(base);
    edited.webpage.theme = 'mask';
    // Include whitespace & duplicate URL globs to verify trim/dedupe snapshot normalization
    edited.urlRules.excludeMatches = [
      '  https://linux.do/*  ',
      'https://linux.do/*',
      'https://example.org/*',
      '   ',
    ];

    const payload = tracker.beginUserSave(edited);
    expect(payload).not.toBeNull();
    expect(tracker.getState().status).toBe('saving');
    expect(tracker.isSaving()).toBe(true);

    // Rapid consecutive second save coalesces & supersedes pendingSnapshot instead of dropping!
    const editedV2 = structuredClone(edited);
    editedV2.targetLang = 'ja';
    const payloadV2 = tracker.beginUserSave(editedV2);
    expect(payloadV2.targetLang).toBe('ja');
    expect(tracker.getState().status).toBe('saving');

    // Earlier Save #1 readback arrives stale -> must NOT confirm 'saved' early!
    const staleSave1 = normalizeConfigForSave(edited);
    expect(tracker.observePersisted(staleSave1)).toBe(false);
    expect(tracker.getState().status).toBe('saving');
    expect(tracker.isSaving()).toBe(true);

    // Persisted snapshot matching latest Save #2 arrives and confirms 'saved'!
    const persisted = normalizeConfigForSave(editedV2);
    expect(persisted.urlRules.excludeMatches).toEqual([
      'https://linux.do/*',
      'https://example.org/*',
    ]);

    expect(tracker.observePersisted(persisted)).toBe(true);
    expect(tracker.getState().status).toBe('saved');
    expect(tracker.getState().savedAt).toBeTypeOf('number');
    expect(tracker.isSaving()).toBe(false);
    expect(tracker.isDirty(persisted)).toBe(false);
  });

  it('releases pending snapshot cleanly on failure and dispose', () => {
    const tracker = createSaveTracker();
    const cfg = createDefaultMarginConfig();
    tracker.hydrateReadOnly(cfg);

    const next = structuredClone(cfg);
    next.targetLang = 'en';
    tracker.beginUserSave(next);
    expect(tracker.isSaving()).toBe(true);

    tracker.failSave('Quota exceeded');
    expect(tracker.getState().status).toBe('error');
    expect(tracker.getState().errorMessage).toBe('Quota exceeded');
    expect(tracker.isSaving()).toBe(false);

    // Retry is now unlocked
    expect(tracker.beginUserSave(next)).not.toBeNull();
    tracker.dispose();
    expect(tracker.isSaving()).toBe(false);
    expect(tracker.getState().status).toBe('idle');
  });

  it('canonicalizes structurally identical configs deterministically regardless of key insertion order', () => {
    const a = createDefaultMarginConfig();
    const b = createDefaultMarginConfig();
    b.urlRules.excludeMatches = ['  https://linux.do/*  '];
    expect(canonicalizeConfigSnapshot(a)).toBe(canonicalizeConfigSnapshot(b));
  });
});
