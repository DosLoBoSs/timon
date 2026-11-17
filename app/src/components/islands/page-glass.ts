'use client';

import { useSyncExternalStore } from 'react';
import type { GlassScope } from '@/lib/glass-scope';

/**
 * The glass of the route's page while no island header is painted for it:
 * the page alone, or alone under popups. Its island keeps a glass choice of
 * its own (made while split, or here), but without a header nothing offered to
 * change it (TODO #806). The workspace publishes this control and the
 * Appearance menu of the top bar, which lives outside the workspace's tree,
 * reads it. One view mounts one workspace: the last one published wins, and
 * an unmount only withdraws its own.
 */
export type PageGlassControl = {
  /** The page island's own choice; `null` follows the Appearance setting. */
  readonly scope: GlassScope | null;
  readonly set: (scope: GlassScope | null) => void;
};

let current: PageGlassControl | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Publishes `control`; the returned function withdraws it, if it is still the one published. */
export function publishPageGlass(control: PageGlassControl): () => void {
  current = control;
  emit();
  return () => {
    if (current !== control) return;
    current = null;
    emit();
  };
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => { listeners.delete(onChange); };
}

/** The control published now, outside React. */
export function readPageGlass(): PageGlassControl | null {
  return current;
}

/** The page's glass control, or `null` while an island header offers it (or no workspace is mounted). */
export function usePageGlass(): PageGlassControl | null {
  return useSyncExternalStore(subscribe, readPageGlass, () => null);
}
