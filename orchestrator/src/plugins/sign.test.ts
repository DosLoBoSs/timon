/**
 * `timon plugin sign` (TODO #922): the signature covers the files `npm pack`
 * ships, so a working folder with its tests, `node_modules` and `.bin` links
 * signs, and the package installed from its archive verifies. npm is injected
 * for the unit cases; the last cases run the real npm, end to end.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const { signPluginFolder, DEFAULT_PLUGIN_SIGNING_KEY_ID, PluginSignError } = await import('./sign.js');
const { npmPackLister } = await import('./preship-check.js');
const { hashPluginDirectory, hashPluginFiles, verifyPluginDirectory } = await import('./signature.js');
const { getHost } = await import('../host/index.js');
type PackLister = import('./preship-check.js').PackLister;

const pair = generateKeyPairSync('ed25519');
const PRIVATE = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const KEYS = [{ keyId: 'test-sign', publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }];
const WORK = mkdtempSync(join(tmpdir(), 'timon-sign-'));
let serial = 0;

/** In the order the digest sorts them (`localeCompare`). */
const SHIPPED = ['lib/index.js', 'package.json', 'README.md'];

function write(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const abs = join(dir, ...path.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

/**
 * A plugin's working folder: what ships, plus tests, a `.env`, dependencies and
 * the `.bin` link npm creates. A junction needs no privilege on Windows.
 */
function workingFolder(json: Record<string, unknown> = {}): { dir: string; linked: boolean } {
  const dir = join(WORK, `w-${++serial}`);
  write(dir, {
    'package.json': JSON.stringify({ name: `@acme/signed-${serial}`, version: '1.0.0', type: 'module', main: 'lib/index.js', files: ['lib', 'SIGNATURE'], ...json }, null, 2),
    'lib/index.js': 'export function apply() {}\n',
    'README.md': '# Signed\n',
    'tests/index.test.js': 'export {};\n',
    '.env': 'TOKEN=x\n',
    'node_modules/dep/index.js': 'module.exports = 1;\n',
    'node_modules/dep/package.json': '{"name":"dep","version":"1.0.0"}\n',
  });
  let linked = true;
  try {
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
    symlinkSync(join(dir, 'node_modules', 'dep'), join(dir, 'node_modules', '.bin', 'dep'), 'junction');
  } catch {
    linked = false;
  }
  return { dir, linked };
}

/** npm's answer: the listed files, and SIGNATURE once it exists when `ships`. */
function lister(files: string[], ships = true): PackLister {
  return async (dir) => ({ files: ships && existsSync(join(dir, 'SIGNATURE')) ? [...files, 'SIGNATURE'] : files });
}

/** What `timon plugin add <tgz>` leaves on disk: the shipped files, nothing else. */
function installed(dir: string, files: string[]): string {
  const target = join(WORK, `i-${++serial}`);
  for (const f of [...files, 'SIGNATURE']) {
    const to = join(target, ...f.split('/'));
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(dir, ...f.split('/')), to);
  }
  return target;
}

test('a working folder signs over the files npm ships, and the installed package verifies', async (t) => {
  const { dir, linked } = workingFolder();
  if (!linked) t.diagnostic('no link could be created here: the .bin case is not exercised');
  const out = await signPluginFolder(dir, { privateKey: PRIVATE, keyId: 'test-sign', pack: lister(SHIPPED) });
  assert.deepEqual(out.files, SHIPPED);
  assert.equal(out.signatureShips, true);
  const written = JSON.parse(readFileSync(join(dir, 'SIGNATURE'), 'utf8')) as { keyId: string; hash: string };
  assert.equal(written.keyId, 'test-sign');
  assert.equal(written.hash, hashPluginFiles(dir, SHIPPED));

  const copy = installed(dir, SHIPPED);
  const verdict = verifyPluginDirectory(copy, KEYS);
  assert.equal(verdict.ok, true, verdict.ok ? '' : verdict.message);
  // The working folder itself holds more than what was signed.
  assert.equal(verifyPluginDirectory(dir, KEYS).ok, false);
  assert.equal(verifyPluginDirectory(dir, KEYS, new Date(), SHIPPED).ok, true);

  writeFileSync(join(copy, 'lib', 'index.js'), 'export function apply() { /* changed */ }\n');
  const altered = verifyPluginDirectory(copy, KEYS);
  assert.equal(altered.ok ? '' : altered.code, 'tampered');
});

test('signing again leaves the previous SIGNATURE out of the digest', async () => {
  const { dir } = workingFolder();
  const first = await signPluginFolder(dir, { privateKey: PRIVATE, keyId: 'test-sign', pack: lister(SHIPPED) });
  const second = await signPluginFolder(dir, { privateKey: PRIVATE, keyId: 'test-sign', pack: lister(SHIPPED) });
  assert.equal(second.hash, first.hash);
  assert.deepEqual(second.files, SHIPPED);
});

test('the production key id is the default', async () => {
  const { dir } = workingFolder();
  const out = await signPluginFolder(dir, { privateKey: PRIVATE, pack: lister(SHIPPED) });
  assert.equal(out.keyId, DEFAULT_PLUGIN_SIGNING_KEY_ID);
  assert.equal(DEFAULT_PLUGIN_SIGNING_KEY_ID, 'timon-plugins-2026-11');
});

test('without npm the signer stops with a clear message and writes nothing', async () => {
  const { dir } = workingFolder();
  await assert.rejects(signPluginFolder(dir, { privateKey: PRIVATE, pack: async () => null }), (err: Error) => {
    assert.ok(err instanceof PluginSignError);
    assert.match(err.message, /npm could not be run/);
    return true;
  });
  assert.equal(existsSync(join(dir, 'SIGNATURE')), false);
});

test('npm refusing the package, a listed link or a missing package.json are refusals', async () => {
  const { dir, linked } = workingFolder();
  await assert.rejects(signPluginFolder(dir, { privateKey: PRIVATE, pack: async () => ({ error: 'bad files' }) }), /npm pack refused this package: bad files/);
  if (linked) {
    await assert.rejects(signPluginFolder(dir, { privateKey: PRIVATE, pack: lister([...SHIPPED, 'node_modules/.bin/dep']) }), /symbolic link forbidden/);
  }
  await assert.rejects(signPluginFolder(dir, { privateKey: PRIVATE, pack: lister(['../outside.js']) }), /invalid path/);
  assert.equal(existsSync(join(dir, 'SIGNATURE')), false);
  const empty = join(WORK, `e-${++serial}`);
  mkdirSync(empty);
  await assert.rejects(signPluginFolder(empty, { privateKey: PRIVATE, pack: lister(SHIPPED) }), /no package\.json/);
});

test('a `files` that leaves SIGNATURE out is reported: an archive would ship unsigned', async () => {
  const { dir } = workingFolder();
  const out = await signPluginFolder(dir, { privateKey: PRIVATE, keyId: 'test-sign', pack: lister(SHIPPED, false) });
  assert.equal(out.signatureShips, false);
  // The folder installed as it stands is still signed.
  assert.equal(verifyPluginDirectory(installed(dir, SHIPPED), KEYS).ok, true);
});

async function npmAvailable(): Promise<boolean> {
  const probe = await getHost().execAsync('npm', ['--version']).catch(() => null);
  return Boolean(probe && probe.code === 0);
}

test('with the real npm: signed in its working folder, packed, installed as `plugin add` does, it verifies', async (t) => {
  if (!(await npmAvailable())) { t.skip('npm is not available here'); return; }
  // A `scripts` the staged copy of the lister drops, while the archive keeps it.
  const { dir } = workingFolder({ scripts: { test: 'node tests/index.test.js' } });
  const out = await signPluginFolder(dir, { privateKey: PRIVATE, keyId: 'test-sign', pack: npmPackLister });
  assert.ok(out.files.includes('lib/index.js') && out.files.includes('package.json'), out.files.join(', '));
  assert.ok(!out.files.some((f) => f.startsWith('node_modules/') || f.startsWith('tests/') || f === '.env'), out.files.join(', '));
  assert.equal(out.signatureShips, true);

  const host = getHost();
  const archives = join(WORK, `a-${++serial}`);
  mkdirSync(archives);
  const packed = await host.execAsync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', archives], { cwd: dir, timeout: 120_000 });
  assert.equal(packed.code, 0, packed.stderr);
  const tgz = join(archives, (JSON.parse(packed.stdout) as Array<{ filename: string }>)[0]!.filename);
  const prefix = join(WORK, `p-${++serial}`);
  mkdirSync(prefix);
  const add = await host.execAsync('npm', ['install', '--prefix', prefix, '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts', tgz], { cwd: prefix, timeout: 120_000 });
  assert.equal(add.code, 0, add.stderr);
  const name = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string }).name;
  const verdict = verifyPluginDirectory(join(prefix, 'node_modules', ...name.split('/')), KEYS);
  assert.equal(verdict.ok, true, verdict.ok ? '' : verdict.message);
});

test('with the real npm: an already packed folder signs as the whole-folder hash did', async (t) => {
  if (!(await npmAvailable())) { t.skip('npm is not available here'); return; }
  const dir = join(WORK, `x-${++serial}`);
  write(dir, {
    'package.json': JSON.stringify({ name: '@acme/extracted', version: '1.0.0', type: 'module', main: 'lib/index.js', files: ['lib'] }, null, 2),
    'lib/index.js': 'export function apply() {}\n',
    'README.md': '# Extracted\n',
  });
  const out = await signPluginFolder(dir, { privateKey: PRIVATE, keyId: 'test-sign', pack: npmPackLister });
  assert.equal(out.hash, hashPluginDirectory(dir));
  assert.equal(verifyPluginDirectory(dir, KEYS).ok, true);
});

test.after(() => rmSync(WORK, { recursive: true, force: true }));
