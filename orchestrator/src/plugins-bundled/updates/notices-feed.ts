/**
 * Verification of the signed notice feed, `timon-notices.json`
 * (docs/AUTO-UPDATE.md §10): announcements published without a release.
 *
 * The format is owned by `scripts/notices-feed.mjs`, which composes and signs
 * it on the release machine. That file cannot be imported here (the daemon
 * compiles `src/` alone); this is its verifying half in TypeScript, the payload
 * schema mirrored in zod, and `notices-feed.test.ts` runs both on the same
 * envelopes so they cannot drift apart.
 *
 * Same key and envelope as `releases.json` (manifest.ts), under a signature
 * domain of its own: a manifest signature is never accepted as a feed, nor
 * the reverse. Depends on `node:crypto` and zod only: no file, no network.
 */
import { verify } from 'node:crypto';
import { z } from 'zod';
import { CLOCK_SKEW_MS, compareVersions, isVersion, type ReleaseChannel, type ReleasePublicKey } from './manifest.js';

export const NOTICES_SCHEMA = 1;
export const NOTICES_SIGNATURE_DOMAIN = 'timon-notices-v1\0';
export const NOTICES_URL = 'https://timon-ai.com/.well-known/timon-notices.json';
/** The cards' own limits (app/src/lib/notices.ts). */
export const NOTICE_TITLE_MAX = 120;
export const NOTICE_BODY_MAX = 400;
export const NOTICE_LINK_MAX = 2048;
export const NOTICES_MAX = 20;
export const NOTICES_ENVELOPE_MAX = 128 * 1024;
/** The brand logos a card draws itself: a closed list, never an address to load. */
export const NOTICE_ICONS = ['github', 'discord', 'timon', 'x', 'youtube'] as const;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const NOTICE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Plain text: no control character but a line break in the body.
const TITLE_TEXT = /^[^\u0000-\u001f\u007f]+$/;
const BODY_TEXT = /^[^\u0000-\u0009\u000b-\u001f\u007f]+$/;

const fail = (message: string): never => { throw new Error(`timon-notices.json: ${message}`); };

const IsoDate = z.string().refine((value) => ISO.test(value) && !Number.isNaN(Date.parse(value)), 'must be an ISO 8601 UTC date');

/** An https address without credentials; a query or a fragment is fine, the link is only ever opened. */
export function isNoticeLink(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > NOTICE_LINK_MAX) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === 'https:' && !url.username && !url.password && Boolean(url.hostname);
}

const FeedNotice = z.object({
  id: z.string().regex(NOTICE_ID, "must be 1-64 letters, digits, '.', '_' or '-'"),
  tone: z.enum(['info', 'warning', 'success']),
  title: z.string().max(NOTICE_TITLE_MAX).regex(TITLE_TEXT, 'must be one line').refine((value) => value.trim().length > 0, 'is empty'),
  body: z.string().max(NOTICE_BODY_MAX).regex(BODY_TEXT, 'must be plain text').refine((value) => value.trim().length > 0, 'is empty'),
  icon: z.enum(NOTICE_ICONS).optional(),
  link: z.string().refine(isNoticeLink, 'must be an https: address without credentials').optional(),
  startsAt: IsoDate.optional(),
  endsAt: IsoDate.optional(),
  channels: z.array(z.enum(['beta', 'stable'])).min(1).refine((list) => new Set(list).size === list.length, 'lists a channel twice').optional(),
  minVersion: z.string().refine(isVersion, 'is not x.y.z[-rc.N]').optional(),
  maxVersion: z.string().refine(isVersion, 'is not x.y.z[-rc.N]').optional(),
}).strict().superRefine((notice, ctx) => {
  if (notice.startsAt && notice.endsAt && Date.parse(notice.startsAt) >= Date.parse(notice.endsAt)) {
    ctx.addIssue({ code: 'custom', message: 'endsAt must follow startsAt' });
  }
  if (notice.minVersion && notice.maxVersion && compareVersions(notice.minVersion, notice.maxVersion) > 0) {
    ctx.addIssue({ code: 'custom', message: 'minVersion must not exceed maxVersion' });
  }
});

export const NoticesPayloadSchema = z.object({
  schema: z.literal(NOTICES_SCHEMA),
  issuedAt: IsoDate,
  expiresAt: IsoDate,
  notices: z.array(FeedNotice).max(NOTICES_MAX),
}).strict().superRefine((payload, ctx) => {
  if (Date.parse(payload.issuedAt) >= Date.parse(payload.expiresAt)) ctx.addIssue({ code: 'custom', message: 'expiresAt must follow issuedAt' });
  const ids = new Set<string>();
  for (const notice of payload.notices) {
    if (ids.has(notice.id)) ctx.addIssue({ code: 'custom', message: `notice id ${notice.id} is used twice` });
    ids.add(notice.id);
  }
});

export type NoticesPayload = z.infer<typeof NoticesPayloadSchema>;
export type FeedNotice = z.infer<typeof FeedNotice>;
export type NoticeIcon = (typeof NOTICE_ICONS)[number];

export function validateNoticesPayload(payload: unknown): NoticesPayload {
  const parsed = NoticesPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fail(`${issue?.path.join('.') || 'payload'} ${issue?.message ?? 'is invalid'}`);
  }
  return parsed.data;
}

const Envelope = z.object({ keyId: z.string(), payload: z.unknown(), sig: z.unknown() }).strict();

function strictBase64(value: unknown, where: string): Buffer {
  if (typeof value !== 'string' || !value.length || value.length % 4 !== 0 || !BASE64.test(value)) return fail(`${where} is not base64`);
  return Buffer.from(value, 'base64');
}

const signedBytes = (payloadBytes: Buffer): Buffer => Buffer.concat([Buffer.from(NOTICES_SIGNATURE_DOMAIN, 'utf8'), payloadBytes]);

export type VerifyNoticesOptions = {
  now?: Date;
  /** The highest `issuedAt` already accepted: an older feed is refused, an equal one accepted. */
  minIssuedAt?: string | null;
};

/**
 * The payload of a verified feed. The signature is checked BEFORE the payload
 * is parsed; every failure throws, and the caller shows no notice of it. No
 * `allowExpired`: the daemon never reads an expired feed.
 */
export function verifyNoticesFeed(input: string | Buffer | unknown, keyring: readonly ReleasePublicKey[], options: VerifyNoticesOptions = {}): NoticesPayload {
  const now = options.now ?? new Date();
  let envelope: unknown = input;
  if (typeof input === 'string' || Buffer.isBuffer(input)) {
    if (input.length > NOTICES_ENVELOPE_MAX) fail('envelope too large');
    try { envelope = JSON.parse(input.toString()) as unknown; } catch { fail('envelope is not JSON'); }
  }
  const parsed = Envelope.safeParse(envelope);
  if (!parsed.success) return fail('envelope must be exactly { keyId, payload, sig }');
  const { keyId } = parsed.data;
  const key = keyring.find((entry) => entry.keyId === keyId);
  if (!key) return fail(`unknown keyId ${JSON.stringify(keyId).slice(0, 80)}`);
  if (key.expiresAt && Date.parse(key.expiresAt) <= now.getTime()) fail(`key ${key.keyId} has expired`);
  const bytes = strictBase64(parsed.data.payload, 'payload');
  const signature = strictBase64(parsed.data.sig, 'sig');
  if (signature.length !== 64 || !verify(null, signedBytes(bytes), key.publicKey, signature)) fail('invalid signature');
  let payload: unknown;
  try { payload = JSON.parse(bytes.toString('utf8')) as unknown; } catch { fail('payload is not JSON'); }
  const valid = validateNoticesPayload(payload);
  const issued = Date.parse(valid.issuedAt);
  if (Date.parse(valid.expiresAt) <= now.getTime()) fail(`expired on ${valid.expiresAt}`);
  if (issued > now.getTime() + CLOCK_SKEW_MS) fail(`issued in the future (${valid.issuedAt})`);
  if (options.minIssuedAt && issued < Date.parse(options.minIssuedAt)) {
    fail(`older than the last accepted feed (${valid.issuedAt} < ${options.minIssuedAt})`);
  }
  return valid;
}

/**
 * The notices a build shows at `now`: inside their window, for its channel,
 * its version within the bounds.
 */
export function activeNotices(payload: NoticesPayload, build: { channel: ReleaseChannel; version: string; now: Date }): FeedNotice[] {
  const at = build.now.getTime();
  return payload.notices.filter((notice) => {
    if (notice.startsAt && Date.parse(notice.startsAt) > at) return false;
    if (notice.endsAt && Date.parse(notice.endsAt) <= at) return false;
    if (notice.channels && !notice.channels.includes(build.channel)) return false;
    if ((notice.minVersion || notice.maxVersion) && !isVersion(build.version)) return false;
    if (notice.minVersion && compareVersions(build.version, notice.minVersion) < 0) return false;
    if (notice.maxVersion && compareVersions(build.version, notice.maxVersion) > 0) return false;
    return true;
  });
}
