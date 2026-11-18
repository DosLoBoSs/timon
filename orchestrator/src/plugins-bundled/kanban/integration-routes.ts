/**
 * How a project's Kanban jobs land (`project-integration.ts`): read, change,
 * reset, and check that `gh` signs in as the account the setting names.
 *
 * Every verb needs a signed-in caller holding `projects:manage`, reads
 * included: the setting names a folder of this machine and the account the
 * daemon will push as. The daemon token passes, as for every project setting
 * the CLI and the agents write.
 *
 * One exception, `POST …/integration/branch`: the Kanban planner checks the
 * branch name of a new job while the person types it. It needs `kanban:write`
 * (the plan creates Kanban tasks) and answers nothing of the setting beyond
 * the name the job would get.
 */
import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { apiError } from '../../api-error.js';
import { ghLogin, type GhLoginOutcome } from '../../host/gh.js';
import { checkPlanBranch, MAX_PLAN_BRANCH_CHARS, prLandingSetting } from '../../plan-landing.js';
import { announceProjectUpdated } from '../../project-service.js';
import {
  clearProjectIntegration, ProjectIntegrationError, readProjectIntegration, updateProjectIntegration,
} from '../../project-integration.js';
import { readMeta } from '../../projects.js';
import { todoOriginFromRequest } from '../../todo-origin.js';
import { auditRequest } from '../../users/audit-actor.js';
import { rejectIfDenied, requireAuth } from '../../users/identity.js';

export type IntegrationRouteDeps = {
  /** Stands in for `gh api user` in tests: nothing here reaches GitHub. */
  ghLogin?: (configDir: string | null) => Promise<GhLoginOutcome>;
  /** Stands in for the user's home in tests. */
  home?: string;
};

/** Auth, permission and the project: answers the refusal itself and returns
 *  null when the request stops there. */
function projectForRoute(req: Request, res: Response): string | null {
  if (!requireAuth(req, res)) return null;
  if (rejectIfDenied(req, res, 'projects:manage')) return null;
  const slug = req.params.slug;
  if (typeof slug !== 'string') {
    res.status(400).json(apiError('project_refused', 'invalid project slug', { detail: 'invalid project slug' }));
    return null;
  }
  // `readMeta` validates the slug and brings a project still described by its
  // legacy file into the table, where the setting lives.
  try { readMeta(slug); } catch {
    res.status(400).json(apiError('project_refused', 'invalid project slug', { detail: 'invalid project slug' }));
    return null;
  }
  return slug;
}

function answerError(res: Response, err: unknown): void {
  if (err instanceof ProjectIntegrationError) {
    if (err.code === 'not_found') { res.status(404).json(apiError('project_not_found', err.message)); return; }
    res.status(400).json(apiError('integration_invalid', err.message, { detail: err.message }));
    return;
  }
  // Not echoed: an unexpected failure may quote the folder the setting names.
  console.error('[kanban] project integration request failed:', (err as Error).message);
  res.status(500).json(apiError('project_request_failed', 'the integration setting could not be handled', {
    detail: 'the integration setting could not be handled',
  }));
}

const PlanBranchBody = z.object({
  branch: z.string().max(MAX_PLAN_BRANCH_CHARS),
}).strict();

/** Auth, permission and a valid slug for the planner's branch check. */
function plannerProject(req: Request, res: Response): string | null {
  if (!requireAuth(req, res)) return null;
  if (rejectIfDenied(req, res, 'kanban:write')) return null;
  const slug = req.params.slug;
  if (typeof slug !== 'string') {
    res.status(400).json(apiError('project_refused', 'invalid project slug', { detail: 'invalid project slug' }));
    return null;
  }
  try { readMeta(slug); } catch {
    res.status(400).json(apiError('project_refused', 'invalid project slug', { detail: 'invalid project slug' }));
    return null;
  }
  return slug;
}

export function registerIntegrationRoutes(app: Router, deps: IntegrationRouteDeps = {}): void {
  const login = deps.ghLogin ?? ((dir: string | null) => ghLogin(dir));

  app.get('/api/projects/:slug/integration', (req, res) => {
    const slug = projectForRoute(req, res);
    if (!slug) return;
    try { res.json(readProjectIntegration(slug)); } catch (err) { answerError(res, err); }
  });

  app.put('/api/projects/:slug/integration', (req, res) => {
    const slug = projectForRoute(req, res);
    if (!slug) return;
    try {
      const integration = updateProjectIntegration(slug, req.body, deps.home ? { home: deps.home } : {});
      auditRequest(req, 'project.integration_set', `${slug}:${integration.mode}`);
      announceProjectUpdated(slug, ['integration'], todoOriginFromRequest(req));
      res.json({ integration, configured: true });
    } catch (err) { answerError(res, err); }
  });

  app.delete('/api/projects/:slug/integration', (req, res) => {
    const slug = projectForRoute(req, res);
    if (!slug) return;
    try {
      clearProjectIntegration(slug);
      auditRequest(req, 'project.integration_cleared', slug);
      announceProjectUpdated(slug, ['integration'], todoOriginFromRequest(req));
      res.json(readProjectIntegration(slug));
    } catch (err) { answerError(res, err); }
  });

  // One network call to the forge, on demand only: never on a read.
  app.post('/api/projects/:slug/integration/check', async (req, res) => {
    const slug = projectForRoute(req, res);
    if (!slug) return;
    let read;
    try { read = readProjectIntegration(slug); } catch (err) { answerError(res, err); return; }
    if (read.invalid) {
      res.status(409).json(apiError('integration_invalid', `the stored setting is invalid: ${read.invalid}`, { detail: read.invalid }));
      return;
    }
    const { account, gh_config_dir: configDir } = read.integration;
    const out = await login(configDir);
    if (!out.ok) {
      res.json({ ok: false, expected: account, code: out.code, reason: out.reason });
      return;
    }
    // GitHub logins ignore case.
    const matches = account !== null && out.login.toLowerCase() === account.toLowerCase();
    res.json({ ok: matches, login: out.login, expected: account, matches });
  });

  // The planner's check: the same rules and numbering as the plan's answer
  // (`checkPlanBranch`), so the field never accepts a name the daemon refuses.
  app.post('/api/projects/:slug/integration/branch', (req, res) => {
    const slug = plannerProject(req, res);
    if (!slug) return;
    const parsed = PlanBranchBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
      res.status(400).json(apiError('plan_branch_refused', detail, { detail }));
      return;
    }
    const found = prLandingSetting(slug);
    if (!found) {
      res.status(409).json(apiError('plan_branch_unavailable', `project ${slug} does not land through pull requests`));
      return;
    }
    const out = checkPlanBranch(parsed.data.branch, found.setting, found.repo);
    if (!out.ok) {
      res.status(400).json({
        ...apiError('plan_branch_refused', out.refusal, { detail: out.refusal }),
        ok: false, branch: out.branch, refusal: out.refusal,
      });
      return;
    }
    res.json({ ok: true, branch: out.branch });
  });
}
