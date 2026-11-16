/**
 * The one way into "update now" (docs/AUTO-UPDATE.md §10). The update card,
 * the Settings row and any plugin call `openUpdateDialog()`; whoever paints
 * the update flow (the card's download and install today, the update window
 * tomorrow) registers it with `provideUpdateDialog()`. The last one
 * registered wins, and its removal gives the place back to the one before.
 */
import { useSyncExternalStore } from 'react';

export type UpdateDialogOpener = () => void;

const openers: UpdateDialogOpener[] = [];
const subscribers = new Set<() => void>();

function changed(): void {
  for (const notify of subscribers) notify();
}

/** Registers the flow "update now" opens; returns its removal. */
export function provideUpdateDialog(open: UpdateDialogOpener): () => void {
  openers.push(open);
  changed();
  return () => {
    const at = openers.lastIndexOf(open);
    if (at < 0) return;
    openers.splice(at, 1);
    changed();
  };
}

/** Opens the update flow; `false` when nothing on the page provides one. */
export function openUpdateDialog(): boolean {
  const open = openers[openers.length - 1];
  if (!open) return false;
  open();
  return true;
}

function subscribe(notify: () => void): () => void {
  subscribers.add(notify);
  return () => { subscribers.delete(notify); };
}

const provided = (): boolean => openers.length > 0;

/** Whether `openUpdateDialog()` would open something now. */
export function useUpdateDialogProvided(): boolean {
  return useSyncExternalStore(subscribe, provided, () => false);
}

export function resetUpdateDialogForTests(): void {
  openers.length = 0;
  changed();
}
