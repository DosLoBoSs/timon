/**
 * The publications proposed on a project's forge, as the daemon answers them
 * (`orchestrator/src/forge-proposals.ts`, routes
 * `/api/projects/:slug/forge-proposals`): the types, the calls, and which
 * proposal waits on which row.
 *
 * A write needs a signed-in person: the daemon refuses it from anyone else
 * (`person_required`), so nothing here ever publishes on its own.
 */
import { apiErrorMessage } from '@/lib/api-error';
import type { Answer } from './landing-api';
import type { Landing } from './landing-api';

export type ForgeProposalState = 'draft' | 'publishing' | 'published' | 'failed' | 'discarded';
export type ForgeProposalTrigger = 'person' | 'landing' | 'todo_resolved' | 'plugin';
export type ForgeTargetType = 'issue' | 'pull';

export type ForgeProposal = {
  id: string;
  project: string;
  repo: string;
  kind: 'comment';
  target: { type: ForgeTargetType; number: number; url: string };
  body: string;
  state: ForgeProposalState;
  trigger: ForgeProposalTrigger;
  /** The plugin that proposed it (`trigger: 'plugin'`, daemon API 19); absent from an older daemon. */
  plugin?: string | null;
  key: string;
  source_ref: string | null;
  /** The account it was published as, once published. */
  account: string | null;
  /** The comment on the forge, once published. */
  url: string | null;
  error: { code: string; reason: string | null } | null;
  created_at: number;
  updated_at: number;
  published_at: number | null;
};

/** Mirror of the daemon's `FORGE_PROPOSAL_BODY_LIMIT` (`ISSUE_COMMENT_LIMIT`). */
export const PROPOSAL_BODY_LIMIT = 8000;

/** What the daemon refuses in a text, checked before it is sent; null when it is fine. */
export function bodyProblem(body: string): 'empty' | 'tooLong' | 'control' | 'marker' | null {
  if (body.trim().length === 0) return 'empty';
  if (body.length > PROPOSAL_BODY_LIMIT) return 'tooLong';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body)) return 'control';
  if (body.includes('<!-- timon-proposal:')) return 'marker';
  return null;
}

/** Waiting for a person: a draft, or a failed attempt to try again. */
export function isPending(p: ForgeProposal): boolean {
  return p.state === 'draft' || p.state === 'failed';
}

const base = (project: string) => `/api/ui/projects/${encodeURIComponent(project)}/forge-proposals`;

async function call<T>(url: string, init: RequestInit | undefined, pick: (body: unknown) => T | undefined, fetchImpl: typeof fetch): Promise<Answer<T>> {
  try {
    const res = await fetchImpl(url, init ?? { cache: 'no-store' });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, message: apiErrorMessage(body, { status: res.status }) };
    const value = pick(body);
    return value === undefined || value === null ? { ok: false, message: apiErrorMessage(null) } : { ok: true, value };
  } catch {
    return { ok: false, message: apiErrorMessage(null) };
  }
}

const json = (method: string, body: unknown): RequestInit => ({
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const proposalOf = (b: unknown) => (b as { proposal?: ForgeProposal } | null)?.proposal;

export function listProposals(project: string, fetchImpl: typeof fetch = fetch): Promise<Answer<ForgeProposal[]>> {
  return call(base(project), undefined, (b) => (b as { proposals?: ForgeProposal[] } | null)?.proposals ?? [], fetchImpl);
}

export function getProposal(project: string, id: string, fetchImpl: typeof fetch = fetch): Promise<Answer<ForgeProposal>> {
  return call(`${base(project)}/${encodeURIComponent(id)}`, undefined, proposalOf, fetchImpl);
}

/** A person proposes a comment; a second one on the same target opens the draft already waiting. */
export function createProposal(
  project: string, target: { type: ForgeTargetType; number: number }, body: string, fetchImpl: typeof fetch = fetch,
): Promise<Answer<ForgeProposal>> {
  return call(base(project), json('POST', { kind: 'comment', target, body }), proposalOf, fetchImpl);
}

export function editProposal(project: string, id: string, body: string, fetchImpl: typeof fetch = fetch): Promise<Answer<ForgeProposal>> {
  return call(`${base(project)}/${encodeURIComponent(id)}`, json('PATCH', { body }), proposalOf, fetchImpl);
}

/** Publishes `body`, the text the person read. */
export function publishProposal(project: string, id: string, body: string, fetchImpl: typeof fetch = fetch): Promise<Answer<ForgeProposal>> {
  return call(`${base(project)}/${encodeURIComponent(id)}/publish`, json('POST', { body }), proposalOf, fetchImpl);
}

export function discardProposal(project: string, id: string, fetchImpl: typeof fetch = fetch): Promise<Answer<ForgeProposal>> {
  return call(`${base(project)}/${encodeURIComponent(id)}/discard`, json('POST', {}), proposalOf, fetchImpl);
}

/** The GitHub account the project publishes as, or null when none is set. */
export async function projectAccount(project: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const out = await call(
    `/api/ui/projects/${encodeURIComponent(project)}/integration`, undefined,
    (b) => ({ account: (b as { integration?: { account?: string | null } } | null)?.integration?.account ?? null }), fetchImpl,
  );
  return out.ok ? out.value.account : null;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const PR_REPO = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+$/;

/** The proposals waiting on a job's row: on its pull request, or on an issue it is linked to. */
export function proposalsForLanding(proposals: readonly ForgeProposal[], landing: Landing): ForgeProposal[] {
  const repo = landing.pr_url ? PR_REPO.exec(landing.pr_url)?.[1] ?? null : null;
  const issues = landing.links?.issues ?? [];
  return proposals.filter((p) => isPending(p) && p.project === landing.project && (
    p.target.type === 'pull'
      ? landing.pr_number === p.target.number && repo !== null && same(repo, p.repo)
      : issues.some((i) => i.number === p.target.number && same(i.repo, p.repo))
  ));
}

/** The proposals waiting on a pull request's row: on it, or on an issue it is linked to. */
export function proposalsForPull(
  proposals: readonly ForgeProposal[], repo: string, pull: { number: number; links?: { issues: ReadonlyArray<{ repo: string; number: number }> } },
): ForgeProposal[] {
  const issues = pull.links?.issues ?? [];
  return proposals.filter((p) => isPending(p) && same(p.repo, repo) && (
    p.target.type === 'pull'
      ? p.target.number === pull.number
      : issues.some((i) => i.number === p.target.number && same(i.repo, p.repo))
  ));
}
