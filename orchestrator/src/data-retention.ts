/**
 * Retention of what agents leave behind on the computer — off by default.
 *
 * Two settings, both `0` (keep everything) until someone asks otherwise:
 *  - `TIMON_EVENTS_RETENTION_DAYS`: the mission history (`events`, the cold
 *    archive included, and the text the history search copied from it);
 *  - `TIMON_LEARNINGS_RETENTION_DAYS`: the raw facts (`learnings` table, and
 *    the `learnings.jsonl` / `learnings.archive.jsonl` files of each agent).
 *
 * Unlike `TIMON_EVENTS_HOT_DAYS`, which moves events and loses nothing, this
 * deletes. A running mission is never touched. The provider sessions (Codex
 * rollouts) have their own retention, `TIMON_PROVIDER_SESSION_TTL_MS`.
 */
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dbApi } from './db.js';
import { AGENTS_DIR, agentMemoryFile } from './paths.js';
import { settingInt } from './settings.js';

const DAY = 86_400_000;
const LEARNING_FILES = ['learnings.jsonl', 'learnings.archive.jsonl'] as const;

export type RetentionOutcome = { events: number; learnings: number; learningLines: number };

/** Date of a learnings line, `null` when it carries none (agents write `{kind,text}` by hand). */
function lineDate(line: string): number | null {
  try {
    const ts = (JSON.parse(line) as { ts?: unknown }).ts;
    if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
    if (typeof ts === 'string') {
      const parsed = Date.parse(ts);
      return Number.isFinite(parsed) ? parsed : null;
    }
  } catch { /* an unreadable line is dated like an undated one */ }
  return null;
}

/**
 * Drops the lines of one learnings file older than `cutoff`. An undated line is
 * known to be older than the file's last write: it goes when that write is
 * itself past the cutoff. Returns the lines removed.
 */
function pruneLearningsFile(path: string, cutoff: number): number {
  let before: ReturnType<typeof statSync>;
  let content: string;
  try {
    before = statSync(path);
    content = readFileSync(path, 'utf8');
  } catch { return 0; }
  const lines = content.split('\n').filter((l) => l.trim());
  const keep = lines.filter((line) => (lineDate(line) ?? before.mtimeMs) >= cutoff);
  const removed = lines.length - keep.length;
  if (removed === 0) return 0;
  const tmp = `${path}.retention-tmp`;
  writeFileSync(tmp, keep.length ? keep.join('\n') + '\n' : '');
  // An agent appending meanwhile would lose its line to the rename: leave the
  // file for the next pass instead.
  const now = statSync(path);
  if (now.size !== before.size || now.mtimeMs !== before.mtimeMs) {
    rmSync(tmp, { force: true });
    return 0;
  }
  renameSync(tmp, path);
  return removed;
}

/** Raw facts older than the retention, in the database and in the agents' files. */
export function pruneOldLearnings(now = Date.now()): { rows: number; lines: number } {
  const days = settingInt('TIMON_LEARNINGS_RETENTION_DAYS');
  if (days <= 0) return { rows: 0, lines: 0 };
  const cutoff = now - days * DAY;
  const rows = dbApi.pruneLearnings(cutoff);
  let lines = 0;
  if (existsSync(AGENTS_DIR)) {
    for (const agent of readdirSync(AGENTS_DIR)) {
      for (const file of LEARNING_FILES) {
        let path: string;
        try { path = agentMemoryFile(agent, file); } catch { continue; }
        if (!existsSync(path)) continue;
        try { lines += pruneLearningsFile(path, cutoff); } catch (e) {
          console.warn(`[retention] could not prune ${path}: ${(e as Error).message}`);
        }
      }
    }
  }
  if (rows || lines) console.log(`[retention] ${rows} raw fact(s) and ${lines} learnings line(s) past retention deleted`);
  return { rows, lines };
}

/** One slice of the events past the retention, hot table first. */
export function pruneOldEvents(now = Date.now(), maxRows = 5_000): number {
  const days = settingInt('TIMON_EVENTS_RETENTION_DAYS');
  if (days <= 0) return 0;
  const cutoff = now - days * DAY;
  let dropped = dbApi.pruneEventsBatch('events', cutoff, maxRows);
  if (dropped < maxRows && dbApi.eventsArchiveAttached()) {
    dropped += dbApi.pruneEventsBatch('archive.events', cutoff, maxRows - dropped);
  }
  return dropped;
}

/**
 * The daily pass. Events go in slices, handing the event loop back between
 * two: the first pass on a large home deletes millions of rows, and
 * better-sqlite3 holds the whole daemon while it writes.
 */
export async function runDataRetention(opts: { now?: number; sliceRows?: number; pauseMs?: number; stopped?: () => boolean } = {}): Promise<RetentionOutcome> {
  const { now = Date.now(), sliceRows = 5_000, pauseMs = 200, stopped = () => false } = opts;
  const learnings = pruneOldLearnings(now);
  let events = 0;
  while (!stopped()) {
    const slice = pruneOldEvents(now, sliceRows);
    events += slice;
    if (slice < sliceRows) break;
    await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
  if (events) console.log(`[retention] ${events} mission event(s) past retention deleted`);
  return { events, learnings: learnings.rows, learningLines: learnings.lines };
}
