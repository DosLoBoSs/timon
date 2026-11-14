/**
 * The caller's level of Settings › AI models › Providers, read from
 * `/api/auth/me` (`can`), mirror of `orchestrator/src/users/provider-access.ts`:
 *
 * - `full`: the superadmin, or `providers:manage` — every section, adding providers;
 * - `accounts`: `providers:accounts` — the list read only, and on a provider's
 *   page the Connection section with one's own subscription accounts;
 * - `none`: the screen does not exist (no tab, no search entry, no link).
 *
 * Only what to paint: every route refuses on its own.
 */
import { actingUser, type AuthMe } from './auth';

export type ProviderAccess = 'full' | 'accounts' | 'none';

/** `null` while the account is being read. */
export function providerAccess(me: AuthMe | null): ProviderAccess | null {
  if (!me) return null;
  if (actingUser(me)?.is_superadmin === true) return 'full';
  // A daemon too old to say had no level: its providers screen was the superadmin's alone.
  if (me.can === null) return 'none';
  if (me.can['providers:manage'] === true) return 'full';
  if (me.can['providers:accounts'] === true) return 'accounts';
  return 'none';
}
