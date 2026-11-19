/**
 * What a person may do about the branch of a pull request:
 *
 *   POST /api/projects/:slug/pull-requests/:number/update-branch
 *        prepares "update the branch" (`forge-branch-update.ts`) as a
 *        publication; the person publishes it with
 *        `POST /api/projects/:slug/forge-proposals/:id/publish`.
 *
 * Authentication: a signed-in person (session or paired device) holding
 * `projects:manage`, like every write proposed on the forge. The daemon
 * token, a mission's token and a plugin's are refused (`person_required`):
 * an agent neither prepares nor publishes a write on GitHub.
 */
import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { apiError } from '../../api-error.js';
import { proposeBranchUpdate } from '../../forge-branch-update.js';
import { viewOf, type ForgeProposalDeps } from '../../forge-proposals.js';
import { auditRequest } from '../../users/audit-actor.js';
import { personAt, refusalBody } from './forge-proposal-routes.js';

const PullParams = z.object({
  slug: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._-]*$/i, 'a project slug'),
  number: z.coerce.number().int().positive().max(1_000_000_000),
});

const EmptyBody = z.object({}).strict();

function zodDetail(err: z.ZodError): string {
  return err.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
}

function invalid(res: Response, err: z.ZodError): void {
  const detail = zodDetail(err);
  res.status(400).json(apiError('forge_proposal_invalid', detail, { detail }));
}

/** The person, the pull request and an empty body, or null once answered. */
function pullRequest(req: Request, res: Response): { slug: string; number: number; userId: string } | null {
  const who = personAt(req, res);
  if (!who) return null;
  const params = PullParams.safeParse(req.params);
  if (!params.success) { invalid(res, params.error); return null; }
  const body = EmptyBody.safeParse(req.body ?? {});
  if (!body.success) { invalid(res, body.error); return null; }
  return { ...params.data, userId: who.userId };
}

function failed(res: Response, err: unknown): void {
  // Not echoed: an unexpected failure may quote a path of this machine.
  console.error('[kanban] branch request failed:', (err as Error).name);
  res.status(500).json(apiError('forge_proposal_failed', 'the proposal could not be handled'));
}

export function registerForgeBranchRoutes(app: Router, deps: ForgeProposalDeps = {}): void {
  app.post('/api/projects/:slug/pull-requests/:number/update-branch', async (req, res) => {
    const p = pullRequest(req, res);
    if (!p) return;
    try {
      const out = await proposeBranchUpdate(p.slug, p.number, p.userId, deps);
      if (!out.ok) { res.status(out.status).json(refusalBody(out)); return; }
      if (out.created) auditRequest(req, 'forge.branch_update_proposed', `${p.slug}:${out.proposal.id}`);
      res.status(out.created ? 201 : 200).json({ proposal: viewOf(out.proposal), created: out.created });
    } catch (err) { failed(res, err); }
  });
}
