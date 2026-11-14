'use client';

/**
 * What a `settings.provider.section` occupant is painted for: the page of ONE
 * provider in Settings › AI models › Providers.
 *
 * The slot passes no props — a section is registered once and painted on every
 * provider page — so the host (`ProviderPage`) puts the provider on screen here
 * and each section reads it with `useProviderPage()`. The host owns the data:
 * it reads the daemon's overview, follows the stream, and reads it again when a
 * section calls `refresh()` after its own change.
 */
import { createContext, useContext } from 'react';
import type { ProviderOverview, ProviderStatus } from '@/lib/provider-overview';

export type ProviderPageValue = {
  /** The daemon's record of this provider (`/api/providers/overview/:id`). */
  provider: ProviderOverview;
  /** Its one status line, the same verdict as the list's. */
  status: ProviderStatus;
  /** The instance's default backend, `null` when none resolves. */
  defaultBackend: string | null;
  /** Reads the provider again: call it after a change a section made itself. */
  refresh: () => Promise<void>;
  /** Back to the providers list. */
  back: () => void;
};

const ProviderPageContext = createContext<ProviderPageValue | null>(null);

export const ProviderPageProvider = ProviderPageContext.Provider;

/** Readable by an occupant of `settings.provider.section`; `null` outside a provider page. */
export function useProviderPage(): ProviderPageValue | null {
  return useContext(ProviderPageContext);
}
