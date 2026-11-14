import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-git-neutral-'));
const HOME = process.env.TIMON_HOME;

const { TimonConfigSchema } = await import('../config/schema.js');
const { createGenericHost } = await import('./generic.js');
const {
  gitHooksNoneDir, gitScanArgs, neutralGitCall, neutralGitEnv, parseGitConfigList, scannedGitConfig,
} = await import('./git-neutral.js');

const host = createGenericHost(TimonConfigSchema.parse({}));
const hasGit = spawnSync('git', ['--version']).status === 0;

test('parseGitConfigList reads scoped and plain listings, a bare key included', () => {
  assert.deepEqual(parseGitConfigList('global\0user.name\nA B\0local\0core.bare\0', true), [
    { scope: 'global', key: 'user.name', value: 'A B' },
    { scope: 'local', key: 'core.bare', value: null },
  ]);
  assert.deepEqual(parseGitConfigList('a.b\nx\ny\0', false), [{ scope: 'unknown', key: 'a.b', value: 'x\ny' }]);
});

test('gitScanArgs skips pure ref reads and keeps where git works', () => {
  assert.equal(gitScanArgs(['-C', '/r', 'rev-parse', 'HEAD']), null);
  assert.equal(gitScanArgs(['--version']), null);
  assert.deepEqual(gitScanArgs(['-C', '/r', '-c', 'x.y=1', 'status'])?.scoped,
    ['-C', '/r', '--no-pager', 'config', '--list', '-z', '--show-scope']);
  assert.deepEqual(gitScanArgs(['--git-dir=/r/.git', 'merge', 'x'])?.plain,
    ['--git-dir=/r/.git', '--no-pager', 'config', '--list', '-z']);
});

test('a command a mission wrote is replaced, the trusted one kept', () => {
  const { config, env } = scannedGitConfig([
    { scope: 'global', key: 'core.sshcommand', value: 'ssh -i key' },
    { scope: 'local', key: 'core.sshcommand', value: 'evil' },
    { scope: 'local', key: 'filter.x.clean', value: 'evil' },
    { scope: 'global', key: 'filter.lfs.clean', value: 'git-lfs clean -- %f' },
    { scope: 'local', key: 'filter.lfs.smudge', value: 'git-lfs smudge -- %f' },
    { scope: 'local', key: 'merge.ours.driver', value: 'true' },
    { scope: 'worktree', key: 'merge.m.driver', value: 'evil %A' },
    { scope: 'global', key: 'credential.helper', value: '' },
    { scope: 'global', key: 'credential.helper', value: 'store' },
    { scope: 'local', key: 'credential.helper', value: '!evil' },
    { scope: 'local', key: 'remote.origin.uploadpack', value: 'evil' },
    { scope: 'local', key: 'remote.origin.url', value: '/elsewhere' },
    { scope: 'local', key: 'core.gitproxy', value: 'evil' },
  ]);
  assert.deepEqual(config, [
    'core.sshcommand=ssh -i key',
    'filter.x.clean=',
    'merge.m.driver=git merge-file --marker-size=%L %A %O %B',
    'credential.helper=',
    'credential.helper=',
    'credential.helper=store',
    'filter.x.required=false',
  ]);
  assert.deepEqual(env, { GIT_PROXY_COMMAND: '' });
});

// `remote.<name>.uploadpack` keeps the first value git reads: only the
// command-line option outranks a planted one.
test('a planted upload-pack or receive-pack is overridden on the command line', () => {
  const entries = [
    { scope: 'local', key: 'remote.origin.uploadpack', value: 'evil' },
    { scope: 'local', key: 'remote.origin.receivepack', value: 'evil' },
  ];
  const fetch = neutralGitCall(['-C', '/r', 'fetch', 'origin'], entries, {});
  assert.ok(!('refused' in fetch) && fetch.args.join(' ').endsWith('fetch --upload-pack=git-upload-pack origin'));
  const push = neutralGitCall(['push', 'origin', 'main'], entries, {});
  assert.ok(!('refused' in push) && push.args.join(' ').endsWith('push --receive-pack=git-receive-pack origin main'));
  assert.ok('refused' in neutralGitCall(['remote', 'update'], entries, {}));
  const status = neutralGitCall(['status'], entries, {});
  assert.ok(!('refused' in status) && !status.args.some((a) => a.startsWith('--upload-pack')));
});

test('a key that -c cannot reach refuses the call', () => {
  const entries = [{ scope: 'local', key: 'credential.https://a=b.helper', value: '!evil' }];
  assert.equal(scannedGitConfig(entries).refused, 'credential.https://a=b.helper');
  assert.ok('refused' in neutralGitCall(['push'], entries, {}));
});

test('alternate refs, configured hooks and Git LFS programs a mission named are neutralized', () => {
  const alt = scannedGitConfig([{ scope: 'local', key: 'core.alternaterefscommand', value: 'evil' }]);
  assert.deepEqual(alt.config, [`core.alternaterefscommand=git --git-dir="$1" for-each-ref --format='%(objectname)' #`]);
  assert.equal(scannedGitConfig([{ scope: 'worktree', key: 'hook.pre-commit.command', value: 'evil' }]).refused, 'hook.pre-commit.command');
  assert.equal(scannedGitConfig([{ scope: 'global', key: 'hook.x.command', value: 'mine' }]).refused, undefined);
  const lfs = scannedGitConfig([
    { scope: 'global', key: 'filter.lfs.process', value: 'git-lfs filter-process' },
    { scope: 'local', key: 'lfs.customtransfer.t.path', value: 'evil' },
  ]);
  assert.deepEqual(lfs.config, ['filter.lfs.clean=', 'filter.lfs.smudge=', 'filter.lfs.process=', 'filter.lfs.required=false']);
  assert.deepEqual(scannedGitConfig([{ scope: 'global', key: 'lfs.customtransfer.t.path', value: 'mine' }]).config, []);
});

test('the local transport is refused, whatever the environment says', () => {
  const fixed = neutralGitCall(['rev-parse', 'HEAD'], null, {});
  assert.ok(!('refused' in fixed) && fixed.args.includes('protocol.file.allow=never'));
  // It would replace the protocol policy with its own list.
  const call = neutralGitCall(['push'], [], { GIT_ALLOW_PROTOCOL: 'file:ext', PATH: '/usr/bin' }, { platform: 'linux' });
  assert.ok(!('refused' in call) && call.env.GIT_ALLOW_PROTOCOL === undefined);
  const win = neutralGitCall(['push'], [], { Git_Allow_Protocol: 'file' }, { platform: 'win32' });
  assert.ok(!('refused' in win) && !Object.keys(win.env).some((k) => k.toUpperCase() === 'GIT_ALLOW_PROTOCOL'));
});

test('neutralGitCall fixes hooks, fsmonitor, pager, and diff drivers', () => {
  const call = neutralGitCall(['-C', '/r', 'diff', '--numstat', 'HEAD'], null, { PATH: '/usr/bin' });
  assert.ok(!('refused' in call));
  if ('refused' in call) return;
  assert.equal(call.args[0], '--no-pager');
  assert.ok(call.args.includes('core.fsmonitor=false'));
  assert.ok(call.args.includes(`core.hooksPath=${gitHooksNoneDir()}`));
  const diff = call.args.indexOf('diff');
  assert.deepEqual(call.args.slice(diff, diff + 4), ['diff', '--no-ext-diff', '--no-textconv', '--numstat']);
  const status = neutralGitCall(['status'], null, {});
  assert.ok(!('refused' in status) && !status.args.includes('--no-ext-diff'));
});

test('the PATH git gets loses every folder a mission can write', () => {
  const sep = process.platform === 'win32' ? ';' : delimiter;
  const kept = join(HOME, 'plugins', 'x', 'bin');
  const env = neutralGitEnv({
    PATH: ['', '.', join(HOME, 'worktrees', 't', 'bin'), kept, join(tmpdir(), 'elsewhere')].join(sep),
  });
  assert.deepEqual(env.PATH?.split(sep), [kept, join(tmpdir(), 'elsewhere')]);
});

/** Every witness `trappedRepo` plants. */
const WITNESSES = [
  'alternate-refs', 'filter', 'fsmonitor', 'gpg', 'hook-post-checkout', 'hook-pre-commit',
  'hook-reference-transaction', 'merge-driver', 'planted-helper', 'pre-receive', 'uploadpack',
];

/** A repository whose configuration runs a witness for every hook, driver and
 *  helper git can be asked to run, and two local remotes. */
function trappedRepo(): { root: string; repo: string; env: NodeJS.ProcessEnv; witnesses: () => string[] } {
  const root = mkdtempSync(join(tmpdir(), 'timon-git-trap-'));
  const seen = join(root, 'seen');
  mkdirSync(seen);
  const touch = (name: string) => `touch '${join(seen, name).replaceAll('\\', '/')}'`;
  const globalFile = join(root, 'global.gitconfig');
  // The user's own credential helper: it must keep running.
  writeFileSync(globalFile, `[user]\n\tname = T\n\temail = t@example.com\n[credential]\n\thelper = "!${touch('trusted-helper')}; :"\n[init]\n\tdefaultBranch = main\n`);
  const env: NodeJS.ProcessEnv = {
    ...process.env, GIT_CONFIG_GLOBAL: globalFile, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    LANGUAGE: 'C', LC_ALL: 'C',
  };
  delete env.GIT_ALLOW_PROTOCOL;
  const run = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const repo = join(root, 'repo');
  const git = (...args: string[]) => run(repo, ...args);
  mkdirSync(repo);
  git('init', '-q');
  writeFileSync(join(repo, 'f.txt'), 'base\n');
  git('add', 'f.txt');
  git('commit', '-qm', 'base');
  git('branch', 'side');
  writeFileSync(join(repo, 'f.txt'), 'main\n');
  git('commit', '-qam', 'main');
  git('checkout', '-q', 'side');
  writeFileSync(join(repo, 'f.txt'), 'side\n');
  git('commit', '-qam', 'side');
  git('checkout', '-q', 'main');
  const upstream = join(root, 'upstream');
  run(root, 'clone', '-q', '--bare', repo, upstream);
  // Something to fetch, so the fetch negotiates (and asks the alternates).
  const extra = run(upstream, 'commit-tree', '-p', 'main', '-m', 'extra', 'main^{tree}');
  run(upstream, 'update-ref', 'refs/heads/extra', extra);
  const other = join(root, 'other');
  run(root, 'clone', '-q', '--bare', repo, other);
  // A bare repository a mission prepared where it can write (a temporary
  // folder), to receive the daemon's push.
  const drop = join(root, 'drop');
  run(root, 'init', '-q', '--bare', drop);
  writeFileSync(join(drop, 'hooks', 'pre-receive'), `#!/bin/sh\n${touch('pre-receive')}\n`, { mode: 0o755 });

  // What a mission writes into the repository it works in.
  writeFileSync(join(repo, '.gitattributes'), '* filter=trap merge=trap\n');
  git('config', 'core.fsmonitor', `${touch('fsmonitor')}; exit 1`);
  git('config', 'filter.trap.clean', `${touch('filter')}; cat`);
  git('config', 'filter.trap.smudge', `${touch('filter')}; cat`);
  git('config', 'filter.trap.required', 'true');
  git('config', 'merge.trap.driver', `${touch('merge-driver')}; false`);
  git('config', 'credential.helper', `!${touch('planted-helper')}; :`);
  git('remote', 'add', 'origin', upstream);
  git('config', 'remote.origin.uploadpack', `${touch('uploadpack')}; git-upload-pack`);
  git('remote', 'add', 'drop', drop);
  git('config', 'commit.gpgSign', 'true');
  // git starts `gpg.program` without a shell: a script stands in for it.
  const gpg = join(root, 'gpg-trap');
  writeFileSync(gpg, `#!/bin/sh\n${touch('gpg')}\nexit 1\n`, { mode: 0o755 });
  git('config', 'gpg.program', gpg);
  writeFileSync(join(repo, '.git', 'objects', 'info', 'alternates'), `${join(other, 'objects')}\n`);
  git('config', 'core.alternateRefsCommand', `${touch('alternate-refs')}; true`);
  for (const hook of ['pre-commit', 'pre-merge-commit', 'post-merge', 'reference-transaction', 'post-checkout']) {
    writeFileSync(join(repo, '.git', 'hooks', hook), `#!/bin/sh\n${touch(`hook-${hook}`)}\n`, { mode: 0o755 });
  }
  writeFileSync(join(repo, 'f.txt'), 'main\n'); // a stat change: status must hash the file
  return { root, repo, env, witnesses: () => readdirSync(seen).sort() };
}

/** What the daemon does in a repository, in the order it would. */
async function gestures(t: ReturnType<typeof trappedRepo>, git: (args: string[], input?: string) => Promise<{ code: number; stderr: string }>) {
  const r = (args: string[], input?: string) => git(['-C', t.repo, ...args], input);
  return {
    status: await r(['status', '--porcelain']),
    diff: await r(['diff', '--numstat', 'HEAD']),
    checkout: await r(['checkout', 'side']),
    back: await r(['checkout', 'main']),
    // The refresh merge of `worktree.ts`.
    merge: await r(['merge', '--no-edit', '-m', 'refresh', 'side']),
    abort: await r(['merge', '--abort']),
    commit: await r(['commit', '-qam', 'x', '--allow-empty']),
    fill: await r(['credential', 'fill'], 'protocol=https\nhost=example.com\n\n'),
    fetch: await r(['fetch', '-q', 'origin']),
    push: await r(['push', '-q', 'drop', 'main']),
  };
}

test('the trap fires under a plain git: every witness is real', { skip: !hasGit || process.platform === 'win32' }, async () => {
  const t = trappedRepo();
  const done = await gestures(t, async (args, input) => {
    const r = spawnSync('git', args, { env: t.env, encoding: 'utf8', input, timeout: 30_000 });
    return { code: r.status ?? 1, stderr: r.stderr };
  });
  assert.equal(done.fetch.code, 0, done.fetch.stderr);
  assert.equal(done.push.code, 0, done.push.stderr);
  assert.deepEqual(t.witnesses().filter((w) => w !== 'trusted-helper'), WITNESSES);
  rmSync(t.root, { recursive: true, force: true });
});

test('the daemon git runs nothing a mission wrote: status, diff, checkout, merge, commit, credentials, fetch, push',
  { skip: !hasGit || process.platform === 'win32' }, async () => {
    const t = trappedRepo();
    const opts = { env: t.env, timeout: 30_000 };
    const done = await gestures(t, (args, input) => (input === undefined
      ? host.execAsync('git', args, opts)
      : Promise.resolve(host.exec('git', args, { ...opts, input }))));
    assert.equal(done.status.code, 0, done.status.stderr);
    assert.equal(done.diff.code, 0, done.diff.stderr);
    assert.equal(done.checkout.code, 0, done.checkout.stderr);
    // The planted driver gives way to a plain text merge, which conflicts on
    // the line both sides changed.
    assert.notEqual(done.merge.code, 0);
    // The local transport is refused: a local remote runs ITS hooks.
    assert.match(done.fetch.stderr, /transport 'file' not allowed/);
    assert.match(done.push.stderr, /transport 'file' not allowed/);
    const seen = t.witnesses();
    assert.deepEqual(seen.filter((w) => w !== 'trusted-helper'), [], `ran: ${seen.join(', ')}`);
    assert.ok(seen.includes('trusted-helper'), 'the credential helper of the global configuration still runs');
    assert.equal(existsSync(gitHooksNoneDir()), false);
    rmSync(t.root, { recursive: true, force: true });
  });

test('the neutral alternate-refs command still lets a fetch through', { skip: !hasGit || process.platform === 'win32' }, () => {
  const t = trappedRepo();
  const scanned = scannedGitConfig([{ scope: 'local', key: 'core.alternaterefscommand', value: 'evil' }]);
  const pair = scanned.config.find((c) => c.startsWith('core.alternaterefscommand='));
  assert.ok(pair);
  // A plain git, the file transport allowed: only the neutral value differs.
  const r = spawnSync('git', ['-C', t.repo, '-c', pair, '-c', 'remote.origin.uploadpack=git-upload-pack', 'fetch', '-q', '--upload-pack=git-upload-pack', 'origin'],
    { env: t.env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(spawnSync('git', ['-C', t.repo, 'rev-parse', '--verify', '-q', 'origin/extra'], { env: t.env }).status, 0);
  assert.ok(!t.witnesses().includes('alternate-refs'), t.witnesses().join(','));
  rmSync(t.root, { recursive: true, force: true });
});

test('something planted in the empty hooks folder is removed before git runs', { skip: !hasGit || process.platform === 'win32' }, () => {
  const t = trappedRepo();
  const planted = gitHooksNoneDir();
  mkdirSync(planted, { recursive: true });
  writeFileSync(join(planted, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const r = host.exec('git', ['-C', t.repo, 'rev-parse', 'HEAD'], { env: t.env });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(existsSync(planted), false);
  rmSync(t.root, { recursive: true, force: true });
});

test('a configuration scan that fails stops the call', { skip: !hasGit }, async () => {
  const missing = join(tmpdir(), 'timon-no-such-repo-', String(process.pid));
  const r = await host.execAsync('git', ['-C', missing, 'status'], { timeout: 30_000 });
  assert.notEqual(r.code, 0);
});
