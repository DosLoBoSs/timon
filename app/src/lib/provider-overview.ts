/**
 * The providers as the daemon groups them (`docs/PROVIDERS-OVERVIEW.md`): one
 * record per provider, with its single status line. Read through the
 * `/api/ui/providers/overview` proxy (superadmin session only).
 *
 * Copy of the daemon's types (`plugins-bundled/backends/provider-overview.ts`):
 * the app cannot import the daemon. Open-ended for a plugin (`packages/sdk`):
 * a field the daemon adds later must not break a section compiled today.
 */
import { t } from '@/lib/i18n';

/** Same order and names as the daemon's `PROVIDER_STATUSES`. */
export const PROVIDER_STATUSES = [
  'disabled', 'blocked', 'not-installed', 'needs-authorization', 'connected', 'not-connected', 'available',
] as const;
export type ProviderStatus = typeof PROVIDER_STATUSES[number];

export type ProviderOrigin = 'built-in' | 'user' | 'catalog' | 'plugin';
export type ProgramAuthorization = 'ready' | 'authorize' | 'install' | 'refused';

export type ProviderBackendView = {
  id: string;
  label: string;
  active: boolean;
  disabled: boolean;
  reason: string | null;
  modelCount: number;
  defaultModel: string | null;
  isDefault: boolean;
  remote: boolean;
};

export type ProviderProgramView = {
  name: string;
  path: string | null;
  linkTarget: string | null;
  pinned: boolean;
  /** The `host.binaries` key a path is pinned under; `null` when nothing can be pinned. Absent from an older daemon. */
  pinKey?: string | null;
  pin: string | null;
  version: string | null;
  latest: string | null;
  updateAvailable: boolean;
  unsupportedVersion: boolean;
  bundled: boolean;
  installable: boolean;
  installCommand: string | null;
  installDocs: string | null;
  authorization: ProgramAuthorization | null;
  refusedReason: string | null;
};

/** A subscription account of this provider, as the daemon's account routes publish it. */
export type ProviderAccountView = {
  id: string;
  instance: string;
  backend: string;
  name: string;
  ownerUserId: string;
  mine: boolean;
  state: 'active' | 'cooldown' | 'reauth';
  /** Signed in through Timon. */
  connected: boolean;
  identity?: string | null;
  createdAt: number;
  [field: string]: unknown;
};

export type ProviderOverview = {
  id: string;
  name: string;
  brand: string | null;
  icon: string | null;
  origin: ProviderOrigin;
  pluginId: string | null;
  plugin: { id: string; label: string; version: string; state: string; reason: string | null; signed: boolean | null; builtin: boolean } | null;
  catalogAgent: { id: string; version: string; latest: string | null; state: string; integrity: string; updateAvailable: boolean } | null;
  enabled: boolean;
  isDefault: boolean;
  backends: ProviderBackendView[];
  modelCount: number;
  /** Absent from a daemon older than the provider page. */
  agentCount?: number;
  connection: {
    signedIn: boolean | null;
    signInCommand: string | null;
    signInThen: string | null;
    acceptsAccounts: boolean;
    accounts: ProviderAccountView[];
  };
  secret: { required: boolean; present: boolean; names: string[] };
  programs: ProviderProgramView[];
  status: ProviderStatus;
  updateAvailable: boolean;
};

export type ProvidersOverview = { providers: ProviderOverview[]; defaultBackend: string | null };

const BASE = '/api/ui/providers/overview';

export class ProviderOverviewError extends Error {
  constructor(readonly status: number) {
    super(status === 401 || status === 403 ? t('providerPage.errors.forbidden') : t('providerPage.errors.generic', { status }));
    this.name = 'ProviderOverviewError';
  }
}

async function read<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new ProviderOverviewError(response.status);
  return await response.json() as T;
}

export const fetchProvidersOverview = (): Promise<ProvidersOverview> => read(BASE);

/**
 * Which provider a `provider=<id>` names. The page's own links carry an
 * overview id; a refused launch's card (`provider-launch:<plugin>`) carries
 * the plugin id, which is the provider's id unless the plugin brings several
 * backends (then its first provider); an older link may carry a backend id.
 */
export function resolveProviderId(providers: readonly ProviderOverview[], requested: string | null): ProviderOverview | null {
  if (!requested) return null;
  return providers.find((p) => p.id === requested)
    ?? providers.find((p) => p.pluginId === requested)
    ?? providers.find((p) => p.backends.some((b) => b.id === requested))
    ?? null;
}

/** The one family of pastilles: green ready, yellow action needed, red blocked, grey switched off. */
export type StatusTone = 'ready' | 'action' | 'blocked' | 'off';

const TONES: Readonly<Record<ProviderStatus, StatusTone>> = {
  connected: 'ready',
  available: 'ready',
  'not-connected': 'action',
  'not-installed': 'action',
  'needs-authorization': 'action',
  blocked: 'blocked',
  disabled: 'off',
};

export function statusTone(status: ProviderStatus): StatusTone {
  return TONES[status] ?? 'action';
}

export type ProgramState = 'installed' | 'missing' | 'brokenPin' | 'update' | 'unsupported';

/** Where the program stands, in one word: the path a launch runs first, then its version. */
export function programState(program: ProviderProgramView): ProgramState {
  if (program.path === null) return program.pin !== null ? 'brokenPin' : 'missing';
  if (program.unsupportedVersion) return 'unsupported';
  return program.updateAvailable ? 'update' : 'installed';
}

/**
 * The authorization to show for a program, `null` for none. Only a third
 * party's program waits for the operator: a provider shipped in the release
 * shows none even if a daemon answered one.
 */
export function shownAuthorization(provider: Pick<ProviderOverview, 'origin'>, program: ProviderProgramView): ProgramAuthorization | null {
  return provider.origin === 'plugin' ? program.authorization : null;
}
