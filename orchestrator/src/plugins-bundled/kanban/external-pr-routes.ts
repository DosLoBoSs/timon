/**
 * The open pull requests of a project and the brief of their relecture
 * (`external-pr-review.ts`):
 *
 *   GET  /api/projects/:slug/pull-requests                 the list, with each one's review and links
 *   GET  /api/projects/:slug/pull-requests/:number/diff    the diff, as text
 *   POST /api/projects/:slug/pull-requests/:number/review  prepares the brief (starts nothing)
 *
 * No route starts a relecture: its mission would run unconfined.
 *
 * Every verb needs a signed-in caller holding `projects:manage`: they run `gh`
 * with the account and the config folder of the project's integration setting,
 * the same right that names them. The daemon token passes, as for every
 * project setting the CLI and the agents use.
 *
 * Each pull request of the list comes with its `links` (`forge-links.ts`): the
 * job behind it when it is one of ours, and the ideas, issues and pilot
 * mission the caller may see; and its `gestures` (`forge-branch-update.ts`):
 * whether its branch can be updated, or its conflict asked of its author or
 * resolved here, read from the list without another call to the forge.
 */
import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { apiError } from '../../api-error.js';
import {
  listPullRequests, prepareReview, readPullRequestDiff,
  type ExternalPrDeps, type ExternalPrRefusal,
} from '../../external-pr-review.js';
import { branchGestures } from '../../forge-branch-update.js';
import { pullRequestLinks } from '../../forge-links.js';
import { readProjectIntegration } from '../../project-integration.js';
import { rejectIfDenied, requireAuth, viewerFromRequest } from '../../users/identity.js';

const Params = z.object({
  slug: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._-]*$/i, 'a project slug'),
  number: z.coerce.number().int().positive().max(1_000_000_000).optional(),
});

const PrepareBody = z.object({}).strict();

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
      const links = pullRequestLinks(p.slug, out.repo, out.pulls, viewerFromRequest(req));
      const setting = readProjectIntegration(p.slug).integration;
      res.json({
        repo: out.repo,
        pulls: out.pulls.map((pull) => ({
          ...pull, links: links.get(pull.number)!, gestures: branchGestures(out.repo, pull, setting),
        })),
      });
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
}
