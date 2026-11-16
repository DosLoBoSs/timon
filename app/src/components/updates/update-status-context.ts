'use client';

/**
 * A newer Timon, verified by the daemon against the signed release list,
 * that the person has not put off: what the update flow runs for
 * (`update-flow.ts`).
 *
 * `useUpdateStatus()` is the hook a former `updates.banner` occupant read.
 * That slot is no longer painted since client API 16 (docs/SDK-COMPAT.md
 * §115), so nothing provides the context to a plugin and the hook answers
 * `null`, as it always did outside the slot. Kept exported: a plugin built
 * against API 15 still loads.
 */

import { createContext, useContext } from 'react';
import type { UpdateArtifact, UpdateOffer, UpdateStatus } from '@/lib/updates';
import type { UpdateDownloadControl } from '@/lib/update-download';

export type UpdateStatusValue = {
  /** The version this daemon runs. */
  installed: string;
  channel: UpdateStatus['channel'];
  /** The version offered, its plain-text notes and every installer published. */
  offer: UpdateOffer;
  /** The installers for this browser's system, the one to download first; empty on a phone or an unknown system. */
  installers: UpdateArtifact[];
  /** End of the running build, `null` when it never ends. */
  buildExpiresAt: string | null;
  /** Hides this version on this machine; the next version is announced again. */
  later: () => void;
  /**
   * The desktop app downloads and verifies the installer itself (P2): start,
   * progress, cancel, then open the folder or the installer. `null` in a
   * browser, an older desktop, or a window on another machine: link
   * `installers[0]` then.
   */
  download: UpdateDownloadControl | null;
};

const UpdateStatusContext = createContext<UpdateStatusValue | null>(null);

export const UpdateStatusProvider = UpdateStatusContext.Provider;

/** Deprecated (client API 16): `null`, the `updates.banner` slot is no longer painted. */
export function useUpdateStatus(): UpdateStatusValue | null {
  return useContext(UpdateStatusContext);
}
