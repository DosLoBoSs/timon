import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyNoticesFeed } from '../notices-feed.mjs';
import { keyIdFor } from '../release-manifest.mjs';
import { main } from './sign-notices.mjs';

// A throwaway pair and a throwaway checkout: no test ever touches ~/.timon-release.
function throwawayKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }), publicPem, keyId: keyIdFor(publicPem) };
}
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'sign-notices-'));
  const root = join(dir, 'checkout');
  mkdirSync(root);
  const source = join(dir, 'notices.json');
  writeFileSync(source, JSON.stringify({ notices: [{ id: 'live-1', tone: 'info', title: 'Live demo', body: 'Thursday, 6 pm.' }] }));
  return { dir, root, source };
}
const now = new Date('2026-11-16T09:00:00.000Z');
const quiet = () => {};

test('signs the source into the checkout root, verifiable with the key the clients pin', () => {
  const key = throwawayKey();
  const { root, source } = workspace();
  const lines = [];
  const result = main(['--source', source, '--valid-days', '7'], { env: { TIMON_RELEASE_ED25519_KEY: key.pem }, root, now, print: (l) => lines.push(l), pins: { ed25519: key.keyId } });
  assert.equal(result.written, true);
  const feed = readFileSync(join(root, 'timon-notices.json'));
  const payload = verifyNoticesFeed(feed, [{ keyId: key.keyId, publicKey: key.publicPem }], { now });
  assert.equal(payload.notices[0].id, 'live-1');
  assert.equal(payload.expiresAt, '2026-11-23T09:00:00.000Z');
  assert.ok(!lines.join('\n').includes('PRIVATE KEY'));
});

test('a key the clients do not pin is refused, and the key never shows in the error', () => {
  const key = throwawayKey();
  const { root, source } = workspace();
  assert.throws(
    () => main(['--source', source], { env: { TIMON_RELEASE_ED25519_KEY: key.pem }, root, now, print: quiet, pins: { ed25519: 'release-0000000000000000' } }),
    (error) => /clients pin release-0000000000000000/.test(error.message) && !error.message.includes('PRIVATE'),
  );
});

test('the next feed must follow the last one; an unverifiable last feed stops the run', () => {
  const key = throwawayKey();
  const { root, source } = workspace();
  const opts = { env: { TIMON_RELEASE_ED25519_KEY: key.pem }, root, print: quiet, pins: { ed25519: key.keyId } };
  main(['--source', source], { ...opts, now });
  assert.throws(() => main(['--source', source], { ...opts, now }), /refuse this one as older/);
  assert.ok(main(['--source', source], { ...opts, now: new Date(now.getTime() + 60_000) }).written);
  writeFileSync(join(root, 'timon-notices.json'), '{"keyId":"x","payload":"","sig":""}');
  assert.throws(() => main(['--source', source], { ...opts, now: new Date(now.getTime() + 120_000) }), /cannot verify the last feed/);
});

test('a key file inside the checkout is refused; one outside is read', () => {
  const key = throwawayKey();
  const { dir, root, source } = workspace();
  const insideFile = join(root, 'release.key.pem');
  writeFileSync(insideFile, key.pem);
  assert.throws(() => main(['--source', source, '--key-file', insideFile], { env: {}, root, now, print: quiet, pins: null }), /inside the checkout/);
  const outside = join(dir, 'release.key.pem');
  writeFileSync(outside, key.pem);
  assert.ok(main(['--source', source, '--key-file', outside], { env: {}, root, now, print: quiet, pins: { ed25519: key.keyId } }).written);
});

test('inside a mission only a dry run is allowed, and it writes nothing', () => {
  const { root, source } = workspace();
  const env = { TIMON_MISSION_ID: 'm-1' };
  assert.throws(() => main(['--source', source], { env, root, now, print: quiet }), /Refused inside a Timon mission/);
  const result = main(['--source', source, '--dry-run'], { env, root, now, print: quiet });
  assert.equal(result.written, false);
  assert.throws(() => readFileSync(join(root, 'timon-notices.json')));
});

test('the source carries notices only, and they are validated', () => {
  const { dir, root } = workspace();
  const source = join(dir, 'bad.json');
  writeFileSync(source, JSON.stringify({ notices: [], expiresAt: '2030-01-01T00:00:00Z' }));
  assert.throws(() => main(['--source', source, '--dry-run'], { env: {}, root, now, print: quiet }), /unexpected field expiresAt/);
  writeFileSync(source, JSON.stringify({ notices: [{ id: 'x', tone: 'info', title: 't', body: 'b', link: 'http://plain.example/' }] }));
  assert.throws(() => main(['--source', source, '--dry-run'], { env: {}, root, now, print: quiet }), /link must be an https/);
  assert.throws(() => main([], { env: {}, root, now, print: quiet }), /--source is required/);
});
