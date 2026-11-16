/**
 * The signed notice feed, `timon-notices.json` (docs/AUTO-UPDATE.md §10): an
 * announcement reaches the installed apps without a release.
 *
 * Same envelope and same key as `releases.json` (release-manifest.mjs):
 * `{ "keyId": "...", "payload": "<base64 of the JSON>", "sig": "<base64 Ed25519>" }`.
 * The signed bytes are NOTICES_SIGNATURE_DOMAIN followed by the payload bytes,
 * a domain of its own: a release manifest signature can never be replayed as a
 * notice feed, nor a feed as a manifest, though one key signs both.
 *
 * Composition and signing run on the release machine (scripts/release/sign-notices.mjs);
 * verification is mirrored by the daemon (plugins-bundled/updates/notices-feed.ts),
 * and both are tested on the same envelopes. `node:crypto` only: no file, no
 * network.
 *
 * Payload, schema 1:
 *   { schema: 1, issuedAt, expiresAt, notices: [{ id, tone, title, body, link?,
 *     startsAt?, endsAt?, channels?, minVersion?, maxVersion? }] }
 * Every object is strict: an unknown field is refused, so a field added later
 * needs a new schema, which builds that only know schema 1 refuse as a whole.
 */
import { sign, verify } from 'node:crypto';
import { CHANNELS, compareVersions, isVersion } from './release-manifest.mjs';

export const NOTICES_SCHEMA = 1;
export const NOTICES_SIGNATURE_DOMAIN = 'timon-notices-v1\0';
export const NOTICES_URL = 'https://timon-ai.com/.well-known/timon-notices.json';
/** The apps' card limits (app/src/lib/notices.ts): a longer text would be refused on screen. */
export const NOTICE_TITLE_MAX = 120;
export const NOTICE_BODY_MAX = 400;
export const NOTICE_LINK_MAX = 2048;
export const NOTICES_MAX = 20;
/** An envelope larger than this is refused before parsing: twenty notices are a few KB. */
export const NOTICES_ENVELOPE_MAX = 128 * 1024;
export const CLOCK_SKEW_MS = 5 * 60_000;
export const DEFAULT_NOTICES_VALID_DAYS = 30;
export const TONES = Object.freeze(['info', 'warning', 'success']);

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const NOTICE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Plain text: no control character but a line break in the body, nothing a terminal or a renderer could act on.
const TITLE_TEXT = /^[^\u0000-\u001f\u007f]+$/;
const BODY_TEXT = /^[^\u0000-\u0009\u000b-\u001f\u007f]+$/;
const NOTICE_FIELDS = ['id', 'tone', 'title', 'body', 'link', 'startsAt', 'endsAt', 'channels', 'minVersion', 'maxVersion'];
const NOTICE_REQUIRED = ['id', 'tone', 'title', 'body'];

const fail = (message) => { throw new Error(`timon-notices.json: ${message}`); };
const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function exactKeys(value, keys, where) {
  if (!plainObject(value)) fail(`${where} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${where}: unexpected field ${key}`);
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(`${where}: missing field ${key}`);
}
function isoDate(value, where) {
  if (typeof value !== 'string' || !ISO.test(value) || Number.isNaN(Date.parse(value))) fail(`${where} must be an ISO 8601 UTC date`);
  return Date.parse(value);
}

/** An https address without credentials; a query or a fragment is fine, the link is only ever opened. */
export function isNoticeLink(value) {
  if (typeof value !== 'string' || value.length > NOTICE_LINK_MAX) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === 'https:' && !url.username && !url.password && Boolean(url.hostname);
}

function validateNotice(notice, where) {
  if (!plainObject(notice)) fail(`${where} must be an object`);
  for (const key of Object.keys(notice)) if (!NOTICE_FIELDS.includes(key)) fail(`${where}: unexpected field ${key}`);
  for (const key of NOTICE_REQUIRED) if (!Object.hasOwn(notice, key)) fail(`${where}: missing field ${key}`);
  if (typeof notice.id !== 'string' || !NOTICE_ID.test(notice.id)) fail(`${where}.id must be 1-64 letters, digits, '.', '_' or '-'`);
  if (!TONES.includes(notice.tone)) fail(`${where}.tone must be info, warning or success`);
  if (typeof notice.title !== 'string' || !notice.title.trim() || notice.title.length > NOTICE_TITLE_MAX || !TITLE_TEXT.test(notice.title)) {
    fail(`${where}.title must be one line of 1-${NOTICE_TITLE_MAX} characters`);
  }
  if (typeof notice.body !== 'string' || !notice.body.trim() || notice.body.length > NOTICE_BODY_MAX || !BODY_TEXT.test(notice.body)) {
    fail(`${where}.body must be plain text of 1-${NOTICE_BODY_MAX} characters`);
  }
  if (notice.link !== undefined && !isNoticeLink(notice.link)) fail(`${where}.link must be an https: address without credentials`);
  const starts = notice.startsAt === undefined ? null : isoDate(notice.startsAt, `${where}.startsAt`);
  const ends = notice.endsAt === undefined ? null : isoDate(notice.endsAt, `${where}.endsAt`);
  if (starts !== null && ends !== null && starts >= ends) fail(`${where}.endsAt must follow startsAt`);
  if (notice.channels !== undefined) {
    if (!Array.isArray(notice.channels) || !notice.channels.length) fail(`${where}.channels must list at least one channel`);
    for (const channel of notice.channels) if (!CHANNELS.includes(channel)) fail(`${where}.channels: unknown channel ${String(channel).slice(0, 40)}`);
    if (new Set(notice.channels).size !== notice.channels.length) fail(`${where}.channels lists a channel twice`);
  }
  for (const bound of ['minVersion', 'maxVersion']) {
    if (notice[bound] !== undefined && !isVersion(notice[bound])) fail(`${where}.${bound} is not x.y.z[-rc.N]`);
  }
  if (notice.minVersion !== undefined && notice.maxVersion !== undefined && compareVersions(notice.minVersion, notice.maxVersion) > 0) {
    fail(`${where}.minVersion must not exceed maxVersion`);
  }
}

/** The strict shape of the payload (schema 1); the daemon mirrors it in zod. */
export function validateNoticesPayload(payload) {
  exactKeys(payload, ['schema', 'issuedAt', 'expiresAt', 'notices'], 'payload');
  if (payload.schema !== NOTICES_SCHEMA) fail(`unsupported schema ${payload.schema}`);
  if (isoDate(payload.issuedAt, 'issuedAt') >= isoDate(payload.expiresAt, 'expiresAt')) fail('expiresAt must follow issuedAt');
  // An empty list is a feed too: it takes every earlier notice down.
  if (!Array.isArray(payload.notices) || payload.notices.length > NOTICES_MAX) fail(`notices must be a list of at most ${NOTICES_MAX}`);
  const ids = new Set();
  payload.notices.forEach((notice, index) => {
    validateNotice(notice, `notices.${index}`);
    if (ids.has(notice.id)) fail(`notices.${index}.id ${notice.id} is used twice`);
    ids.add(notice.id);
  });
  return payload;
}

/**
 * The next payload: the source notices, dated now and valid `validDays`. Its
 * `issuedAt` must follow the last feed published, or the apps that read that
 * one would refuse it as a replay.
 */
export function composeNoticesPayload({ notices, previous = null, now = new Date(), validDays = DEFAULT_NOTICES_VALID_DAYS }) {
  if (!Number.isInteger(validDays) || validDays < 1 || validDays > 365) throw new Error('validity must be 1 to 365 days');
  const issuedAt = now.toISOString();
  if (previous && Date.parse(previous.issuedAt) >= now.getTime()) {
    throw new Error(`the last feed was issued on ${previous.issuedAt}, not before now: the apps would refuse this one as older`);
  }
  const expiresAt = new Date(now.getTime() + validDays * 86_400_000).toISOString();
  return validateNoticesPayload({ schema: NOTICES_SCHEMA, issuedAt, expiresAt, notices });
}

const signedBytes = (payloadBytes) => Buffer.concat([Buffer.from(NOTICES_SIGNATURE_DOMAIN, 'utf8'), payloadBytes]);

/** The envelope, ready to be written as `timon-notices.json`. `key` comes from releaseKeyPair(). */
export function signNoticesPayload(payload, { privateKey, keyId }) {
  if (typeof keyId !== 'string' || !KEY_ID.test(keyId)) throw new Error('invalid keyId');
  const bytes = Buffer.from(JSON.stringify(validateNoticesPayload(payload)), 'utf8');
  return { keyId, payload: bytes.toString('base64'), sig: sign(null, signedBytes(bytes), privateKey).toString('base64') };
}

function strictBase64(value, where) {
  if (typeof value !== 'string' || !value.length || value.length % 4 !== 0 || !BASE64.test(value)) fail(`${where} is not base64`);
  return Buffer.from(value, 'base64');
}

/**
 * Verifies a feed (its text or the parsed envelope) against a keyring of
 * `{ keyId, publicKey (PEM), expiresAt? }` and returns the payload. The
 * signature is checked BEFORE the payload is parsed; any failure throws and
 * the caller shows no notice of it.
 *
 * - `now`: an expired feed or key is refused, an `issuedAt` more than
 *   CLOCK_SKEW_MS ahead too;
 * - `minIssuedAt`: the highest `issuedAt` already accepted (anti-rollback); an
 *   older feed is refused, an equal one accepted (the same feed read again);
 * - `allowExpired`: only for the release machine, which reads back the last
 *   feed it published, however old.
 */
export function verifyNoticesFeed(input, keyring, { now = new Date(), minIssuedAt = null, allowExpired = false } = {}) {
  let envelope = input;
  if (typeof input === 'string' || Buffer.isBuffer(input)) {
    if (input.length > NOTICES_ENVELOPE_MAX) fail('envelope too large');
    try { envelope = JSON.parse(input.toString()); } catch { fail('envelope is not JSON'); }
  }
  exactKeys(envelope, ['keyId', 'payload', 'sig'], 'envelope');
  if (typeof envelope.keyId !== 'string') fail('keyId must be a string');
  const key = (keyring ?? []).find((entry) => entry.keyId === envelope.keyId);
  if (!key) fail(`unknown keyId ${JSON.stringify(envelope.keyId).slice(0, 80)}`);
  if (!allowExpired && key.expiresAt && Date.parse(key.expiresAt) <= now.getTime()) fail(`key ${key.keyId} has expired`);
  const bytes = strictBase64(envelope.payload, 'payload');
  const signature = strictBase64(envelope.sig, 'sig');
  if (signature.length !== 64 || !verify(null, signedBytes(bytes), key.publicKey, signature)) fail('invalid signature');
  let payload;
  try { payload = JSON.parse(bytes.toString('utf8')); } catch { fail('payload is not JSON'); }
  validateNoticesPayload(payload);
  const issued = Date.parse(payload.issuedAt);
  if (!allowExpired && Date.parse(payload.expiresAt) <= now.getTime()) fail(`expired on ${payload.expiresAt}`);
  if (!allowExpired && issued > now.getTime() + CLOCK_SKEW_MS) fail(`issued in the future (${payload.issuedAt})`);
  if (minIssuedAt && issued < Date.parse(minIssuedAt)) fail(`older than the last accepted feed (${payload.issuedAt} < ${minIssuedAt})`);
  return payload;
}

/**
 * The notices a build shows at `now`: inside its window, for its channel, its
 * version within the bounds. A `dev` build matches no channel.
 */
export function activeNotices(payload, { channel, version, now = new Date() }) {
  const at = now.getTime();
  return payload.notices.filter((notice) => {
    if (notice.startsAt && Date.parse(notice.startsAt) > at) return false;
    if (notice.endsAt && Date.parse(notice.endsAt) <= at) return false;
    if (notice.channels && !notice.channels.includes(channel)) return false;
    if ((notice.minVersion || notice.maxVersion) && !isVersion(version)) return false;
    if (notice.minVersion && compareVersions(version, notice.minVersion) < 0) return false;
    if (notice.maxVersion && compareVersions(version, notice.maxVersion) > 0) return false;
    return true;
  });
}
