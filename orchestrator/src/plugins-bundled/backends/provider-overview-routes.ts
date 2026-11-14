/**
 * `/api/providers/overview` — one record per provider, the model every screen
 * of Settings › AI models › Providers reads (`docs/PROVIDERS-OVERVIEW.md`).
 *
 *   GET /api/providers/overview        every provider, the default one first
 *   GET /api/providers/overview/:id    one provider, 404 when unknown
 *
 * A browser session of a superadmin only, like the CLI binaries it shows: the
 * paths name the home folder and the account. Neither the daemon token nor a
 * mission token reads it. Read-only: every action stays on the route that owns
 * it (install, pin, authorize, accounts).
 *
 * Refreshing: nothing new on the stream. The screen reads it again on
 * `backends_changed` and `plugins_changed`, and after any action it takes.
 */
import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { viewerFromRequest } from '../../users/identity.js';
import { loaderFromApp } from '../../plugins/runtime.js';
import { ensureCliVersionsChecked } from '../../provider-cli-versions.js';
import { acpRegistryService } from '../../providers/acp-registry/index.js';
import type { AgentView } from '../../providers/acp-registry/service.js';
import { requireSessionSuperadmin } from './binary-routes.js';
import { providersOverview, type ProvidersOverview } from './provider-overview.js';

const PREFIX = '/api/providers/overview';
/** Plugin ids, `<plugin>.<backend>`, `user:<backend>`, `catalog:<agent>`, `builtin:<backend>`. */
const IdParam = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,200}$/);
/** The registry is asked at most this long; past it, the installed agents as last known. */
const ACP_WAIT_MS = 2_500;

type RouteDeps = {
  /** Test seam: the installed ACP agents. */
  acpAgents?: () => Promise<readonly AgentView[]>;
};

async function installedAcpAgents(): Promise<readonly AgentView[]> {
  const service = acpRegistryService();
  let timer: NodeJS.Timeout | undefined;
  const cap = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ACP_WAIT_MS); timer.unref?.(); });
  try {
    // The registry says whether an update exists; a slow or absent network must not hide what is installed.
    const listed = await Promise.race([service.list().then((list) => list.agents, () => null), cap]);
    return (listed ?? service.installedAgents()).filter((agent) => agent.installed !== null);
  } finally {
    clearTimeout(timer);
  }
}

async function overview(req: Request, res: Response, deps: RouteDeps): Promise<ProvidersOverview | null> {
  const viewer = viewerFromRequest(req);
  if (!viewer) {
    res.status(401).json({ error: 'unauthorized' });
    return null;
  }
  // Never waits for the vendors: the first read of a fresh daemon starts the version check and answers.
  ensureCliVersionsChecked();
  const acpAgents = await (deps.acpAgents ?? installedAcpAgents)().catch((error: Error) => {
    console.warn(`[providers] ACP agents unavailable: ${error.message}`);
    return [];
  });
  return providersOverview({ plugins: loaderFromApp(req.app)?.list() ?? [], acpAgents, viewer });
}

function failed(res: Response, error: unknown): void {
  // Paths of this machine stay in the log.
  console.warn(`[providers] overview: ${(error as Error).message}`);
  res.status(500).json({ error: 'overview_failed' });
}

export function registerProviderOverviewRoutes(router: Router, deps: RouteDeps = {}): void {
  router.get(PREFIX, async (req, res) => {
    if (!requireSessionSuperadmin(req, res)) return;
    try {
      const body = await overview(req, res, deps);
      if (!body) return;
      res.setHeader('Cache-Control', 'no-store');
      res.json(body);
    } catch (error) {
      failed(res, error);
    }
  });

  router.get(`${PREFIX}/:id`, async (req, res) => {
    if (!requireSessionSuperadmin(req, res)) return;
    const id = IdParam.safeParse(req.params.id);
    // zod's issues would quote the input: a fixed message instead.
    if (!id.success) return void res.status(400).json({ error: 'invalid_id' });
    try {
      const body = await overview(req, res, deps);
      if (!body) return;
      const provider = body.providers.find((entry) => entry.id === id.data);
      if (!provider) return void res.status(404).json({ error: 'provider_unknown' });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ provider, defaultBackend: body.defaultBackend });
    } catch (error) {
      failed(res, error);
    }
  });
}
