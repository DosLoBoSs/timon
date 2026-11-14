/**
 * One display preference of the mascots, stored per account in a layout
 * scope of the daemon (`/api/ui/layout?scope=<scope>`) and read once per
 * page. "Animate mascots" and "Mascot style" are two of them.
 */
import { loadLayout, saveLayout, type LayoutIo } from '@/lib/ui-layout-store';

export type MascotLayoutPref<T> = {
  subscribe(fn: () => void): () => void;
  get(): T;
  /** `false` when the daemon did not take it; the page keeps the choice anyway. */
  set(value: T): Promise<boolean>;
};

export type MascotLayoutPrefSpec<T> = {
  scope: string;
  /** What the page shows before the daemon answers, and when nothing is stored. */
  initial: T;
  /** The stored row to a value; anything unexpected reads as `initial`. */
  read(raw: unknown): T;
  /** The value to the row written. */
  write(value: T): unknown;
};

export function createMascotLayoutPref<T>(spec: MascotLayoutPrefSpec<T>, io: Pick<LayoutIo, 'fetchImpl'> = {}): MascotLayoutPref<T> {
  const listeners = new Set<() => void>();
  let value = spec.initial;
  let requested = false;
  /** A choice made on this page wins over a read still in flight. */
  let chosen = false;
  const layoutIo: LayoutIo = { ...io, scope: spec.scope, storage: null };
  const emit = () => { for (const fn of listeners) fn(); };
  const load = () => {
    if (requested) return;
    requested = true;
    void loadLayout(layoutIo).then((r) => {
      if (!r.ok || chosen) return;
      const next = spec.read(r.raw);
      if (next === value) return;
      value = next;
      emit();
    });
  };
  return {
    subscribe(fn) {
      listeners.add(fn);
      load();
      return () => { listeners.delete(fn); };
    },
    get: () => value,
    set(next) {
      chosen = true;
      if (next !== value) { value = next; emit(); }
      return saveLayout(spec.write(next), layoutIo);
    },
  };
}
