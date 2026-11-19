/**
 * The scratch repository of a conflict resolution, against real git: the
 * merge without a working tree, the rebuilt tree, the commit that comes out
 * the same twice, the fast-forward push, and the environment nothing outside
 * the scratch folder can steer.
 */
import '../test-home.js';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BASE_URL, checkout, forgeFixture, FORK_URL } from '../../tests/helpers/forge-git-fixture.js';
import {
  gitVersionAtLeast, openScratchRepo, parseGitVersion, reopenScratchRepo, parseMergeTree, parseObjectsSize, parseSshHostName, scratchConfig, scratchEnv,
  type ScratchRepo,
} from './forge-scratch.js';

const T = 'a'.repeat(40);
const O = 'b'.repeat(40);

test('merge-tree -z: the tree, the stages of each conflicted path, then the messages', () => {
  const out = [
    T,
    `100644 ${O} 1\tdir/a b.txt`, `100644 ${O} 2\tdir/a b.txt`, `100644 ${O} 3\tdir/a b.txt`,
    '',
    '1', 'dir/a b.txt', 'Auto-merging', 'Auto-merging dir/a b.txt\n',
    '1', 'dir/a b.txt', 'CONFLICT (contents)', 'CONFLICT (contents): Merge conflict in dir/a b.txt\n',
    '',
  ].join('\0');
  const parsed = parseMergeTree(out, false);
  assert.equal(parsed?.tree, T);
  assert.deepEqual(parsed?.entries.map((e) => [e.stage, e.path]), [[1, 'dir/a b.txt'], [2, 'dir/a b.txt'], [3, 'dir/a b.txt']]);
  assert.deepEqual(parsed?.messages.map((m) => m.type), ['Auto-merging', 'CONFLICT (contents)']);
  assert.deepEqual(parseMergeTree(`${T}\n`, true), { tree: T, clean: true, entries: [], messages: [] });
  assert.equal(parseMergeTree('fatal: refusing', false), null);
  assert.equal(parseMergeTree([T, 'garbage', ''].join('\0'), false), null);
  assert.equal(parseMergeTree([T, '', '9', 'x', ''].join('\0'), false), null);
});

test('git version, object size', () => {
  assert.deepEqual(parseGitVersion('git version 2.43.0\n'), [2, 43]);
  assert.deepEqual(parseGitVersion('git version 2.39.1.windows.1'), [2, 39]);
  assert.equal(parseGitVersion('nope'), null);
  assert.equal(gitVersionAtLeast([2, 38]), true);
  assert.equal(gitVersionAtLeast([2, 37]), false);
  assert.equal(gitVersionAtLeast([3, 0]), true);
  assert.equal(parseObjectsSize('count: 3\nsize: 2\nin-pack: 9\nsize-pack: 10\nsize-garbage: 0\n'), 12 * 1024);
  assert.equal(parseObjectsSize('hello'), null);
});

test('ssh -G: the host an alias connects to', () => {
  assert.equal(parseSshHostName('user git\nhostname GitHub.com\nport 22\n'), 'github.com');
  assert.equal(parseSshHostName('user git\nport 22\n'), null);
});

test('the environment: no system or user configuration, no git variable of the daemon but SSH, no token', () => {
  const env = scratchEnv('/scratch/empty.gitconfig', '/home/u/.config/gh-work', {
    PATH: '/usr/bin', GIT_DIR: '/elsewhere', GIT_CONFIG_PARAMETERS: "'core.hooksPath'='/x'", GIT_SSH_COMMAND: 'ssh -i key',
    Git_Exec_Path: '/planted', GH_TOKEN: 'ghp_x', GITHUB_TOKEN: 'ghp_y', HOME: '/home/u',
  });
  assert.equal(env.GIT_DIR, undefined);
  assert.equal(env.GIT_CONFIG_PARAMETERS, undefined);
  assert.equal(env.Git_Exec_Path, undefined);
  assert.equal(env.GIT_SSH_COMMAND, 'ssh -i key');
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.GIT_CONFIG_GLOBAL, '/scratch/empty.gitconfig');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GH_CONFIG_DIR, '/home/u/.config/gh-work');
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  const config = scratchConfig('/scratch/empty.gitconfig');
  for (const pair of ['transfer.fsckObjects=true', 'protocol.file.allow=never', 'core.symlinks=false', 'commit.gpgSign=false', 'credential.helper=']) {
    assert.ok(config.includes(pair), pair);
  }
});

async function scratch(f: ReturnType<typeof forgeFixture>): Promise<ScratchRepo> {
  const repo = await openScratchRepo({ root: mkdtempSync(join(tmpdir(), 'timon-scratch-')), ghConfigDir: null, git: f.runner });
  assert.ok('dir' in repo, 'reason' in repo ? repo.reason : '');
  return repo;
}

/** main and the contributor's branch both changed `a.txt`; `b.txt` merges cleanly. */
function conflicting() {
  const f = forgeFixture({ 'a.txt': 'one\ntwo\nthree\n', 'b.txt': 'x\n', 'dir/c.txt': 'c\n' });
  const contrib = checkout(f, f.fork, 'fix/typo');
  f.commit(contrib, 'contributor', { 'a.txt': 'one\nTWO\nthree\n', 'dir/c.txt': 'C\n' });
  f.git(contrib, 'push', '-q', 'origin', 'fix/typo');
  const head = f.publishPull(7, 'fix/typo');
  const main = checkout(f, f.base, 'main');
  f.commit(main, 'main', { 'a.txt': 'one\n2\nthree\n', 'b.txt': 'y\n' });
  f.git(main, 'push', '-q', 'origin', 'main');
  return { f, head, contrib, main };
}

test('a conflict merged with objects only: stages, blobs, a rebuilt tree that differs only where resolved, the same commit twice', async () => {
  const { f, head } = conflicting();
  const repo = await scratch(f);
  try {
    const version = await repo.version();
    assert.ok(version && gitVersionAtLeast(version));
    assert.deepEqual(await repo.fetch(BASE_URL, ['refs/heads/main:refs/timon/base', 'refs/pull/7/head:refs/timon/head']), { ok: true });
    assert.equal(await repo.commitOf('refs/timon/head'), head);
    const base = (await repo.commitOf('refs/timon/base'))!;
    assert.ok((await repo.size())! > 0);

    const merged = await repo.mergeTree(head, base);
    assert.ok(merged.ok);
    assert.equal(merged.result.clean, false);
    assert.deepEqual([...new Set(merged.result.entries.map((e) => e.path))], ['a.txt']);
    assert.ok(merged.result.messages.some((m) => m.type === 'CONFLICT (contents)' && m.paths[0] === 'a.txt'));
    const ours = merged.result.entries.find((e) => e.stage === 2)!;
    assert.equal(await repo.readBlob(ours.oid, 1024), 'one\nTWO\nthree\n');
    assert.equal(await repo.readBlob(ours.oid, 4), null, 'a blob past the limit is not read');

    const resolved = (await repo.writeBlob('one\nTWO and 2\nthree\n'))!;
    const tree = (await repo.replaceInTree(merged.result.tree, [{ path: 'a.txt', mode: '100644', oid: resolved }]))!;
    assert.deepEqual(await repo.changedPaths(merged.result.tree, tree), ['a.txt']);
    const diff = await repo.diff(merged.result.tree, tree, 10_000);
    assert.match(diff!.text, /\+one\n|\+TWO and 2/);
    assert.equal(readdirSync(join(repo.dir, 'incoming')).length, 0, 'the text written for a blob does not stay');
    assert.equal(existsSync(join(repo.dir, 'index')), false, 'the private index does not stay');

    const who = { name: 'ai-bot', email: 'ai-bot@users.noreply.github.com' };
    const one = await repo.commitTree(tree, [head, base], 'merge: bring main into fix/typo', who, 1_700_000_000);
    const two = await repo.commitTree(tree, [head, base], 'merge: bring main into fix/typo', who, 1_700_000_000);
    assert.ok(one && one === two, 'the same inputs give the same commit');

    assert.deepEqual(await repo.remoteHead(FORK_URL, 'fix/typo'), { ok: true, sha: head });
    assert.deepEqual(await repo.push(FORK_URL, one, 'fix/typo'), { ok: true });
    assert.equal(f.head(f.fork, 'refs/heads/fix/typo'), one);
    assert.ok(f.calls.every((args) => !args.some((a) => /^--force|^\+/.test(a))), 'never forced');
  } finally {
    repo.dispose();
  }
  assert.equal(existsSync(repo.dir), false);
});

test('texts written at once through separate openings of one folder never share a file', async () => {
  const f = forgeFixture({ 'a.txt': 'a\n' });
  const repo = await scratch(f);
  try {
    // Every request reopens the folder: each opening is its own instance.
    const texts = Array.from({ length: 8 }, (_, i) => `text ${i}\n`.repeat(2000));
    const oids = await Promise.all(texts.map((text) => reopenScratchRepo(repo.dir, { root: '', ghConfigDir: null, git: f.runner })!.writeBlob(text)));
    for (const [i, oid] of oids.entries()) assert.equal(await repo.readBlob(oid!, 1_000_000), texts[i], `text ${i}`);
    assert.equal(readdirSync(join(repo.dir, 'incoming')).length, 0);
  } finally {
    repo.dispose();
  }
});

test('a push that is not a fast-forward is refused by git, and the branch is untouched', async () => {
  const { f, head, contrib } = conflicting();
  const repo = await scratch(f);
  try {
    await repo.fetch(BASE_URL, ['refs/heads/main:refs/timon/base', 'refs/pull/7/head:refs/timon/head']);
    const base = (await repo.commitOf('refs/timon/base'))!;
    const merged = await repo.mergeTree(head, base);
    assert.ok(merged.ok);
    const commit = (await repo.commitTree(merged.result.tree, [head, base], 'merge: x', { name: 'a', email: 'a@b' }, 1))!;
    // The contributor pushes in between.
    const moved = f.commit(contrib, 'again', { 'b.txt': 'z\n' });
    f.git(contrib, 'push', '-q', 'origin', 'fix/typo');
    const pushed = await repo.push(FORK_URL, commit, 'fix/typo');
    assert.ok(!pushed.ok && pushed.code === 'rejected', JSON.stringify(pushed));
    assert.equal(f.head(f.fork, 'refs/heads/fix/typo'), moved);
    for (const [sha, branch] of [[commit, '+fix/typo'], [commit, 'a:b'], ['HEAD', 'fix/typo']] as const) {
      assert.equal((await repo.push(FORK_URL, sha, branch)).ok, false);
    }
  } finally {
    repo.dispose();
  }
});

test('a clean merge says so; odd arguments never reach git', async () => {
  const f = forgeFixture({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
  const contrib = checkout(f, f.fork, 'feat');
  f.commit(contrib, 'c', { 'a.txt': 'A\n' });
  f.git(contrib, 'push', '-q', 'origin', 'feat');
  const head = f.publishPull(3, 'feat');
  const repo = await scratch(f);
  try {
    await repo.fetch(BASE_URL, ['refs/heads/main:refs/timon/base', 'refs/pull/3/head:refs/timon/head']);
    const merged = await repo.mergeTree(head, (await repo.commitOf('refs/timon/base'))!);
    assert.ok(merged.ok && merged.result.clean);
    const before = f.calls.length;
    assert.equal((await repo.fetch(BASE_URL, ['+refs/heads/main:refs/x'])).ok, false);
    assert.equal((await repo.mergeTree('HEAD', head)).ok, false);
    assert.equal(await repo.replaceInTree(merged.result.tree, [{ path: 'a,b', mode: '100644', oid: head }]), null);
    assert.equal(await repo.replaceInTree(merged.result.tree, [{ path: 'a', mode: '644', oid: head }]), null);
    assert.equal(await repo.commitTree('x', [], 'm', { name: 'a', email: 'a@b' }, 1), null);
    assert.equal((await repo.remoteHead(FORK_URL, '-x')).ok, false);
    assert.equal(f.calls.length, before);
  } finally {
    repo.dispose();
  }
});

test("through the host's own git: the local transport stays refused, objects-only commands run", async () => {
  const { f, head } = conflicting();
  const repo = await openScratchRepo({ root: mkdtempSync(join(tmpdir(), 'timon-scratch-host-')), ghConfigDir: null });
  assert.ok('dir' in repo, 'reason' in repo ? repo.reason : '');
  try {
    // A local path is no forge: the scratch repository never fetches one.
    assert.equal((await repo.fetch(f.base, ['refs/heads/main:refs/timon/base'])).ok, false);
    // The objects arrive the way a fetch would bring them (the fixture pushes them).
    f.git(f.root, `--git-dir=${f.base}`, 'push', '-q', join(repo.dir, 'repo.git'), 'refs/heads/main:refs/timon/base', `${head}:refs/timon/head`);
    const base = (await repo.commitOf('refs/timon/base'))!;
    assert.equal(await repo.commitOf('refs/timon/head'), head);
    const merged = await repo.mergeTree(head, base);
    assert.ok(merged.ok && !merged.result.clean);
    const blob = (await repo.writeBlob('one\nresolved\nthree\n'))!;
    const tree = (await repo.replaceInTree(merged.result.tree, [{ path: 'a.txt', mode: '100644', oid: blob }]))!;
    assert.deepEqual(await repo.changedPaths(merged.result.tree, tree), ['a.txt']);
    assert.ok(await repo.commitTree(tree, [head, base], 'merge: bring main into fix/typo', { name: 'a', email: 'a@b' }, 5));
  } finally {
    repo.dispose();
  }
});
