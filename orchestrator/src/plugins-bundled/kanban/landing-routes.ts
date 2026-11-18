/**
 * The landing of Kanban jobs, as the island of the board reads it
 * (`integration-preview.ts`):
 *
 * - `GET  /api/kanban/landings[?project=…|series=…]`: the jobs' integration
 *   branches and pull requests;
 * - `GET  /api/kanban/landings/:id`: one of them;
 * - `POST /api/kanban/landings/:id/checks`: reads the checks of its open pull
 *   request from the forge, at most about once a minute;
 * - `POST /api/kanban/landings/:id/preview`: commits, diff, conflict and the
 *   pull request's pre-checks run dry, before anything is pushed.
 *
 * Not under `/api/integrations`: that prefix belongs to the messaging
 * integrations of plugins (`/api/integrations/receipts`…).
 *
 * Every route needs a signed-in caller and reads through its scope: a job the
 * caller cannot see is "not found", like its series. The dry pre-checks also
 * need `projects:manage`, as opening the pull request does: they ask the
 * forge which account the project's credentials sign in as. The daemon token
 * passes, as on every Kanban read the CLI and the agents make.
 */
import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { apiError } from '../../api-error.js';
import { dbApi, type IntegrationRow } from '../../db.js';
import {
  integrationView, integrationVisibleTo, listIntegrationViews, previewIntegration, refreshIntegrationChecks,
  type PreviewDeps,
} from '../../integration-preview.js';
import { requestHasPermission, requireAuth, viewerFromRequest } from '../../users/identity.js';

const Id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/, 'an id');

const ListQuery = z.object({
  project: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._-]*$/i, 'a project slug').optional(),
  series: Id.optional(),
}).strict();

const PreviewBody = z.object({
  title: z.string().max(256).optional(),
  body: z.string().max(16_000).optional(),
}).strict();

const EmptyBody = z.object({}).strict();

function zodDetail(err: z.ZodError): string {
  return err.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
}

function invalid(res: Response, detail: string): void {
  res.status(400).json(apiError('landing_request_invalid', detail, { detail }));
}

/** Auth and the row, through the caller's scope: answers the refusal itself
 *  and returns null when the request stops there. */
function landingForRoute(req: Request, res: Response): IntegrationRow | null {
  if (!requireAuth(req, res)) return null;
  const id = Id.safeParse(req.params.id);
  if (!id.success) { invalid(res, zodDetail(id.error)); return null; }
  const row = dbApi.getIntegrationById(id.data);
  if (!row || !integrationVisibleTo(viewerFromRequest(req), row)) {
    res.status(404).json(apiError('landing_not_found', 'no job with this id'));
    return null;
  }
  return row;
}

function failed(res: Response, what: string, err: unknown): void {
  // Not echoed: an unexpected failure may quote a path of this machine.
  console.error(`[kanban] ${what} failed:`, (err as Error).message);
  res.status(500).json(apiError('landing_request_failed', 'the landing of the job could not be read'));
}

export function registerLandingRoutes(app: Router, deps: PreviewDeps = {}): void {
  app.get('/api/kanban/landings', (req, res) => {
    if (!requireAuth(req, res)) return;
    const query = ListQuery.safeParse(req.query);
    if (!query.success) { invalid(res, zodDetail(query.error)); return; }
    try {
      res.json({ landings: listIntegrationViews(query.data, viewerFromRequest(req)) });
    } catch (err) { failed(res, 'listing the landings', err); }
  });

  app.get('/api/kanban/landings/:id', (req, res) => {
    const row = landingForRoute(req, res);
    if (!row) return;
    res.json({ landing: integrationView(row) });
  });

  app.post('/api/kanban/landings/:id/checks', async (req, res) => {
    const row = landingForRoute(req, res);
    if (!row) return;
    const body = EmptyBody.safeParse(req.body ?? {});
    if (!body.success) { invalid(res, zodDetail(body.error)); return; }
    try {
      const out = await refreshIntegrationChecks(row, deps);
      if (!out.ok) {
        // The reason comes from `host/forge.ts`, which masks every credential.
        const status = out.code === 'checks_not_applicable' ? 409 : 502;
        res.status(status).json(apiError('landing_checks_unavailable', out.reason, { detail: out.reason }));
        return;
      }
      res.json({ landing: out.integration, fresh: out.fresh });
    } catch (err) { failed(res, 'reading the checks of a pull request', err); }
  });

  app.post('/api/kanban/landings/:id/preview', async (req, res) => {
    const row = landingForRoute(req, res);
    if (!row) return;
    const body = PreviewBody.safeParse(req.body ?? {});
    if (!body.success) { invalid(res, zodDetail(body.error)); return; }
    try {
      const preview = await previewIntegration(row, {
        ...body.data,
        prechecks: requestHasPermission(req, 'projects:manage'),
      }, deps);
      res.json(preview);
    } catch (err) { failed(res, 'previewing a pull request', err); }
  });
}
