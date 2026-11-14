/**
 * The providers list of Settings › AI models: which group a provider sits in,
 * what the search keeps, which backends the default selector offers, and the
 * one "Check" that asks every source again.
 */
import { checkProviderClis } from '@/lib/provider-clis';
import { recheckBinaries } from '@/lib/backend-binaries';
import { fetchAcpRegistry } from '@/lib/providers';
import { statusTone, type ProviderOverview } from '@/lib/provider-overview';

export type ProviderGroups = { connected: ProviderOverview[]; others: ProviderOverview[] };

/** Case and accents ignored: "Clé" is found by "cle". */
function fold(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function matches(provider: ProviderOverview, needle: string): boolean {
  const haystack = [provider.name, provider.id, ...provider.backends.flatMap((backend) => [backend.id, backend.label])];
  return haystack.some((text) => fold(text).includes(needle));
}

/**
 * "Connected": a provider a mission can run on now, signed in or available on
 * this computer (a green pastille). Everything else waits for something —
 * a sign-in, a download, an authorization — or is blocked or switched off.
 * The daemon's order (the default first, then the picker's) is kept in each.
 */
export function groupProviders(providers: readonly ProviderOverview[], query = ''): ProviderGroups {
  const needle = fold(query.trim());
  const kept = needle ? providers.filter((provider) => matches(provider, needle)) : providers;
  return {
    connected: kept.filter((provider) => statusTone(provider.status) === 'ready'),
    others: kept.filter((provider) => statusTone(provider.status) !== 'ready'),
  };
}

export type DefaultChoice = { backend: string; label: string; brand: string | null; icon: string | null };

/**
 * What the default selector offers: each backend of a switched-on provider,
 * under the provider's name — or the backend's when it brings several.
 */
export function defaultChoices(providers: readonly ProviderOverview[]): DefaultChoice[] {
  return providers.filter((provider) => provider.enabled).flatMap((provider) => provider.backends
    .filter((backend) => !backend.disabled)
    .map((backend) => ({
      backend: backend.id,
      label: provider.backends.length > 1 ? backend.label : provider.name,
      brand: provider.brand,
      icon: provider.icon,
    })));
}

export type VerifyStep = () => Promise<unknown>;

/**
 * The one "Check" of the screen: the AI programs and their updates, the
 * program paths, the catalogue — the four buttons it replaces, at once. Each
 * step answers on its own: one that fails (the catalogue offline) never keeps
 * the others from landing. Returns how many failed.
 */
export const VERIFY_STEPS: readonly VerifyStep[] = [checkProviderClis, recheckBinaries, () => fetchAcpRegistry(true)];

export async function verifyProviders(steps: readonly VerifyStep[] = VERIFY_STEPS): Promise<{ failed: number }> {
  const results = await Promise.allSettled(steps.map((step) => step()));
  return { failed: results.filter((result) => result.status === 'rejected').length };
}
