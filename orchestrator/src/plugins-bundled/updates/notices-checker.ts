/**
 * The announcements of the signed notice feed (docs/AUTO-UPDATE.md §10),
 * fetched and held for the notice cards of the app.
 *
 * Same request discipline as the update check (checker.ts): one GET, a generic
 * User-Agent and nothing else (no licence, installation id, machine
 * fingerprint or cookie), redirects followed by hand to https only, the body
 * capped, and not a byte of the payload read before its signature checks out.
 *
 * Anti-rollback: the highest `issuedAt` accepted is kept in
 * `<home>/updates/notices-state.json`, apart from the update state so neither
 * writer can drop the other's field. An older feed is refused: a replayed one
 * can neither bring back a withdrawn notice nor hide a newer one.
 *
 * A failed fetch shows nothing of what it fetched. The last feed verified stays
 * until it expires, so a network glitch does not take a card down, and a forged
 * feed can add nothing.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { BuildChannel } from '../../build-info.js';
import { fetchManifest, readCapped, type FetchLike } from './checker.js';
import type { ReleasePublicKey } from './manifest.js';
import { NOTICES_ENVELOPE_MAX, NOTICES_URL, activeNotices, verifyNoticesFeed, type NoticeIcon, type NoticesPayload } from './notices-feed.js';

/** What the app receives: text to show as text, a link to open, never to run. */
export type RemoteNotice = {
  id: string;
  tone: 'info' | 'warning' | 'success';
  title: string;
  body: string;
  /** A brand logo the app draws itself, from a closed list; `null`: the tone's icon. */
  icon: NoticeIcon | null;
  link: string | null;
  endsAt: string | null;
};

export type NoticesDeps = {
  /** Both settings: the update check and the announcements. */
  enabled: () => boolean;
  channel: () => BuildChannel;
  installed: () => string;
  keyring: () => readonly ReleasePublicKey[];
  stateFile: string;
  fetch?: FetchLike;
  now?: () => Date;
  url?: string;
  log?: (message: string) => void;
};

const Persisted = z.object({ lastIssuedAt: z.string().nullable().catch(null) });
type PersistedState = z.infer<typeof Persisted>;

export class NoticesFeed {
  private payload: NoticesPayload | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly deps: NoticesDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Off, or a build run from the sources: no request, no notice. */
  private allowed(): boolean {
    return this.deps.channel() !== 'dev' && this.deps.enabled();
  }

  readState(): PersistedState {
    try {
      return Persisted.parse(JSON.parse(readFileSync(this.deps.stateFile, 'utf8')) as unknown);
    } catch {
      return { lastIssuedAt: null };
    }
  }

  private writeState(state: PersistedState): void {
    mkdirSync(dirname(this.deps.stateFile), { recursive: true });
    const tmp = `${this.deps.stateFile}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(tmp, this.deps.stateFile);
  }

  /** The notices this build shows now; none when off or when the last verified feed expired. */
  notices(): RemoteNotice[] {
    if (!this.allowed() || !this.payload) return [];
    const now = this.now();
    if (Date.parse(this.payload.expiresAt) <= now.getTime()) return [];
    const channel = this.deps.channel() as 'beta' | 'stable';
    return activeNotices(this.payload, { channel, version: this.deps.installed(), now }).map((notice) => ({
      id: notice.id,
      tone: notice.tone,
      title: notice.title,
      body: notice.body,
      icon: notice.icon ?? null,
      link: notice.link ?? null,
      endsAt: notice.endsAt ?? null,
    }));
  }

  /** One fetch; concurrent callers share it. Never throws. */
  refresh(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }

  private async run(): Promise<void> {
    if (!this.allowed()) return;
    const log = this.deps.log ?? ((message: string) => console.warn(`[updates] ${message}`));
    try {
      const res = await fetchManifest(this.deps.fetch ?? fetch, this.deps.url ?? NOTICES_URL);
      if (!res.ok) throw new Error(`notice feed HTTP ${res.status}`);
      const body = await readCapped(res, NOTICES_ENVELOPE_MAX);
      const persisted = this.readState();
      const payload = verifyNoticesFeed(body, this.deps.keyring(), { now: this.now(), minIssuedAt: persisted.lastIssuedAt });
      if (!persisted.lastIssuedAt || Date.parse(payload.issuedAt) > Date.parse(persisted.lastIssuedAt)) {
        this.writeState({ lastIssuedAt: payload.issuedAt });
      }
      this.payload = payload;
    } catch (error) {
      log(`no notice taken from the feed: ${(error as Error).message}`);
    }
  }
}

export const noticesStateFileIn = (home: string): string => join(home, 'updates', 'notices-state.json');
