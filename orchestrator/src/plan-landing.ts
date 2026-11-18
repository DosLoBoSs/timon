/**
 * How the job a series plan (`kanban_plan`) launches will land, read from the
 * project of the agent that opened the planner (`docs/KANBAN-PR-PIPELINE.md`
 * §2.2, step 8 of §8).
 *
 * A project set to land through pull requests gets one integration branch per
 * job, named after the job's title: the plan's commands give it to every task
 * (`--base`) and end with the task that opens the pull request. Any other
 * project, or an agent outside one, gets null: the plan stays what it was.
 */
import { loadConfig } from './agent-config.js';
import { dbApi } from './db.js';
import { integrationBranchName, integrationBranchRefusal } from './git-integration.js';
import { integrationBaseRef, readProjectIntegration } from './project-integration.js';
import type { SeriesPlanLanding } from './series-plan.js';
import { taskProjectSlug } from './task-project.js';

export type PlanLanding = SeriesPlanLanding & {
  /** `origin/main`: what the branch is cut from and the pull request targets. */
  baseRef: string;
  /** What the orchestrator must know before it applies the plan. */
  note: string;
};

/** Beyond this, the title is too generic to name a job: the caller names it. */
const MAX_SUFFIX = 20;

/**
 * The branch of a new job: the title's slug, with `-2`, `-3`… when Timon already
 * recorded that branch for an earlier job of the repository, so two jobs never
 * share one pull request.
 */
function freeBranch(base: string, repo: string | null): string | null {
  if (!repo) return base;
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (integrationBranchRefusal(name)) return null;
    if (!dbApi.getIntegration(repo, name)) return name;
  }
  return null;
}

export function planLanding(agentName: string, chantier: string): PlanLanding | null {
  let cfg: ReturnType<typeof loadConfig> | null = null;
  try { cfg = loadConfig(agentName); } catch { return null; }
  const slug = taskProjectSlug({}, cfg);
  if (!slug) return null;
  let read: ReturnType<typeof readProjectIntegration>;
  try { read = readProjectIntegration(slug); } catch { return null; }
  // A broken setting is refused at dispatch, with its reason, on the first task.
  if (read.invalid || read.integration.mode !== 'pr') return null;
  const setting = read.integration;
  const baseRef = integrationBaseRef(setting);
  const repo = dbApi.getProjectRow(slug)?.cwd ?? cfg.cwd ?? null;
  const derived = integrationBranchName(chantier, { prefix: setting.branch_prefix });
  const branch = (derived && freeBranch(derived, repo)) ?? `${setting.branch_prefix}<topic>`;
  const named = branch.endsWith('<topic>')
    ? `Replace \`${branch}\` with a short English topic (letters, digits, dashes, no id) in every command. `
    : '';
  return {
    branch,
    chantier,
    baseRef,
    note:
      `Project ${slug} lands through a pull request into ${baseRef}. ${named}Every task of this job starts ` +
      `from the integration branch \`${branch}\`, which the daemon cuts from ${baseRef}: never from ` +
      `${setting.target}, and nothing is merged into ${setting.target} locally. The last command creates the ` +
      `task that opens the pull request (\`--landing pr\`); a person merges it on the forge.`,
  };
}
