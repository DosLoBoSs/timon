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
};

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

/** The row's main action: the preview while the job has something to land,
 *  its pull request once it is merged or closed (the preview is empty then). */
export function landingAction(landing: Landing): 'preview' | 'openPr' {
  return (landing.state === 'merged' || landing.state === 'closed') && landing.pr_url ? 'openPr' : 'preview';
}

/** The job of `branch` in `landings`, the latest touched when several remotes
 *  carry one; null when the list no longer has it. */
export function findLanding(landings: readonly Landing[], branch: string): Landing | null {
  return [...landings].filter((l) => l.branch === branch).sort((a, b) => b.updated_at - a.updated_at)[0] ?? null;
}
