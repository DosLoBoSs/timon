/**
 * The notice feed: the daemon's verifier against the release machine's
 * (`scripts/notices-feed.mjs`) on the same envelopes, then the fetch — what it
 * sends, what it refuses, and that a failed feed shows nothing. Feeds are
 * signed by the reference composer with a throwaway pair; the fetch is a fake
 * that records every request, so "no request" is checked, not assumed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as reference from '../../../../scripts/notices-feed.mjs';
import * as releases from '../../../../scripts/release-manifest.mjs';
import type { BuildChannel } from '../../build-info.js';
import { USER_AGENT, type FetchLike } from './checker.js';
import { RELEASES_SIGNATURE_DOMAIN, type ReleasePublicKey } from './manifest.js';
import { NoticesFeed } from './notices-checker.js';
import { NOTICE_ICONS, NOTICES_SIGNATURE_DOMAIN, NOTICES_URL, activeNotices, validateNoticesPayload, verifyNoticesFeed } from './notices-feed.js';

type Notice = reference.FeedNotice;

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const key = releases.releaseKeyPair(privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey.export({ type: 'spki', format: 'pem' }));
const keyring: ReleasePublicKey[] = [{ keyId: key.keyId, publicKey: key.publicKey }];
const at = new Date('2026-11-16T08:00:00.000Z');
const DAY = 86_400_000;
const notice = (extra: Partial<Notice> = {}): Notice => ({ id: 'live-1', tone: 'info', title: 'Live demo', body: 'Thursday, 6 pm.', ...extra });

function feed(notices: Notice[], when = at, validDays = 30): string {
  return JSON.stringify(reference.signNoticesPayload(reference.composeNoticesPayload({ notices, now: when, validDays }), key));
}
/** Signs any payload under any domain, valid or not, so both verifiers see the same bytes. */
function signRaw(payload: unknown, domain = NOTICES_SIGNATURE_DOMAIN): string {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  return JSON.stringify({ keyId: key.keyId, payload: bytes.toString('base64'), sig: sign(null, Buffer.concat([Buffer.from(domain), bytes]), key.privateKey).toString('base64') });
}

/** Both verifiers accept, or both refuse; the same payload when they accept. */
function agree(text: string, options: { now: Date; minIssuedAt?: string | null }): 'accepted' | 'refused' {
  let ours: unknown = null;
  let theirs: unknown = null;
  try { ours = verifyNoticesFeed(text, keyring, options); } catch { ours = null; }
  try { theirs = reference.verifyNoticesFeed(text, keyring, options); } catch { theirs = null; }
  assert.deepEqual(ours, theirs);
  return ours ? 'accepted' : 'refused';
}

test('the constants match the release machine', () => {
  assert.deepEqual([...NOTICE_ICONS], [...reference.NOTICE_ICONS]);
  assert.equal(NOTICES_SIGNATURE_DOMAIN, reference.NOTICES_SIGNATURE_DOMAIN);
  assert.equal(NOTICES_URL, reference.NOTICES_URL);
  assert.notEqual(NOTICES_SIGNATURE_DOMAIN, RELEASES_SIGNATURE_DOMAIN);
});

test('both verifiers agree on valid, expired, replayed, tampered and cross-domain feeds', () => {
  const now = new Date(at.getTime() + 60_000);
  const good = feed([notice({ link: 'https://timon-ai.com/live', channels: ['beta'], minVersion: '0.1.7', icon: 'discord' })]);
  assert.equal(agree(good, { now }), 'accepted');
  assert.equal(agree(feed([]), { now }), 'accepted');
  assert.equal(agree(feed([notice()], at, 1), { now: new Date(at.getTime() + DAY) }), 'refused');
  assert.equal(agree(good, { now, minIssuedAt: new Date(at.getTime() + 1).toISOString() }), 'refused');
  assert.equal(agree(good, { now, minIssuedAt: at.toISOString() }), 'accepted');
  const envelope = JSON.parse(good) as { keyId: string; payload: string; sig: string };
  const flipped = Buffer.from(envelope.sig, 'base64');
  flipped[5] = (flipped[5] ?? 0) ^ 1;
  assert.equal(agree(JSON.stringify({ ...envelope, sig: flipped.toString('base64') }), { now }), 'refused');
  const payload = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8')) as Record<string, unknown>;
  assert.equal(agree(signRaw(payload, RELEASES_SIGNATURE_DOMAIN), { now }), 'refused');
  for (const bad of [
    { ...payload, notices: [notice({ link: 'http://timon-ai.com/' })] },
    { ...payload, notices: [notice({ title: 'a\nb' })] },
    { ...payload, notices: [{ ...notice(), html: '<b>x</b>' }] },
    { ...payload, notices: [{ ...notice(), icon: 'https://evil.example/logo.svg' }] },
    { ...payload, notices: [{ ...notice(), icon: 'mastodon' }] },
    { ...payload, notices: [notice(), notice()] },
    { ...payload, schema: 2 },
  ]) assert.equal(agree(signRaw(bad), { now }), 'refused');
});

test('a release manifest is never read as a notice feed', () => {
  const manifest = releases.serializeEnvelope(releases.signReleasesPayload(releases.composeReleasesPayload({
    entry: {
      version: '0.1.9', publishedAt: at.toISOString(), notesUrl: 'https://docs.timon-ai.com/changelog', notes: 'n',
      artifacts: { 'linux-x64-appimage': { name: 'Timon.AppImage', url: 'https://example.com/Timon.AppImage', size: 1, sha256: 'c'.repeat(64) } },
    },
    now: at,
  }).payload, key));
  assert.throws(() => verifyNoticesFeed(manifest, keyring, { now: at }), /invalid signature/);
});

test('activeNotices matches the reference', () => {
  const payload = validateNoticesPayload(reference.composeNoticesPayload({
    now: at,
    notices: [notice({ id: 'a' }), notice({ id: 'b', channels: ['stable'] }), notice({ id: 'c', maxVersion: '0.1.7' }), notice({ id: 'd', startsAt: new Date(at.getTime() + DAY).toISOString() })],
  }));
  for (const build of [{ channel: 'beta' as const, version: '0.1.7' }, { channel: 'stable' as const, version: '0.1.8' }]) {
    assert.deepEqual(activeNotices(payload, { ...build, now: at }), reference.activeNotices(payload, { ...build, now: at }));
  }
});

type Recorded = { url: string; init: RequestInit };

function harness(opts: { response: (url: string) => Response | Promise<Response>; channel?: BuildChannel; installed?: string; enabled?: boolean; stateFile?: string }) {
  const calls: Recorded[] = [];
  const logs: string[] = [];
  const settings = { enabled: opts.enabled ?? true, channel: opts.channel ?? 'beta' as BuildChannel, installed: opts.installed ?? '0.1.8' };
  let now = new Date(at.getTime() + 60_000);
  const fetchImpl: FetchLike = async (url, init) => { calls.push({ url, init }); return opts.response(url); };
  const stateFile = opts.stateFile ?? join(mkdtempSync(join(tmpdir(), 'timon-notices-')), 'updates', 'notices-state.json');
  const instance = new NoticesFeed({
    enabled: () => settings.enabled,
    channel: () => settings.channel,
    installed: () => settings.installed,
    keyring: () => keyring,
    stateFile,
    fetch: fetchImpl,
    now: () => now,
    log: (message) => { logs.push(message); },
  });
  return { instance, calls, logs, settings, stateFile, setNow: (next: Date) => { now = next; } };
}

test('a verified feed gives this build its notices; the request carries nothing but a generic User-Agent', async () => {
  const body = feed([
    notice({ link: 'https://timon-ai.com/live', icon: 'youtube' }),
    notice({ id: 'stable-only', channels: ['stable'] }),
    notice({ id: 'plain' }),
  ]);
  const h = harness({ response: () => new Response(body) });
  await h.instance.refresh();
  assert.deepEqual(h.instance.notices(), [
    { id: 'live-1', tone: 'info', title: 'Live demo', body: 'Thursday, 6 pm.', icon: 'youtube', link: 'https://timon-ai.com/live', endsAt: null },
    { id: 'plain', tone: 'info', title: 'Live demo', body: 'Thursday, 6 pm.', icon: null, link: null, endsAt: null },
  ]);
  assert.equal(h.calls.length, 1);
  const [call] = h.calls;
  assert.equal(call?.url, NOTICES_URL);
  assert.equal(call?.init.method, 'GET');
  assert.equal(call?.init.body, undefined);
  assert.equal(call?.init.credentials, 'omit');
  assert.equal(call?.init.redirect, 'manual');
  assert.deepEqual(call?.init.headers, { 'user-agent': USER_AGENT, accept: 'application/json' });
  assert.equal(JSON.parse(readFileSync(h.stateFile, 'utf8')).lastIssuedAt, at.toISOString());
});

test('no notice from a feed that fails: bad signature, expired, not JSON, HTTP error, too large', async () => {
  const good = JSON.parse(feed([notice()])) as { keyId: string; payload: string; sig: string };
  const forged = JSON.stringify({ ...good, sig: Buffer.alloc(64, 1).toString('base64') });
  const bodies = [
    () => new Response(forged),
    () => new Response(feed([notice()], new Date(at.getTime() - 2 * DAY), 1)),
    () => new Response('<html>captive portal</html>'),
    () => new Response('nope', { status: 503 }),
    () => new Response('x'.repeat(200 * 1024)),
  ];
  for (const response of bodies) {
    const h = harness({ response });
    await h.instance.refresh();
    assert.deepEqual(h.instance.notices(), []);
    assert.equal(h.logs.length, 1);
    assert.match(h.logs[0] ?? '', /no notice taken from the feed/);
  }
});

test('an older feed is refused and the newer one stays; a forged one adds nothing', async () => {
  const older = feed([notice({ id: 'old' })], at);
  const newer = feed([notice({ id: 'new' })], new Date(at.getTime() + 1_000));
  let body = newer;
  const h = harness({ response: () => new Response(body) });
  await h.instance.refresh();
  assert.deepEqual(h.instance.notices().map((n) => n.id), ['new']);
  body = older;
  await h.instance.refresh();
  assert.deepEqual(h.instance.notices().map((n) => n.id), ['new']);
  assert.match(h.logs.at(-1) ?? '', /older than the last accepted feed/);
  // The refusal survives a restart: the state file holds the newer date.
  const restarted = harness({ response: () => new Response(older), stateFile: h.stateFile });
  await restarted.instance.refresh();
  assert.deepEqual(restarted.instance.notices(), []);
  body = JSON.stringify({ ...JSON.parse(newer) as object, sig: Buffer.alloc(64, 2).toString('base64') });
  await h.instance.refresh();
  assert.deepEqual(h.instance.notices().map((n) => n.id), ['new']);
});

test('the last verified feed stops showing once expired; windows are read at request time', async () => {
  const h = harness({ response: () => new Response(feed([notice({ endsAt: new Date(at.getTime() + DAY).toISOString() }), notice({ id: 'later', startsAt: new Date(at.getTime() + DAY).toISOString() })], at, 2)) });
  await h.instance.refresh();
  assert.deepEqual(h.instance.notices().map((n) => n.id), ['live-1']);
  h.setNow(new Date(at.getTime() + DAY));
  assert.deepEqual(h.instance.notices().map((n) => n.id), ['later']);
  h.setNow(new Date(at.getTime() + 2 * DAY));
  assert.deepEqual(h.instance.notices(), []);
});

test('off, or a build from the sources: not a single request, no notice', async () => {
  for (const settings of [{ enabled: false }, { channel: 'dev' as BuildChannel }]) {
    const h = harness({ response: () => new Response(feed([notice()])), ...settings });
    await h.instance.refresh();
    assert.equal(h.calls.length, 0);
    assert.deepEqual(h.instance.notices(), []);
  }
  const h = harness({ response: () => new Response(feed([notice()])) });
  await h.instance.refresh();
  h.settings.enabled = false;
  assert.deepEqual(h.instance.notices(), [], 'switched off, what was fetched is no longer shown');
});

test('redirects are followed to https only, never with credentials', async () => {
  const body = feed([notice()]);
  const followed = harness({
    response: (url) => (url === NOTICES_URL
      ? new Response(null, { status: 302, headers: { location: 'https://cdn.example.com/timon-notices.json' } })
      : new Response(body)),
  });
  await followed.instance.refresh();
  assert.deepEqual(followed.calls.map((c) => c.url), [NOTICES_URL, 'https://cdn.example.com/timon-notices.json']);
  assert.equal(followed.instance.notices().length, 1);
  for (const location of ['http://cdn.example.com/feed.json', 'https://user:pw@cdn.example.com/feed.json']) {
    const h = harness({ response: (url) => (url === NOTICES_URL ? new Response(null, { status: 301, headers: { location } }) : new Response(body)) });
    await h.instance.refresh();
    assert.equal(h.calls.length, 1, 'the off-https target is never requested');
    assert.deepEqual(h.instance.notices(), []);
  }
});
