import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  NOTICES_ENVELOPE_MAX, NOTICES_MAX, NOTICE_ICONS, NOTICES_SIGNATURE_DOMAIN, NOTICE_BODY_MAX, activeNotices, composeNoticesPayload,
  signNoticesPayload, validateNoticesPayload, verifyNoticesFeed,
} from './notices-feed.mjs';
import { RELEASES_SIGNATURE_DOMAIN, composeReleasesPayload, releaseKeyPair, signReleasesPayload, verifyReleaseManifest } from './release-manifest.mjs';

// A throwaway pair per run: no test ever touches ~/.timon-release.
function pair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return releaseKeyPair(privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey.export({ type: 'spki', format: 'pem' }));
}
const now = new Date('2026-11-16T09:00:00.000Z');
const later = (ms) => new Date(now.getTime() + ms);
const DAY = 86_400_000;
const notice = (extra = {}) => ({ id: 'webinar-1', tone: 'info', title: 'Live demo on Thursday', body: 'Agents and plugins, one hour.', ...extra });
const keyringOf = (key, extra = {}) => [{ keyId: key.keyId, publicKey: key.publicKey, ...extra }];
const text = (envelope) => JSON.stringify(envelope);
/** Signs any payload under any domain, valid or not. */
function signRaw(payload, key, domain = NOTICES_SIGNATURE_DOMAIN) {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  return { keyId: key.keyId, payload: bytes.toString('base64'), sig: sign(null, Buffer.concat([Buffer.from(domain), bytes]), key.privateKey).toString('base64') };
}

test('a signed feed verifies with its key and returns the payload', () => {
  const key = pair();
  const payload = composeNoticesPayload({ notices: [notice({ link: 'https://timon-ai.com/live?from=app#now' })], now });
  assert.equal(payload.issuedAt, now.toISOString());
  assert.equal(payload.expiresAt, later(30 * DAY).toISOString());
  const envelope = signNoticesPayload(payload, key);
  assert.deepEqual(Object.keys(envelope), ['keyId', 'payload', 'sig']);
  assert.deepEqual(verifyNoticesFeed(text(envelope), keyringOf(key), { now }), payload);
  assert.deepEqual(verifyNoticesFeed(Buffer.from(text(envelope)), keyringOf(key), { now }), payload);
});

test('an empty feed is valid: it takes every earlier notice down', () => {
  const key = pair();
  const payload = composeNoticesPayload({ notices: [], now });
  assert.deepEqual(verifyNoticesFeed(text(signNoticesPayload(payload, key)), keyringOf(key), { now }).notices, []);
});

test('a bad signature, another key, an unknown or expired key is refused', () => {
  const key = pair();
  const envelope = signNoticesPayload(composeNoticesPayload({ notices: [notice()], now }), key);
  const flipped = Buffer.from(envelope.sig, 'base64');
  flipped[0] ^= 1;
  assert.throws(() => verifyNoticesFeed({ ...envelope, sig: flipped.toString('base64') }, keyringOf(key), { now }), /invalid signature/);
  const other = pair();
  assert.throws(() => verifyNoticesFeed(envelope, [{ keyId: key.keyId, publicKey: other.publicKey }], { now }), /invalid signature/);
  assert.throws(() => verifyNoticesFeed(envelope, keyringOf(other), { now }), /unknown keyId/);
  assert.throws(() => verifyNoticesFeed(envelope, keyringOf(key, { expiresAt: now.toISOString() }), { now }), /key .* has expired/);
});

test('a tampered payload is refused before it is read', () => {
  const key = pair();
  const envelope = signNoticesPayload(composeNoticesPayload({ notices: [notice()], now }), key);
  const tampered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(envelope.payload, 'base64').toString()), notices: [notice({ title: 'Pay here' })] })).toString('base64');
  assert.throws(() => verifyNoticesFeed({ ...envelope, payload: tampered }, keyringOf(key), { now }), /invalid signature/);
  // Unsigned garbage is never parsed: the signature fails first.
  assert.throws(() => verifyNoticesFeed({ ...envelope, payload: Buffer.from('{not json').toString('base64') }, keyringOf(key), { now }), /invalid signature/);
});

test('domain separation: a release manifest signature is no notice feed, and the reverse', () => {
  const key = pair();
  const releases = composeReleasesPayload({
    entry: {
      version: '0.1.9', publishedAt: now.toISOString(), notesUrl: 'https://docs.timon-ai.com/changelog', notes: 'n',
      artifacts: { 'linux-x64-appimage': { name: 'Timon.AppImage', url: 'https://example.com/Timon.AppImage', size: 1, sha256: 'c'.repeat(64) } },
    },
    now,
  }).payload;
  const manifest = signReleasesPayload(releases, key);
  assert.throws(() => verifyNoticesFeed(manifest, keyringOf(key), { now }), /invalid signature/);
  const feed = signNoticesPayload(composeNoticesPayload({ notices: [notice()], now }), key);
  assert.throws(() => verifyReleaseManifest(feed, keyringOf(key), { now }), /invalid signature/);
  // Even a notice payload signed under the release domain is refused as a feed.
  const crossSigned = signRaw(composeNoticesPayload({ notices: [notice()], now }), key, RELEASES_SIGNATURE_DOMAIN);
  assert.throws(() => verifyNoticesFeed(crossSigned, keyringOf(key), { now }), /invalid signature/);
  assert.notEqual(NOTICES_SIGNATURE_DOMAIN, RELEASES_SIGNATURE_DOMAIN);
});

test('expired, from the future, or older than the last accepted: refused; the same feed again: accepted', () => {
  const key = pair();
  const payload = composeNoticesPayload({ notices: [notice()], now, validDays: 2 });
  const feed = text(signNoticesPayload(payload, key));
  assert.throws(() => verifyNoticesFeed(feed, keyringOf(key), { now: later(2 * DAY) }), /expired on/);
  assert.ok(verifyNoticesFeed(feed, keyringOf(key), { now: later(2 * DAY), allowExpired: true }));
  assert.throws(() => verifyNoticesFeed(feed, keyringOf(key), { now: later(-10 * 60_000) }), /issued in the future/);
  assert.throws(() => verifyNoticesFeed(feed, keyringOf(key), { now, minIssuedAt: later(1).toISOString() }), /older than the last accepted feed/);
  assert.ok(verifyNoticesFeed(feed, keyringOf(key), { now, minIssuedAt: payload.issuedAt }));
});

test('the envelope is strict and bounded', () => {
  const key = pair();
  const envelope = signNoticesPayload(composeNoticesPayload({ notices: [notice()], now }), key);
  assert.throws(() => verifyNoticesFeed({ ...envelope, extra: 1 }, keyringOf(key), { now }), /unexpected field extra/);
  assert.throws(() => verifyNoticesFeed('x'.repeat(NOTICES_ENVELOPE_MAX + 1), keyringOf(key), { now }), /too large/);
  assert.throws(() => verifyNoticesFeed('{', keyringOf(key), { now }), /not JSON/);
  assert.throws(() => verifyNoticesFeed({ ...envelope, sig: 'not base64!' }, keyringOf(key), { now }), /sig is not base64/);
});

test('the payload schema refuses what a card could not show safely', () => {
  const base = { schema: 1, issuedAt: now.toISOString(), expiresAt: later(DAY).toISOString() };
  const refused = (n, pattern) => assert.throws(() => validateNoticesPayload({ ...base, notices: [n] }), pattern);
  refused(notice({ link: 'http://timon-ai.com/' }), /link must be an https/);
  refused(notice({ link: 'javascript:alert(1)' }), /link must be an https/);
  refused(notice({ link: 'https://user:pass@timon-ai.com/' }), /link must be an https/);
  refused(notice({ id: '../x' }), /id must be/);
  refused(notice({ tone: 'danger' }), /tone must be/);
  refused(notice({ title: 'two\nlines' }), /title must be one line/);
  refused(notice({ title: '' }), /title must be/);
  refused(notice({ body: 'x'.repeat(NOTICE_BODY_MAX + 1) }), /body must be plain text/);
  refused(notice({ body: 'bell\u0007' }), /body must be plain text/);
  refused(notice({ html: '<b>x</b>' }), /unexpected field html/);
  refused(notice({ icon: 'mastodon' }), /icon must be one of/);
  refused(notice({ icon: 'https://evil.example/logo.svg' }), /icon must be one of/);
  refused(notice({ icon: 1 }), /icon must be one of/);
  refused(notice({ startsAt: later(DAY).toISOString(), endsAt: now.toISOString() }), /endsAt must follow startsAt/);
  refused(notice({ channels: ['nightly'] }), /unknown channel/);
  refused(notice({ channels: [] }), /at least one channel/);
  refused(notice({ minVersion: '0.2.0', maxVersion: '0.1.9' }), /minVersion must not exceed/);
  refused(notice({ minVersion: 'v1' }), /minVersion is not/);
  const { body: _body, ...withoutBody } = notice();
  refused(withoutBody, /missing field body/);
  assert.throws(() => validateNoticesPayload({ ...base, notices: [notice(), notice()] }), /used twice/);
  assert.throws(() => validateNoticesPayload({ ...base, notices: Array.from({ length: NOTICES_MAX + 1 }, (_, i) => notice({ id: `n${i}` })) }), /at most/);
  assert.throws(() => validateNoticesPayload({ ...base, schema: 2, notices: [] }), /unsupported schema/);
  assert.ok(validateNoticesPayload({ ...base, notices: [notice({ body: 'two\nlines' })] }));
  for (const icon of NOTICE_ICONS) assert.ok(validateNoticesPayload({ ...base, notices: [notice({ icon })] }), icon);
});

test('a feed is composed only after the last one', () => {
  const previous = composeNoticesPayload({ notices: [], now });
  assert.throws(() => composeNoticesPayload({ notices: [], previous, now }), /would refuse this one as older/);
  assert.ok(composeNoticesPayload({ notices: [], previous, now: later(1) }));
  assert.throws(() => composeNoticesPayload({ notices: [], now, validDays: 0 }), /1 to 365/);
});

test('activeNotices: window, channel and version bounds', () => {
  const payload = composeNoticesPayload({
    now,
    notices: [
      notice({ id: 'always' }),
      notice({ id: 'soon', startsAt: later(DAY).toISOString() }),
      notice({ id: 'over', endsAt: now.toISOString() }),
      notice({ id: 'stable-only', channels: ['stable'] }),
      notice({ id: 'old-builds', maxVersion: '0.1.8' }),
      notice({ id: 'new-builds', minVersion: '0.1.9-rc.1' }),
    ],
  });
  const ids = (opts) => activeNotices(payload, { now, ...opts }).map((n) => n.id);
  assert.deepEqual(ids({ channel: 'beta', version: '0.1.8' }), ['always', 'old-builds']);
  assert.deepEqual(ids({ channel: 'stable', version: '0.1.9' }), ['always', 'stable-only', 'new-builds']);
  assert.deepEqual(ids({ channel: 'beta', version: '0.1.9-rc.1' }), ['always', 'new-builds']);
  assert.deepEqual(activeNotices(payload, { now: later(DAY), channel: 'beta', version: '0.1.8' }).map((n) => n.id), ['always', 'soon', 'old-builds']);
});
