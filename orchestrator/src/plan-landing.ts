/**
 * How the job a series plan (`kanban_plan`) launches will land, read from the
 * project the job is for (`docs/KANBAN-PR-PIPELINE.md` §2.2, step 8 of §8):
 * the planning mission's own, else its agent's, else the registered project
 * whose folder holds the mission's or the agent's working directory
 * (`planProject`).
 *
 * A project set to land through pull requests gets one integration branch per
 * job, named after the job's title or the name the agent proposed (and the
 * person answering the planner may change): the plan's commands give it to
 * every task (`--base`, and `--project` when the planning agent is not in that
 * project) and end with the task that opens the pull request. A sequential job
 * has its pilot ask the daemon for the branch (`series-integration.ts`) and
 * code in a worktree on it. Any other project, or none, gets null: the plan
 * stays what it was.
 */
import { loadConfig } from './agent-config.js';
import { registeredProjects } from './browser-project.js';
import { dbApi } from './db.js';
import { integrationBranchName, integrationBranchRefusal } from './git-integration.js';
import { integrationBaseRef, readProjectIntegration, type ProjectIntegration } from './project-integration.js';
import type { SeriesPlanLanding } from './series-plan.js';
import { projectFromCwd, projectFromRegisteredCwd, taskProjectSlug, type RegisteredProject } from './task-project.js';

export type PlanLanding = SeriesPlanLanding & {
  /** `origin/main`: what the branch is cut from and the pull request targets. */
  baseRef: string;
  /** What the orchestrator must know before it applies the plan. */
  note: string;
  /** The project whose setting decided, for the form's check route. */
  project: string;
  /** `feat/`: shown before the field, never asked again. */
  prefix: string;
  /** The job already has its integration branch: the name no longer changes. */
  locked: boolean;
  /** Why the proposed name cannot be used; `branch` then holds it as typed. */
  refusal?: string;
};

/** Beyond this, the title is too generic to name a job: the caller names it. */
const MAX_SUFFIX = 20;
/** A branch name the agent or the form proposes: a ref, not a paragraph. */
export const MAX_PLAN_BRANCH_CHARS = 200;

/**
 * The branch of a new job: the title's slug, with `-2`, `-3`… when Timon already
 * recorded that branch for an earlier job of the repository, so two jobs never
 * share one pull request.
 */
export function freeBranch(base: string, repo: string | null): string | null {
  if (!repo) return base;
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (integrationBranchRefusal(name)) return null;
    if (!dbApi.getIntegration(repo, name)) return name;
  }
  return null;
}

/**
 * The full name a proposal stands for: the project's prefix is written once,
 * so `topic` and `feat/topic` both mean `feat/topic`.
 */
export function planBranchName(proposed: string, prefix: string): string {
  const name = proposed.trim();
  return name.startsWith(prefix) ? name : `${prefix}${name}`;
}

export type PlanBranchCheck =
  | { ok: true; branch: string }
  | { ok: false; branch: string; refusal: string };

/**
 * Whether `proposed` can name a new job of a project that lands through pull
 * requests, and the name it will really get (`-2` when an earlier job holds
 * it). The form's check route and the plan's answer both go through here: the
 * browser never decides alone.
 */
export function checkPlanBranch(
  proposed: string,
  setting: { target: string; remote: string; branch_prefix: string },
  repo: string | null,
): PlanBranchCheck {
  const raw = proposed.trim();
  const branch = planBranchName(raw, setting.branch_prefix);
  if (!raw || branch === setting.branch_prefix) {
    return { ok: false, branch, refusal: 'name the branch after the job\'s topic' };
  }
  // A task branch pasted as is would only be renamed under the prefix: say why
  // it cannot serve rather than accept a lookalike.
  if (raw.startsWith('timon/')) return { ok: false, branch: raw, refusal: integrationBranchRefusal(raw)! };
  if (branch.length > MAX_PLAN_BRANCH_CHARS) {
    return { ok: false, branch, refusal: `the name is longer than ${MAX_PLAN_BRANCH_CHARS} characters` };
  }
  const baseRef = integrationBaseRef(setting);
  if (branch === setting.target || branch === baseRef) {
    return {
      ok: false, branch,
      refusal: `the pull request targets ${setting.target}: the job needs a branch of its own`,
    };
  }
  const refusal = integrationBranchRefusal(branch);
  if (refusal) return { ok: false, branch, refusal };
  const free = freeBranch(branch, repo);
  if (!free) {
    return { ok: false, branch, refusal: `${branch} and its numbered variants are already taken by earlier jobs` };
  }
  return { ok: true, branch: free };
}

/** The project's setting when it lands through pull requests, with its repository. */
export function prLandingSetting(slug: string, cwd?: string | null): {
  setting: ProjectIntegration; repo: string | null;
} | null {
  let read: ReturnType<typeof readProjectIntegration>;
  try { read = readProjectIntegration(slug); } catch { return null; }
  // A broken setting is refused at dispatch, with its reason, on the first task.
  if (read.invalid || read.integration.mode !== 'pr') return null;
  return { setting: read.integration, repo: dbApi.getProjectRow(slug)?.cwd ?? cwd ?? null };
}

/**
 * The integration branch the series already holds in this project: once a task
 * was dispatched on it, every task of the job starts from it, so a plan opened
 * again reuses it instead of numbering a new one.
 */
function seriesBranch(seriesId: string | null | undefined, slug: string, repo: string | null): string | null {
  if (!seriesId) return null;
  const row = dbApi.listIntegrationsBySeries(seriesId)
    .find((r) => r.project === slug || (repo !== null && r.repo === repo));
  return row?.branch ?? null;
}

export type PlanLandingOptions = {
  /** The name the agent (`kanban_plan`) or the form proposed. */
  branch?: string | null;
  /** The job is coded in a mission (`sequential-*` modes): no task but the
   *  last one, and the pilot asks the daemon for the branch itself. */
  sequential?: boolean;
  /** The mission that opens the planner: the series of the job's tasks, and
   *  the first place the job's project is read from. */
  seriesId?: string | null;
};

export type PlanProject = {
  /** The project the job is for. */
  slug: string;
  /** The working directory it was found from, the repository's fallback. */
  cwd: string | null;
  /** The planning agent's own project: the tasks need `--project` when it differs. */
  agentSlug: string | null;
};

const slugOrNull = (value: string | null | undefined): string | null => (value && value.trim()) || null;

/** The project the planning mission already works for: the task it runs, else the job its series started. */
function missionProject(missionId: string): string | null {
  const mission = dbApi.getMission(missionId);
  if (!mission) return null;
  const own = mission.task_id ? slugOrNull(dbApi.getTask(mission.task_id)?.project) : null;
  if (own) return own;
  const series = dbApi.listTasksBySeries(missionId);
  return slugOrNull(series.find((t) => slugOrNull(t.project))?.project);
}

/**
 * The project a plan is for, in order: the planning mission's own (the task it
 * runs, the job its series started), its own working directory when it has one
 * (`cwd_override`), the agent's (`config.project`, else the
 * `…/projects/<slug>` marker of its cwd), then the registered project whose
 * folder holds that cwd. The agent's declared project comes before the
 * registry so an agent of a project plans exactly as before, even when two
 * projects share one folder; the registry is what finds the project of an
 * agent that belongs to none but works in a project's folder.
 */
export function planProject(
  agentName: string,
  missionId: string | null | undefined,
  registered: () => RegisteredProject[] = registeredProjects,
): PlanProject | null {
  let cfg: ReturnType<typeof loadConfig> | null = null;
  try { cfg = loadConfig(agentName); } catch { return null; }
  const agentSlug = slugOrNull(taskProjectSlug({}, cfg));
  const agentCwd = slugOrNull(cfg.cwd);
  const mission = missionId ? dbApi.getMission(missionId) : undefined;
  const missionCwd = slugOrNull(mission?.cwd_override);
  const own = missionId ? missionProject(missionId) : null;
  if (own) return { slug: own, cwd: missionCwd ?? agentCwd, agentSlug };
  if (missionCwd) {
    const marked = slugOrNull(projectFromCwd(missionCwd)) ?? slugOrNull(projectFromRegisteredCwd(missionCwd, registered()));
    if (marked) return { slug: marked, cwd: missionCwd, agentSlug };
  }
  if (agentSlug) return { slug: agentSlug, cwd: agentCwd, agentSlug };
  const found = agentCwd ? slugOrNull(projectFromRegisteredCwd(agentCwd, registered())) : null;
  return found ? { slug: found, cwd: agentCwd, agentSlug } : null;
}

export function planLanding(agentName: string, chantier: string, opts: PlanLandingOptions = {}): PlanLanding | null {
  const target = planProject(agentName, opts.seriesId);
  if (!target) return null;
  const slug = target.slug;
  const found = prLandingSetting(slug, target.cwd);
  if (!found) return null;
  const { setting, repo } = found;
  const baseRef = integrationBaseRef(setting);
  const prefix = setting.branch_prefix;
  const held = seriesBranch(opts.seriesId, slug, repo);
  let branch: string;
  let refusal: string | undefined;
  if (held) {
    branch = held;
  } else if (opts.branch && opts.branch.trim()) {
    const checked = checkPlanBranch(opts.branch, setting, repo);
    branch = checked.branch;
    if (!checked.ok) refusal = checked.refusal;
  } else {
    const derived = integrationBranchName(chantier, { prefix });
    branch = (derived && freeBranch(derived, repo)) ?? `${prefix}<topic>`;
  }
  const named = branch.endsWith('<topic>')
    ? `Replace \`${branch}\` with a short English topic (letters, digits, dashes, no id) in every command. `
    : '';
  // An agent outside the project would create tasks the project's setting
  // never reaches: they name it.
  const taskProject = slug !== target.agentSlug ? slug : null;
  const carried = taskProject ? `Every command carries \`--project ${slug}\`: keep it. ` : '';
  const note = opts.sequential
    ? `Project ${slug} lands through a pull request into ${baseRef}. ${named}This job is coded in a mission, not by ` +
      `Kanban tasks. Its first command (\`timon pr branch\`) has the daemon cut the integration branch \`${branch}\` ` +
      `from ${baseRef} and answers with \`worktree\`, a folder of your own detached on that branch: code and commit ` +
      `only there (in sequential-new-mission, give that folder to the mission you spawn), never in the shared ` +
      `checkout, never on ${setting.target}, and nothing is merged into ${setting.target} locally. After each commit, ` +
      `move the branch by reference from the worktree: \`git push . HEAD:refs/heads/${branch}\`. Once the work is ` +
      `committed, run the last command (add \`--todo <id>\` when the job carries a TO DO idea${taskProject ? `, keep \`--project ${slug}\`` : ''}): ` +
      `it creates the task that opens the pull request (\`--landing pr\`). Then remove the worktree ` +
      `(\`git worktree remove <worktree>\`); a person merges the pull request on the forge.`
    : `Project ${slug} lands through a pull request into ${baseRef}. ${named}${carried}Every task of this job starts ` +
      `from the integration branch \`${branch}\`, which the daemon cuts from ${baseRef}: never from ` +
      `${setting.target}, and nothing is merged into ${setting.target} locally. The last command creates the ` +
      `task that opens the pull request (\`--landing pr\`); a person merges it on the forge.`;
  return {
    branch,
    chantier,
    baseRef,
    project: slug,
    prefix,
    locked: held !== null,
    ...(taskProject ? { taskProject } : {}),
    ...(refusal ? { refusal } : {}),
    note,
  };
}
