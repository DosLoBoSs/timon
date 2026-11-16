/**
 * The theme a page without a session is painted with (sign-in, invitation,
 * email confirmation): the installation's, as the daemon names it on
 * `GET /api/auth/theme` (`orchestrator/src/users/public-theme.ts`).
 *
 * An anonymous `/api/auth/me` carries the defaults of an account that does not
 * exist, not the installation's choice: an owner who went back to the product
 * theme would still get Timon's on the sign-in page.
 *
 * Only the two built-in themes are accepted, as the daemon only ever names
 * those: anything else, or no answer (an older daemon), keeps `fallback`.
 */
import { TIMON_THEME_PLUGIN } from '@/plugins-client/theme-timon-floor';

export const PUBLIC_THEME_PATH = '/api/auth/theme';

/**
 * `PRODUCT_THEME_PLUGIN`, spelled out: the loader is a `'use client'` module,
 * and the root layout that reads this one is rendered on the server, where
 * such an import is a client reference, not the string.
 */
const PRODUCT_THEME = '@timon/ui-theme';

const PUBLIC_THEMES: readonly string[] = [TIMON_THEME_PLUGIN, PRODUCT_THEME];

export async function readPublicTheme(fetcher: (path: string) => Promise<Response>, fallback: string): Promise<string> {
  try {
    const res = await fetcher(PUBLIC_THEME_PATH);
    if (!res.ok) return fallback;
    const theme = ((await res.json()) as { theme?: unknown } | null)?.theme;
    return typeof theme === 'string' && PUBLIC_THEMES.includes(theme) ? theme : fallback;
  } catch {
    return fallback;
  }
}
