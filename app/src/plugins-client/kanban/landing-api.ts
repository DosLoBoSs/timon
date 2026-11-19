/**
 * The landing of Kanban jobs as the daemon answers it
 * (`orchestrator/src/integration-preview.ts`, routes `/api/kanban/landings`):
 * the types, the reads, and the small decisions the island takes on them.
 */
import { apiErrorMessage } from '@/lib/api-error';

export type LandingState = 'branch' | 'open' | 'merged' | 'closed';
export type CheckStatus = 'pass' | 'fail' | 'pending' | 'skipped';

export type LandingChecks = {
  read_at: number;
  draft: boolean;
  mergeable: 'mergeable' | 'conflicting' | 'unknown';
  review: 'approved' | 'changes_requested' | 'review_required' | null;
  counts: Record<CheckStatus, number>;
  items: Array<{ name: string; status: CheckStatus; url: string | null }>;
  /** Absent from an older daemon. */
  merge_state?: string;
  unresolved_threads?: number | null;
};

/** What a repair of one of our jobs fixes (`orchestrator/src/landing-repair.ts`). */
export type RepairKind = 'checks' | 'comments' | 'conflict';

/** The order a row offers them: a conflict first (the checks do not run on a
 *  branch that does not merge), then the checks, then the review. */
export const REPAIR_KINDS: readonly RepairKind[] = ['conflict', 'checks', 'comments'];

export type LandingRepair = {
  id: string;
  kind: RepairKind;
  state: 'running' | 'pushed' | 'unchanged' | 'failed';
  task_id: string;
  head_after: string | null;
  /** The daemon's own wording, in English. */
  error: string | null;
  created_at: number;
  updated_at: number;
};

/** The repairs of a job: the counter and what the forge last said needs one. */
export type LandingRepairs = {
  used: number;
  max: number;
  running: LandingRepair | null;
  last: LandingRepair | null;
  needs: RepairKind[];
};

/** An idea a job carries (`orchestrator/src/forge-links.ts`), among those the reader sees. */
export type LinkedTodo = {
  id: number;
  /** At most 300 characters. */
  text: string;
  status: string;
  progress: string | null;
  project: string | null;
};

/** An issue a job touches. `closes`: the pull request's description says so
 *  (its author's claim); otherwise one of our ideas is linked to it. */
export type LinkedIssue = {
  repo: string;
  number: number;
  url: string | null;
  todo_id: number | null;
  closes: boolean;
};

/** The way back from a job to its ideas, issues and pilot mission. */
export type JobLinks = {
  todos: LinkedTodo[];
  issues: LinkedIssue[];
  series_id: string | null;
  /** The mission piloting the job's series, when the reader may open it. */
  pilot_mission_id: string | null;
};

export const NO_LINKS: JobLinks = { todos: [], issues: [], series_id: null, pilot_mission_id: null };

export type Landing = {
  id: string;
  project: string | null;
  series_id: string | null;
  branch: string;
  remote: string;
  target: string;
  mode: string;
  state: LandingState;
  pr_number: number | null;
  pr_url: string | null;
  head_sha: string | null;
  merge_sha: string | null;
  landed: boolean;
  created_at: number;
  updated_at: number;
  checks: LandingChecks | null;
  conflict: boolean | null;
  checks_running: boolean;
  pr_title: string | null;
  /** Absent from an older daemon. */
  links?: JobLinks;
  /** Absent from an older daemon. */
  repairs?: LandingRepairs;
};

export type PrecheckName =
  | 'branch_name' | 'account' | 'remote_url' | 'target' | 'commits' | 'commit_identity'
  | 'commit_messages' | 'pr_text' | 'private_paths' | 'public_tree' | 'remote_branch';

export type Precheck = { name: PrecheckName; ok: boolean; skipped?: boolean; detail: string };

export type PreviewFile = {
  path: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  patch: string | null;
  patch_truncated: boolean;
};

export type LandingPreview = {
  integration: Landing;
  head_sha: string | null;
  target_sha: string | null;
  problem: string | null;
  commit_count: number;
  commits: Array<{ sha: string; short: string; author: string; subject: string }>;
  commits_truncated: boolean;
  files: PreviewFile[];
  files_truncated: boolean;
  patch_truncated: boolean;
  totals: { files: number; additions: number; deletions: number };
  conflict: { state: 'clean' | 'conflicting' | 'unknown'; files: string[] };
  pull_request: { title: string; body: string } | null;
  prechecks: { ran: true; ready: boolean; checks: Precheck[] } | { ran: false; reason: string };
};

/** How often the island asks for the checks while one of them runs. */
export const CHECKS_REFRESH_MS = 60_000;

export type Answer<T> = { ok: true; value: T } | { ok: false; message: string };

async function answer<T>(res: Response, pick: (body: unknown) => T): Promise<Answer<T>> {
  const body: unknown = await res.json().catch(() => null);
  return res.ok ? { ok: true, value: pick(body) } : { ok: false, message: apiErrorMessage(body, { status: res.status }) };
}

function failure(): { ok: false; message: string } {
  return { ok: false, message: apiErrorMessage(null) };
}

const BASE = '/api/ui/kanban/landings';

export async function listLandings(project: string | null, fetchImpl: typeof fetch = fetch): Promise<Answer<Landing[]>> {
  const query = project ? `?project=${encodeURIComponent(project)}` : '';
  try {
    return await answer(await fetchImpl(`${BASE}${query}`, { cache: 'no-store' }), (b) => (b as { landings?: Landing[] }).landings ?? []);
  } catch {
    return failure();
  }
}

/** One job, with its links: what an idea's badge opens. */
export async function getLanding(id: string, fetchImpl: typeof fetch = fetch): Promise<Answer<Landing>> {
  try {
    const out = await answer(await fetchImpl(`${BASE}/${encodeURIComponent(id)}`, { cache: 'no-store' }), (b) => (b as { landing?: Landing }).landing);
    return out.ok && !out.value ? failure() : out as Answer<Landing>;
  } catch {
    return failure();
  }
}

/** Asks the daemon for the forge's checks; it answers its stored copy when
 *  they were read less than a minute ago. */
export async function refreshLandingChecks(id: string, fetchImpl: typeof fetch = fetch): Promise<Answer<Landing>> {
  try {
    const res = await fetchImpl(`${BASE}/${encodeURIComponent(id)}/checks`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    return await answer(res, (b) => (b as { landing: Landing }).landing);
  } catch {
    return failure();
  }
}

/**
 * Asks the daemon to repair the job's pull request: it reads the forge again,
 * refuses when there is nothing of that kind to fix, and otherwise starts a
 * `code` task on the job's branch. Answers the job with its new counter.
 */
export async function requestLandingRepair(id: string, kind: RepairKind, fetchImpl: typeof fetch = fetch): Promise<Answer<Landing>> {
  try {
    const res = await fetchImpl(`${BASE}/${encodeURIComponent(id)}/repairs`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind }),
    });
    return await answer(res, (b) => (b as { landing: Landing }).landing);
  } catch {
    return failure();
  }
}

export async function previewLanding(id: string, fetchImpl: typeof fetch = fetch): Promise<Answer<LandingPreview>> {
  try {
    const res = await fetchImpl(`${BASE}/${encodeURIComponent(id)}/preview`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    return await answer(res, (b) => b as LandingPreview);
  } catch {
    return failure();
  }
}

/** Open pull requests whose checks should be asked again now. */
export function landingsToRefresh(landings: readonly Landing[]): Landing[] {
  return landings.filter((l) => l.state === 'open' && (l.checks === null || l.checks_running));
}

export type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'context';

/** How one line of a unified diff is painted. */
export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git')
    || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file')
    || line.startsWith('Binary files') || line.startsWith('similarity') || line.startsWith('old mode')
    || line.startsWith('new mode')) return 'meta';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'context';
}

/** The lines of a file's patch the reader needs: from the first hunk on. */
export function patchBody(patch: string): string[] {
  const lines = patch.split('\n');
  const first = lines.findIndex((l) => l.startsWith('@@') || l.startsWith('Binary files'));
  return first === -1 ? lines : lines.slice(first);
}

/**
 * The groups of the jobs widget, in the order they show: what calls for a
 * gesture first, then what waits on the forge, then what is not pushed yet,
 * then what landed lately. Groups, not columns: a rail is 300 px wide.
 */
export type LandingGroup = 'attention' | 'review' | 'progress' | 'landed';

export const LANDING_GROUPS: readonly LandingGroup[] = ['attention', 'review', 'progress', 'landed'];

/** How long a landed job stays in its group, and a closed one in "attention". */
export const LANDED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The group of `landing` at `now`; null once it is old news. An open pull
 * request needs attention when a check fails, it conflicts with its target or
 * a reviewer asked for changes. A pull request closed without its merge
 * needs a decision (reopen it, or drop the job) for a week, then leaves.
 */
export function landingGroup(landing: Landing, now: number): LandingGroup | null {
  const recent = now - landing.updated_at <= LANDED_WINDOW_MS;
  switch (landing.state) {
    case 'branch': return 'progress';
    case 'merged': return recent ? 'landed' : null;
    case 'closed': return recent ? 'attention' : null;
    case 'open': {
      const checks = landing.checks;
      const failing = !!checks && checks.counts.fail > 0;
      const conflict = landing.conflict === true || checks?.mergeable === 'conflicting';
      return failing || conflict || checks?.review === 'changes_requested' ? 'attention' : 'review';
    }
  }
}

/** The non-empty groups of `landings`, each newest first. */
export function groupLandings(landings: readonly Landing[], now: number): Array<{ group: LandingGroup; landings: Landing[] }> {
  const byGroup = new Map<LandingGroup, Landing[]>();
  for (const landing of landings) {
    const group = landingGroup(landing, now);
    if (!group) continue;
    byGroup.set(group, [...(byGroup.get(group) ?? []), landing]);
  }
  return LANDING_GROUPS
    .filter((group) => byGroup.has(group))
    .map((group) => ({ group, landings: byGroup.get(group)!.sort((a, b) => b.updated_at - a.updated_at) }));
}

/** Whether a person may ask for one more repair now: an open pull request,
 *  none under way, the cap not reached. */
export function canRepair(landing: Landing): boolean {
  const r = landing.repairs;
  return !!r && landing.state === 'open' && r.running === null && r.used < r.max;
}

/** The repairs the forge calls for, in the order a row offers them. */
export function repairsNeeded(landing: Landing): RepairKind[] {
  const needs = landing.state === 'open' ? landing.repairs?.needs ?? [] : [];
  return REPAIR_KINDS.filter((k) => needs.includes(k));
}

/** The repair the row offers as its main action, if one may start now. */
export function mainRepair(landing: Landing): RepairKind | null {
  return canRepair(landing) ? repairsNeeded(landing)[0] ?? null : null;
}

/** Repairs are spent while the forge still asks for one: a person takes the job over. */
export function repairsSpent(landing: Landing): boolean {
  const r = landing.repairs;
  return !!r && r.running === null && r.used >= r.max && repairsNeeded(landing).length > 0;
}

/** The row's main action: the repair the forge calls for when one may start,
 *  else the preview while the job has something to land, its pull request
 *  once it is merged or closed (the preview is empty then). */
export function landingAction(landing: Landing): 'repair' | 'preview' | 'openPr' {
  if (mainRepair(landing)) return 'repair';
  return (landing.state === 'merged' || landing.state === 'closed') && landing.pr_url ? 'openPr' : 'preview';
}

/** The job of `branch` in `landings`, the latest touched when several remotes
 *  carry one; null when the list no longer has it. */
export function findLanding(landings: readonly Landing[], branch: string): Landing | null {
  return [...landings].filter((l) => l.branch === branch).sort((a, b) => b.updated_at - a.updated_at)[0] ?? null;
}
