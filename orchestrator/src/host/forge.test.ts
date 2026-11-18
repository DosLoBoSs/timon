import '../test-home.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertNoForce, githubForge, githubRepoFromUrl, gitTransport, pushArguments, redactedOutput, type GitRunner,
} from './forge.js';
import type { GhRunner } from './gh.js';
import type { ExecOpts } from './types.js';

type Answer = { code?: number; stdout?: string; stderr?: string; timedOut?: boolean } | 'missing';

function recorder(answer: Answer) {
  const calls: Array<{ args: string[]; opts: ExecOpts }> = [];
  const run: GhRunner & GitRunner = async (args, opts) => {
    calls.push({ args, opts });
    if (answer === 'missing') throw new Error('binary not found');
    return { code: answer.code ?? 0, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '', timedOut: answer.timedOut };
  };
  return { run, calls };
}

test('the repository of a GitHub push URL, ssh alias included', () => {
  assert.equal(githubRepoFromUrl('git@github.com:acme/app.git'), 'acme/app');
  assert.equal(githubRepoFromUrl('git@github-work:acme/app.git'), 'acme/app');
  assert.equal(githubRepoFromUrl('ssh://git@github.com/acme/app.git'), 'acme/app');
  assert.equal(githubRepoFromUrl('https://github.com/acme/app'), 'acme/app');
  assert.equal(githubRepoFromUrl('https://github.com/acme/app.git/'), 'acme/app');
  assert.equal(githubRepoFromUrl('/srv/git/app.git'), null);
  assert.equal(githubRepoFromUrl('https://github.com/acme'), null);
  assert.equal(githubRepoFromUrl('git@github.com:../app.git'), null);
});

test('a push is never forced, whatever arguments are tried', () => {
  for (const bad of [['--force'], ['-f'], ['--force-with-lease'], ['--force-with-lease=main'], ['--mirror'], ['--delete'], ['-d'], ['--tags']]) {
    assert.throws(() => assertNoForce(bad), /forced push/, JSON.stringify(bad));
  }
  assert.throws(() => assertNoForce(['--', 'url', '+refs/heads/a:refs/heads/a']), /forced push/);
  assert.throws(() => assertNoForce(['--', 'url', ':refs/heads/a']), /forced push/);
  assert.deepEqual(pushArguments('git@github.com:acme/app.git', 'feat/x'), ['--', 'git@github.com:acme/app.git', 'refs/heads/feat/x:refs/heads/feat/x']);
  for (const branch of ['+feat/x', '-f', 'a:b', 'feat/x y', 'a..b']) {
    assert.throws(() => pushArguments('u', branch), /unusual name/, branch);
  }
});

test('the push runs plain git push, without a prompt, and reports a rejection as such', async () => {
  const ok = recorder({});
  assert.deepEqual(await gitTransport('/repo', { git: ok.run }).pushBranch('git@github.com:acme/app.git', 'feat/x'), { ok: true });
  assert.deepEqual(ok.calls[0]?.args, ['-C', '/repo', 'push', '--', 'git@github.com:acme/app.git', 'refs/heads/feat/x:refs/heads/feat/x']);
  assert.equal(ok.calls[0]?.opts.env?.GIT_TERMINAL_PROMPT, '0');
  assert.ok(!ok.calls[0]?.args.some((a) => /force|^\+/.test(a)));

  const rejected = recorder({ code: 1, stderr: ' ! [rejected]        feat/x -> feat/x (non-fast-forward)' });
  const out = await gitTransport('/repo', { git: rejected.run }).pushBranch('u', 'feat/x');
  assert.equal(out.ok, false);
  assert.equal(out.ok ? '' : out.code, 'rejected');

  const unusual = recorder({});
  assert.equal((await gitTransport('/repo', { git: unusual.run }).pushBranch('u', '+feat/x')).ok, false);
  assert.equal(unusual.calls.length, 0, 'an unusual name never reaches git');
});

test('the remote branch is read with ls-remote; absent is null, a failure is not "absent"', async () => {
  const sha = 'a'.repeat(40);
  const there = recorder({ stdout: `${sha}\trefs/heads/feat/x\n` });
  assert.deepEqual(await gitTransport('/repo', { git: there.run }).remoteBranchSha('u', 'feat/x'), { ok: true, sha });
  assert.deepEqual(there.calls[0]?.args, ['-C', '/repo', 'ls-remote', '--heads', '--', 'u', 'refs/heads/feat/x']);
  const absent = recorder({ stdout: '' });
  assert.deepEqual(await gitTransport('/repo', { git: absent.run }).remoteBranchSha('u', 'feat/x'), { ok: true, sha: null });
  const down = recorder({ code: 128, stderr: 'fatal: Could not read from remote repository.' });
  assert.equal((await gitTransport('/repo', { git: down.run }).remoteBranchSha('u', 'feat/x')).ok, false);
});

test('a fetch never forces the local ref', async () => {
  const run = recorder({});
  await gitTransport('/repo', { git: run.run }).fetchBranch('u', 'main', 'refs/remotes/origin/main');
  assert.deepEqual(run.calls[0]?.args, ['-C', '/repo', 'fetch', '--no-tags', '--', 'u', 'refs/heads/main:refs/remotes/origin/main']);
});

test('gh pr create gets the branches, title and body, with the project folder and no token', async () => {
  const run = recorder({ stdout: 'https://github.com/acme/app/pull/42\n' });
  const forge = githubForge('/home/u/.config/gh-work', { gh: run.run });
  const out = await forge.createPullRequest({ repo: 'acme/app', base: 'main', head: 'feat/x', title: 'Add x', body: 'Why x.' });
  assert.deepEqual(out, { ok: true, pr: { number: 42, url: 'https://github.com/acme/app/pull/42' }, existing: false });
  assert.deepEqual(run.calls[0]?.args, [
    'pr', 'create', '--repo=acme/app', '--base=main', '--head=feat/x', '--title=Add x', '--body=Why x.',
  ]);
  const dashed = recorder({ stdout: 'https://github.com/acme/app/pull/43\n' });
  await githubForge(null, { gh: dashed.run }).createPullRequest({ repo: 'acme/app', base: 'main', head: 'feat/x', title: '--admin', body: '-f' });
  assert.ok(dashed.calls[0]?.args.includes('--title=--admin') && !dashed.calls[0]?.args.includes('--admin'), 'a value never becomes a flag');
  assert.equal(run.calls[0]?.opts.env?.GH_CONFIG_DIR, '/home/u/.config/gh-work');
  assert.ok(!run.calls[0]?.args.includes('--admin'));
});

test('a pull request already open for the branch is returned, other failures are refusals', async () => {
  const exists = recorder({ code: 1, stderr: 'a pull request for branch "feat/x" into branch "main" already exists:\nhttps://github.com/acme/app/pull/7\n' });
  assert.deepEqual(
    await githubForge(null, { gh: exists.run }).createPullRequest({ repo: 'a/b', base: 'main', head: 'feat/x', title: 't', body: '' }),
    { ok: true, pr: { number: 7, url: 'https://github.com/acme/app/pull/7' }, existing: true },
  );
  const input = { repo: 'a/b', base: 'main', head: 'feat/x', title: 't', body: '' };
  assert.equal((await githubForge(null, { gh: recorder('missing').run }).createPullRequest(input)).ok, false);
  assert.equal((await githubForge(null, { gh: recorder({ timedOut: true, code: 1 }).run }).createPullRequest(input)).ok, false);
  assert.equal((await githubForge(null, { gh: recorder({ stdout: 'done' }).run }).createPullRequest(input)).ok, false);
  const leaked = await githubForge(null, { gh: recorder({ code: 1, stderr: `bad credentials ghp_${'x'.repeat(36)}` }).run }).createPullRequest(input);
  assert.ok(!leaked.ok && !leaked.reason.includes('ghp_'), 'a token never comes back');
});

test('credentials are masked in what a command printed', () => {
  assert.equal(redactedOutput('fatal: https://user:tok@github.com/a/b'), 'fatal: https://[redacted]@github.com/a/b');
});
