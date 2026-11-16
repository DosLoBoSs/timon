import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { KEY_FILE_ENV, resolveKeys } from './build-package.mjs';
import { envLines, main, writeThrowawayKeys } from './throwaway-keys.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'throwaway-keys-'));

test('writeThrowawayKeys: a matching Ed25519 pair in a new folder under the parent', () => {
  const parent = scratch();
  const files = writeThrowawayKeys(parent);
  assert.equal(dirname(files.dir), parent);
  const privateKey = createPrivateKey(readFileSync(files.privateKey));
  const publicKey = createPublicKey(readFileSync(files.publicKey));
  assert.equal(privateKey.asymmetricKeyType, 'ed25519');
  const signature = sign(null, Buffer.from('inventory'), privateKey);
  assert.ok(verify(null, Buffer.from('inventory'), publicKey, signature));
  if (process.platform !== 'win32') assert.equal(statSync(files.privateKey).mode & 0o777, 0o600);
  // Two runs never share a pair.
  const other = writeThrowawayKeys(parent);
  assert.notEqual(other.dir, files.dir);
  assert.notEqual(readFileSync(other.publicKey, 'utf8'), readFileSync(files.publicKey, 'utf8'));
  assert.throws(() => writeThrowawayKeys('relative/dir'), /absolute path/);
});

test('main appends the two file variables to GITHUB_ENV, which build-package reads', () => {
  const parent = scratch();
  const githubEnv = join(scratch(), 'env');
  writeFileSync(githubEnv, 'EARLIER=1\n');
  const files = main([parent], { GITHUB_ENV: githubEnv });
  const env = Object.fromEntries(readFileSync(githubEnv, 'utf8').trim().split('\n').map((line) => line.split(/=(.*)/s).slice(0, 2)));
  assert.equal(env.EARLIER, '1');
  assert.equal(env[KEY_FILE_ENV.privateKey], files.privateKey);
  assert.equal(env[KEY_FILE_ENV.publicKey], files.publicKey);
  assert.deepEqual(resolveKeys({ keyDir: null, env }), { source: 'key file variables', privateKey: files.privateKey, publicKey: files.publicKey });
  assert.doesNotMatch(readFileSync(githubEnv, 'utf8'), /PRIVATE KEY-----/);
  assert.throws(() => main([], {}), /Usage/);
});

test('envLines refuses a path that would inject a variable', () => {
  assert.throws(() => envLines({ privateKey: '/tmp/a\nEVIL=1', publicKey: '/tmp/b' }), /line break/);
});
