/**
 * `POST /api/pull-requests`: open the pull request of a Kanban job
 * (`pr-open.ts`). The CLI `timon pr open` and the MCP tool `pr_open` call it.
 *
 * Authentication is required, and `projects:manage`: the gesture pushes to
 * the remote of a project and writes on its forge with the account its
 * setting names. The daemon token passes, as for every project setting the
 * CLI and the agents write; an anonymous request never reaches the checks.
 */
import type { Router } from 'express';
import { z } from 'zod';
import { apiError } from '../../api-error.js';
import { openPullRequest, type PrOpenDeps, type PrOpenRefusalCode } from '../../pr-open.js';
import { auditRequest } from '../../users/audit-actor.js';
import { rejectIfDenied, requireAuth } from '../../users/identity.js';

const PrOpenBody = z.object({
  /** A task of the job, or its series. */
  id: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/, 'a task or series id'),
  title: z.string().trim().min(1).max(256),
  body: z.string().max(16_000).default(''),
}).strict();

/** One literal per code, so the webview's messages can be checked against them. */
function refusalBody(code: PrOpenRefusalCode, reason: string) {
  const params = { detail: reason };
  switch (code) {
    case 'pr_target_not_found': return apiError('pr_target_not_found', reason, params);
    case 'pr_refused': return apiError('pr_refused', reason, params);
    case 'pr_open_busy': return apiError('pr_open_busy', reason, params);
    case 'pr_precheck_failed': return apiError('pr_precheck_failed', reason, params);
    case 'pr_push_failed': return apiError('pr_push_failed', reason, params);
    case 'pr_create_failed': return apiError('pr_create_failed', reason, params);
  }
}

export function registerPrRoutes(app: Router, deps: PrOpenDeps = {}): void {
  app.post('/api/pull-requests', async (req, res) => {
    if (!requireAuth(req, res)) return;
    if (rejectIfDenied(req, res, 'projects:manage')) return;
    const parsed = PrOpenBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
      res.status(400).json(apiError('pr_request_invalid', detail, { detail }));
      return;
    }
    let out;
    try {
      out = await openPullRequest(parsed.data, deps);
    } catch (err) {
      // Not echoed: an unexpected failure may quote a path of this machine.
      console.error('[kanban] opening a pull request failed:', (err as Error).message);
      res.status(500).json(apiError('pr_request_failed', 'the pull request could not be opened'));
      return;
    }
    if (!out.ok) {
      res.status(out.status).json({
        ...refusalBody(out.code, out.reason),
        ...(out.checks ? { checks: out.checks } : {}),
      });
      return;
    }
    auditRequest(req, 'integration.pr_opened', `${out.repository}#${out.pr.number}`);
    res.json(out);
  });
}
