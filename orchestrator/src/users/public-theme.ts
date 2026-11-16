/**
 * The palette an anonymous page (sign-in, invitation, email confirmation) is
 * painted with: the installation's, so that the sign-in does not wear the
 * product's blue while every account behind it wears Timon's.
 *
 * Theme preferences are per account, and an anonymous caller has none. The
 * installation's theme is therefore its owner's: the first superadmin, the
 * same account `recordExistingAppearance` reads the install's scheme from.
 * Before any account exists it is the default every new account gets.
 *
 * Only two answers ever leave this function: the built-in Timon theme, or the
 * product's. A third-party theme cannot paint a page without a session (its
 * bundle is served behind authentication), and naming it to an anonymous
 * caller would confirm that a package is installed (M.4): it reads as the
 * product's, which is also what the app falls back to when that bundle fails.
 */
import { dbApi } from '../db.js';
import type { PluginPublic } from '../plugins/public.js';

export const PRODUCT_THEME_ID = '@timon/ui-theme';
export const TIMON_THEME_ID = 'theme-timon';

export type PublicTheme = typeof PRODUCT_THEME_ID | typeof TIMON_THEME_ID;

/** The rule alone, for a caller that already knows the owner's choice. */
export function publicThemeOf(ownerTheme: string, plugins: readonly PluginPublic[]): PublicTheme {
  if (ownerTheme !== TIMON_THEME_ID) return PRODUCT_THEME_ID;
  // Switched off or missing: the owner's own pages fall back to the product's.
  const timon = plugins.find((plugin) => plugin.id === TIMON_THEME_ID);
  return timon && timon.state === 'active' && timon.kind.includes('theme') ? TIMON_THEME_ID : PRODUCT_THEME_ID;
}

export function installationTheme(plugins: readonly PluginPublic[]): PublicTheme {
  const owner = dbApi.listUsers().find((user) => user.is_superadmin);
  return publicThemeOf(dbApi.userPrefsGet(owner?.id).theme, plugins);
}
