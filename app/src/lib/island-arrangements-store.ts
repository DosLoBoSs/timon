/**
 * The account's named island arrangements, held once for the document.
 *
 * A module store rather than `useStoredLayout`, because two readers are not
 * React components: the layout plugin registers one menu entry per
 * arrangement shown in the menu (`plugins-client/ui-layout.tsx`), outside any
 * render. The menu section and the page read the same store, so a rename in
 * one repaints the other.
 *
 * Every write reads the row again first and is guarded by the version it read
 * (`expected=` of `PUT /api/layout`): the list is short and edited rarely,
 * but from any window, and the one left on an old copy must not erase what
 * another one saved.
 *
 * On a remote machine, the list may also sit under the row it was stored in
 * before the scopes followed the acting account (TIM-0137): that row is folded
 * into the account's one the first time the list is read in a document, then
 * erased, so a deleted arrangement never comes back from it.
 */

import { useEffect, useSyncExternalStore } from 'react';
import { onAccountChange, currentAccount } from './account-change';
import {
  fitsArrangements,
  readArrangements,
  writeArrangements,
  type ArrangementError,
  type ArrangementResult,
  MAX_ARRANGEMENTS,
  type IslandArrangement,
} from './island-arrangements';
import { sameName } from './layout-presets';
import { mergeHandedList } from './layout-handover';
import { eraseLayout, loadLayout, storeLayout } from './ui-layout-store';
import { sharedArrangementsScope } from './workspace-scope';

export type ArrangementsState = {
  owner: string | null;
  /** The list was read once for this account. Before that, nothing may be written. */
  ready: boolean;
  arrangements: readonly IslandArrangement[];
};

export type ArrangementOutcome =
  | { ok: true; arrangement: IslandArrangement }
  | { ok: false; error: ArrangementError };

let state: ArrangementsState = { owner: null, ready: false, arrangements: [] };
/** Bumped at every change of account: an answer read for the previous one lands nowhere. */
let epoch = 0;
/**
 * The id the current owner's list was hashed with before, on a remote machine
 * (`previousLayoutOwner`): learnt from the workspace, which only the React
 * readers see — the menu entries follow the account alone.
 */
let previousOwner: string | null = null;
/** Previous rows already read in this document, each one once: a reader
 *  arriving while one is folded waits for that fold rather than start its own. */
const folded = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

function publish(next: ArrangementsState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function arrangementsState(): ArrangementsState {
  return state;
}

export function subscribeArrangements(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Reads the list of the current account. `false` when the daemon did not answer. */
export async function refreshArrangements(): Promise<boolean> {
  const { owner } = state;
  if (!owner) return false;
  const started = epoch;
  const out = await loadLayout({ scope: await sharedArrangementsScope(owner), storage: null });
  if (started !== epoch || !out.ok) return false;
  publish({ owner, ready: true, arrangements: readArrangements(out.raw) });
  await foldPreviousArrangements(owner, started);
  return true;
}

/**
 * Folds the list the previous owner's row still holds into the account's one,
 * then erases that row — only once the merged list is written, so a refused
 * write loses nothing and the next document tries again.
 */
async function foldPreviousArrangements(owner: string, started: number): Promise<void> {
  const previous = previousOwner;
  if (!previous || previous === owner) return;
  const source = await sharedArrangementsScope(previous);
  if (started !== epoch) return;
  const known = folded.get(source);
  if (known) return known;
  const fold = foldRow(owner, started, source);
  folded.set(source, fold);
  return fold;
}

async function foldRow(owner: string, started: number, source: string): Promise<void> {
  const old = await loadLayout({ scope: source, storage: null });
  if (started !== epoch || !old.ok || old.raw === null) return;
  const found = readArrangements(old.raw);
  // A row holding nothing readable is left as it is: erasing it would lose
  // what a later build may know how to read.
  if (found.length === 0) return;
  const out = await commitArrangements(owner, started, (current) => ({
    ok: true,
    arrangements: mergeHandedList(current, found, { max: MAX_ARRANGEMENTS, fits: fitsArrangements, sameName }),
  }));
  if (out.ok) void eraseLayout({ scope: source, storage: null });
}

/**
 * Points the store at `owner`. Another account empties the list before its
 * own is read: one account's arrangements must never show in the next one's
 * menu, not even for the length of a request.
 */
export function followArrangementsOwner(owner: string | null, previous?: string | null): void {
  if (owner === state.owner) {
    // `undefined` says nothing: a reader that does not know the workspace
    // (the menu entries) must not forget what another reader taught.
    if (previous !== undefined) previousOwner = previous;
    return;
  }
  epoch++;
  previousOwner = previous ?? null;
  publish({ owner, ready: false, arrangements: [] });
  if (owner) void refreshArrangements();
}

/**
 * Follows the account the document is signed in as, until the returned
 * function is called. For a reader outside React (the menu entries).
 */
export function followAccountArrangements(): () => void {
  followArrangementsOwner(currentAccount());
  return onAccountChange(followArrangementsOwner);
}

/**
 * Applies `op` to the list as the daemon holds it NOW, then writes it.
 *
 * The verdict is the daemon's, awaited: a caller closes its form or announces
 * a success on `ok` only (the rule of `commitPresets`). A write refused
 * because another window wrote in between is tried once more on the fresh
 * list — the operation is a name and an id, so it still means the same.
 */
export async function mutateArrangements(op: (current: readonly IslandArrangement[]) => ArrangementResult): Promise<ArrangementOutcome> {
  const { owner } = state;
  if (!owner) return { ok: false, error: 'write-failed' };
  const picked: { arrangement?: IslandArrangement } = {};
  const out = await commitArrangements(owner, epoch, (current) => {
    const result = op(current);
    if (result.ok) picked.arrangement = result.arrangement;
    return result;
  });
  if (!out.ok) return out;
  return picked.arrangement ? { ok: true, arrangement: picked.arrangement } : { ok: false, error: 'write-failed' };
}

type ListChange =
  | { ok: true; arrangements: readonly IslandArrangement[] | null }
  | { ok: false; error: ArrangementError };

/**
 * Reads the list again, applies `op`, and writes the result guarded by the
 * version read; once more on a conflict. An `arrangements` of `null` means
 * the list already says it: nothing is written.
 */
async function commitArrangements(
  owner: string,
  started: number,
  op: (current: readonly IslandArrangement[]) => ListChange,
): Promise<{ ok: true } | { ok: false; error: ArrangementError }> {
  const scope = await sharedArrangementsScope(owner);
  for (let attempt = 0; attempt < 2; attempt++) {
    const read = await loadLayout({ scope, storage: null });
    if (started !== epoch || !read.ok) return { ok: false, error: 'write-failed' };
    const current = readArrangements(read.raw);
    const result = op(current);
    if (!result.ok) return result;
    if (result.arrangements === null) {
      publish({ owner, ready: true, arrangements: current });
      return { ok: true };
    }
    if (!fitsArrangements(result.arrangements)) return { ok: false, error: 'too-large' };
    const written = await storeLayout(writeArrangements(result.arrangements), {
      scope,
      storage: null,
      version: { value: read.updatedAt },
    });
    if (started !== epoch) return { ok: false, error: 'write-failed' };
    if (written === 'ok') {
      publish({ owner, ready: true, arrangements: result.arrangements });
      return { ok: true };
    }
    if (written === 'failed') return { ok: false, error: 'write-failed' };
  }
  return { ok: false, error: 'write-failed' };
}

const serverState: ArrangementsState = { owner: null, ready: false, arrangements: [] };

/**
 * The arrangements of `owner`, read when a reader mounts — the menu is opened
 * rarely, and a list edited in another window must show up there.
 * `previousOwner` is the workspace's (`useWorkspaceLayout`): the owner the
 * list was hashed with before, on a remote machine, folded in once.
 */
export function useArrangements(owner: string | null, previousOwner?: string | null): ArrangementsState {
  useEffect(() => {
    // An owner not resolved yet says nothing about the account: following it
    // would empty a list another reader is showing.
    if (!owner) return;
    const known = owner === arrangementsState().owner;
    followArrangementsOwner(owner, previousOwner);
    if (known) void refreshArrangements();
  }, [owner, previousOwner]);
  const current = useSyncExternalStore(subscribeArrangements, arrangementsState, () => serverState);
  return current.owner === owner ? current : serverState;
}

/**
 * The name of an arrangement, from the list already held — no read of its
 * own: the island workspace asks on every page, and the layout plugin keeps
 * the list read for the menu entries anyway.
 */
export function useArrangementName(id: string | null): string | null {
  const current = useSyncExternalStore(subscribeArrangements, arrangementsState, () => serverState);
  return id ? current.arrangements.find((a) => a.id === id)?.name ?? null : null;
}
