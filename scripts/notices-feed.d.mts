import type { KeyObject } from 'node:crypto';
import type { ReleaseChannel, ReleasePublicKey } from './release-manifest.mjs';

export type NoticeTone = 'info' | 'warning' | 'success';
export type NoticeIcon = 'github' | 'discord' | 'timon' | 'x' | 'youtube';
export interface FeedNotice {
  id: string;
  tone: NoticeTone;
  title: string;
  body: string;
  icon?: NoticeIcon;
  link?: string;
  startsAt?: string;
  endsAt?: string;
  channels?: ReleaseChannel[];
  minVersion?: string;
  maxVersion?: string;
}
export interface NoticesPayload { schema: 1; issuedAt: string; expiresAt: string; notices: FeedNotice[] }
export interface NoticesEnvelope { keyId: string; payload: string; sig: string }

export const NOTICES_SCHEMA: 1;
export const NOTICES_SIGNATURE_DOMAIN: string;
export const NOTICES_URL: string;
export const NOTICE_TITLE_MAX: number;
export const NOTICE_BODY_MAX: number;
export const NOTICE_LINK_MAX: number;
export const NOTICES_MAX: number;
export const NOTICES_ENVELOPE_MAX: number;
export const CLOCK_SKEW_MS: number;
export const DEFAULT_NOTICES_VALID_DAYS: number;
export const TONES: readonly NoticeTone[];
export const NOTICE_ICONS: readonly NoticeIcon[];
export const NOTICE_ID: RegExp;
export function isNoticeLink(value: unknown): boolean;
export function validateNoticesPayload(payload: unknown): NoticesPayload;
export function composeNoticesPayload(input: { notices: unknown[]; previous?: NoticesPayload | null; now?: Date; validDays?: number }): NoticesPayload;
export function signNoticesPayload(payload: NoticesPayload, key: { privateKey: KeyObject; keyId: string }): NoticesEnvelope;
export function verifyNoticesFeed(input: string | Buffer | NoticesEnvelope, keyring: readonly ReleasePublicKey[], options?: { now?: Date; minIssuedAt?: string | null; allowExpired?: boolean }): NoticesPayload;
export function activeNotices(payload: NoticesPayload, build: { channel: string; version: string; now?: Date }): FeedNotice[];
