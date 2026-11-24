'use client';

/**
 * What a `providers.row` occupant is painted for: ONE provider's row, in the
 * providers list of Settings › AI models or in the onboarding's "Your AIs" step.
 *
 * The slot passes no props — an entry is registered once and painted by every
 * row on screen — so each host (`ProviderRow`) puts its provider here and the
 * occupant reads it with `useProviderRow()`. The host owns the gestures: what
 * opening the row does, and the action the surface puts at its end.
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { ProviderOverview, ProviderStatus } from '@/lib/provider-overview';

/** `settings`: the providers list. `onboarding`: the first-run step, where a row installs and connects. */
export type ProviderRowMode = 'settings' | 'onboarding';

export type ProviderRowValue = {
  mode: ProviderRowMode;
  /** The daemon's record of this provider (`/api/providers/overview`). */
  provider: ProviderOverview;
  /** Its one status line, the same verdict as on its page. */
  status: ProviderStatus;
  /** Opens the provider's page; `null` where the row leads nowhere (the onboarding). */
  open: (() => void) | null;
  /** What the surface puts at the end of the row (the onboarding's install button); `null` in the list. */
  action: ReactNode;
};

const ProviderRowContext = createContext<ProviderRowValue | null>(null);

export const ProviderRowProvider = ProviderRowContext.Provider;

/** Readable by an occupant of `providers.row`; `null` outside a row. */
export function useProviderRow(): ProviderRowValue | null {
  return useContext(ProviderRowContext);
}
