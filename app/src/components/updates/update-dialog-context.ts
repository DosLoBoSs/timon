'use client';

/**
 * The update window (docs/AUTO-UPDATE.md §10): "Timon x.y.z" and its date,
 * the release's highlights, the full changelog one click away, then the
 * download, its verification, the running missions and "Restart and install".
 *
 * Opened by `openUpdateDialog()` — the update card and Settings › System ›
 * Updates — and painted in the `updates.dialog` slot: the product's window
 * is the fallback, a plugin may take it. The slot passes no props: the host
 * keeps the frame (a dialog named "Timon x.y.z", focus, Escape) and the
 * update flow, and puts what to paint here; the occupant reads it with
 * `useUpdateDialog()`.
 */

import { createContext, useContext } from 'react';
import type { UpdateDownloadState } from '@/lib/update-download';

/** A gesture of the window: a button, or a link when `href` is set. */
export type UpdateDialogAction = {
  label: string;
  /** What the gesture is, for a `data-` attribute: `download`, `cancel`, `install`, `install-anyway`, `wait`, `installer`… */
  marker: string;
  run: () => void;
  /** An address to open in a new tab instead of `run` (the installer, in a browser). */
  href: string | null;
};

export type UpdateDialogValue = {
  /** The version offered. */
  version: string;
  /** When it was published, ISO 8601. */
  publishedAt: string;
  /** The version this daemon runs. */
  installed: string;
  /** Written by hand at the release, plain text, at most five; empty when there are none. */
  highlights: string[];
  /** The full changelog. */
  notesUrl: string;
  /**
   * The desktop app's download of this version, `null` in a browser or a
   * window on another machine: `actions` then links the installer.
   */
  download: UpdateDownloadState | null;
  /**
   * Where the flow stands: `offer` (no download here), `idle`, `downloading`,
   * `verifying`, `download-failed`, `ready` (verified), `missions` (running
   * missions would stop), `installing`, `restarting`, `closing`, `opened`,
   * `guided`, `not-writable`, `none`, `install-failed`.
   */
  step: string;
  /** One line under the progress: where it stands, a refusal, what follows. `null` when there is nothing to say. */
  line: string | null;
  /** A command to paste in a terminal (a `.deb` the system did not install). */
  command: string | null;
  /** The line is a refusal or a warning. */
  alert: boolean;
  /** The gestures of this step, the main one first. */
  actions: UpdateDialogAction[];
  /** Closes the window; the flow goes on (a download keeps running). */
  close: () => void;
};

const UpdateDialogContext = createContext<UpdateDialogValue | null>(null);

export const UpdateDialogProvider = UpdateDialogContext.Provider;

/** Readable by the occupant of `updates.dialog`; `null` outside the window. */
export function useUpdateDialog(): UpdateDialogValue | null {
  return useContext(UpdateDialogContext);
}
