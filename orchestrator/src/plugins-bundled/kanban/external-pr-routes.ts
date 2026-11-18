/**
 * The open pull requests of a project and their read-only relecture
 * (`external-pr-review.ts`):
 *
 *   GET  /api/projects/:slug/pull-requests                      the list, with each one's review
 *   GET  /api/projects/:slug/pull-requests/:number/diff         the diff, as text
 *   POST /api/projects/:slug/pull-requests/:number/review       prepares the brief (starts nothing)
 *   POST /api/projects/:slug/pull-requests/:number/review/send  starts the brief the person read
 *
 * Every verb needs a signed-in caller holding `projects:manage`: they run `gh`
 * with the account and the config folder of the project's integration setting,
 * the same right that names them. The daemon token passes on the reads and the
 * preparation, as for every project setting the CLI and the agents use.
 * Sending is a person's click and nobody else's: an agent, a mission token or
 * the daemon token cannot start a relecture, so a contributor's text that
 * talked an agent into it would still wait for the person. It also needs
 * `missions:spawn`.
 */
import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { apiError } from '../../api-error.js';
import {
  listPullRequests, prepareReview, readPullRequestDiff, sendReview,
  type ExternalPrDeps, type ExternalPrRefusal,
} from '../../external-pr-review.js';
import { auditRequest } from '../../users/audit-actor.js';
import { isPersonAuth, rejectIfDenied, requireAuth } from '../../users/identity.js';

const Params = z.object({
  slug: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._-]*$/i, 'a project slug'),
  number: z.coerce.number().int().positive().max(1_000_000_000).optional(),
});

const PrepareBody = z.object({}).strict();
const SendBody = z.object({ review_id: z.string().uuid() }).strict();

function zodDetail(err: z.ZodError): string {
  return err.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
}

/** One literal per code, so the webview's messages can be checked against them. */
function refusalBody(out: ExternalPrRefusal) {
  const params = { detail: out.reason };
  switch (out.code) {
    case 'project_not_found': return apiError('project_not_found', out.reason);
    case 'integration_invalid': return apiError('integration_invalid', out.reason, params);
    case 'integration_not_pr': return apiError('integration_not_pr', out.reason);
    case 'pr_repository_unknown': return apiError('pr_repository_unknown', out.reason);
    case 'forge_read_failed': return apiError('forge_read_failed', out.reason, params);
    case 'pr_review_running': return apiError('pr_review_running', out.reason);
    case 'pr_review_not_found': return apiError('pr_review_not_found', out.reason);
    case 'pr_reviewer_unavailable': return apiError('pr_reviewer_unavailable', out.reason);
    case 'pr_review_send_failed': return apiError('pr_review_send_failed', out.reason, params);
  }
}

type Parsed = { slug: string; number?: number | undefined };

/** Auth, permission and parameters: answers the refusal itself and returns
 *  null when the request stops there. */
function guard(req: Request, res: Response, body?: z.ZodTypeAny): Parsed | null {
  if (!requireAuth(req, res)) return null;
  if (rejectIfDenied(req, res, 'projects:manage')) return null;
  const params = Params.safeParse(req.params);
  if (!params.success) {
    const detail = zodDetail(params.error);
    res.status(400).json(apiError('pr_request_invalid', detail, { detail }));
    return null;
  }
  if (body) {
    const parsed = body.safeParse(req.body ?? {});
    if (!parsed.success) {
      const detail = zodDetail(parsed.error);
      res.status(400).json(apiError('pr_request_invalid', detail, { detail }));
      return null;
    }
  }
  return params.data;
}

function failed(res: Response, err: unknown): void {
  // Not echoed: an unexpected failure may quote a path of this machine.
  console.error('[kanban] pull request read failed:', (err as Error).message);
  res.status(500).json(apiError('pr_read_failed', 'the pull request could not be read'));
}

export function registerExternalPrRoutes(app: Router, deps: ExternalPrDeps = {}): void {
  app.get('/api/projects/:slug/pull-requests', async (req, res) => {
    const p = guard(req, res);
    if (!p) return;
    try {
      const out = await listPullRequests(p.slug, deps);
      if (!out.ok) { res.status(out.status).json(refusalBody(out)); return; }
      res.json({ repo: out.repo, pulls: out.pulls });
    } catch (err) { failed(res, err); }
  });

  app.get('/api/projects/:slug/pull-requests/:number/diff', async (req, res) => {
    const p = guard(req, res);
    if (!p || p.number === undefined) return;
    try {
      const out = await readPullRequestDiff(p.slug, p.number, deps);
      if (!out.ok) { res.status(out.status).json(refusalBody(out)); return; }
      res.json({ diff: out.diff, truncated: out.truncated });
    } catch (err) { failed(res, err); }
  });

  app.post('/api/projects/:slug/pull-requests/:number/review', async (req, res) => {
    const p = guard(req, res, PrepareBody);
    if (!p || p.number === undefined) return;
    try {
      const out = await prepareReview(p.slug, p.number, deps);
      if (!out.ok) { res.status(out.status).json(refusalBody(out)); return; }
      res.json({ review: out.review, brief: out.brief });
    } catch (err) { failed(res, err); }
  });

  app.post('/api/projects/:slug/pull-requests/:number/review/send', async (req, res) => {
    if (!requireAuth(req, res)) return;
    if (!isPersonAuth(req.auth)) {
      res.status(403).json(apiError('person_required', 'a relecture is sent by a signed-in person'));
      return;
    }
    if (rejectIfDenied(req, res, 'missions:spawn')) return;
    const p = guard(req, res, SendBody);
    if (!p || p.number === undefined) return;
    const { review_id: reviewId } = SendBody.parse(req.body);
    try {
      const out = await sendReview(p.slug, p.number, reviewId, req.auth?.user?.id ?? null, deps);
      if (!out.ok) { res.status(out.status).json(refusalBody(out)); return; }
      auditRequest(req, 'integration.pr_review_sent', `${p.slug}#${p.number}`);
      res.json({ review: out.review });
    } catch (err) { failed(res, err); }
  });
}
