/**
 * Retention of the mission history and of the raw memory facts: off by
 * default, and once on, it deletes what is past the horizon and nothing else —
 * never a running mission's history.
 */
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A home of its own: the test counts rows in `events` and attaches a database,
// which another file sharing the suite's home would skew.
process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-data-retention-'));
import { randomUUID } from 'node:crypto';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.TIMON_EVENTS_RETENTION_DAYS;
delete process.env.TIMON_LEARNINGS_RETENTION_DAYS;

const { db, dbApi, attachEventsArchive } = await import('./db.js');
const { invalidateSettingsCache } = await import('./settings.js');
const { pruneOldEvents, pruneOldLearnings, runDataRetention } = await import('./data-retention.js');
const { agentMemoryFile, agentMemoryDir } = await import('./paths.js');

const DAY = 86_400_000;
const NOW = Date.now();
const OLD = NOW - 40 * DAY;

const setDays = (events: number | null, learnings: number | null) => {
  if (events === null) delete process.env.TIMON_EVENTS_RETENTION_DAYS;
  else process.env.TIMON_EVENTS_RETENTION_DAYS = String(events);
  if (learnings === null) delete process.env.TIMON_LEARNINGS_RETENTION_DAYS;
  else process.env.TIMON_LEARNINGS_RETENTION_DAYS = String(learnings);
  invalidateSettingsCache();
};

beforeEach(() => {
  db.exec('DELETE FROM mission_search; DELETE FROM events; DELETE FROM learnings;');
  setDays(null, null);
});

const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;

/** A mission with one old and one recent event, each indexed by the history search. */
function missionWithHistory(running: boolean): { id: string; oldEvent: number; newEvent: number } {
  const id = randomUUID();
  dbApi.createMission(id, 'retention-witness', 'retention witness mission');
  const oldEvent = dbApi.insertEvent(id, 'assistant', { text: 'old' }).id;
  const newEvent = dbApi.insertEvent(id, 'assistant', { text: 'new' }).id;
  db.prepare('UPDATE events SET timestamp = ? WHERE id = ?').run(OLD, oldEvent);
  const index = db.prepare(`INSERT INTO mission_search (mission_id, event_id, seq, role, ts, text) VALUES (?, ?, 0, 'assistant', ?, ?)`);
  index.run(id, oldEvent, OLD, `old text ${id}`);
  index.run(id, newEvent, NOW, `new text ${id}`);
  if (!running) dbApi.finishMission(id, 'completed', 0);
  return { id, oldEvent, newEvent };
}

test('both retentions are off by default: nothing is deleted', async () => {
  const done = missionWithHistory(false);
  dbApi.insertLearning({ agent: 'retention-witness', kind: 'pitfall', text: 'old fact', ts: OLD });

  const outcome = await runDataRetention({ now: NOW, pauseMs: 0 });

  assert.deepEqual(outcome, { events: 0, learnings: 0, learningLines: 0 });
  assert.equal(count('SELECT COUNT(*) n FROM events WHERE mission_id = ?', done.id), 2);
  assert.equal(count('SELECT COUNT(*) n FROM learnings'), 1);
});

test('events past the retention go with their search text; a running mission keeps everything', () => {
  const done = missionWithHistory(false);
  const live = missionWithHistory(true);
  setDays(30, null);

  assert.equal(pruneOldEvents(NOW), 1);

  assert.deepEqual((db.prepare('SELECT id FROM events WHERE mission_id = ?').all(done.id) as { id: number }[]).map((r) => r.id), [done.newEvent]);
  assert.equal(count('SELECT COUNT(*) n FROM mission_search WHERE event_id = ?', done.oldEvent), 0);
  assert.equal(count('SELECT COUNT(*) n FROM mission_search WHERE event_id = ?', done.newEvent), 1);
  assert.equal(count('SELECT COUNT(*) n FROM mission_search_fts WHERE mission_search_fts MATCH ?', `"old text ${done.id}"`), 0);
  assert.equal(count('SELECT COUNT(*) n FROM events WHERE mission_id = ?', live.id), 2, 'a running mission is never pruned');
});

test('archived events past the retention are deleted too', () => {
  mkdirSync(join(process.env.TIMON_HOME!, 'archive'), { recursive: true });
  attachEventsArchive(join(process.env.TIMON_HOME!, 'archive', 'events.db'));
  const id = randomUUID();
  dbApi.createMission(id, 'retention-witness', 'archived mission');
  dbApi.finishMission(id, 'completed', 0);
  db.prepare(`INSERT INTO archive.events (id, mission_id, type, timestamp, payload) VALUES (?, ?, 'assistant', ?, '{}')`)
    .run(9_000_001, id, OLD);
  db.prepare(`INSERT INTO archive.events (id, mission_id, type, timestamp, payload) VALUES (?, ?, 'assistant', ?, '{}')`)
    .run(9_000_002, id, NOW);
  setDays(30, null);

  assert.equal(pruneOldEvents(NOW), 1);
  assert.deepEqual((db.prepare('SELECT id FROM archive.events WHERE mission_id = ?').all(id) as { id: number }[]).map((r) => r.id), [9_000_002]);
});

test('a large backlog is deleted in slices until nothing is left', async () => {
  const done = missionWithHistory(false);
  const extra = db.prepare(`INSERT INTO events (mission_id, type, timestamp, payload) VALUES (?, 'assistant', ?, '{}')`);
  for (let i = 0; i < 25; i++) extra.run(done.id, OLD);
  setDays(30, null);

  const outcome = await runDataRetention({ now: NOW, sliceRows: 10, pauseMs: 0 });

  assert.equal(outcome.events, 26);
  assert.equal(count('SELECT COUNT(*) n FROM events WHERE mission_id = ?', done.id), 1);
});

test('raw facts past the retention go, from the database and from the agents\' files', () => {
  const agent = 'retention-agent';
  mkdirSync(agentMemoryDir(agent), { recursive: true });
  dbApi.insertLearning({ agent, kind: 'pitfall', text: 'old fact', ts: OLD });
  dbApi.insertLearning({ agent, kind: 'pitfall', text: 'new fact', ts: NOW });

  const recent = agentMemoryFile(agent, 'learnings.jsonl');
  writeFileSync(recent, [
    JSON.stringify({ kind: 'pitfall', text: 'old dated', ts: new Date(OLD).toISOString() }),
    JSON.stringify({ kind: 'pitfall', text: 'new dated', ts: new Date(NOW).toISOString() }),
    JSON.stringify({ kind: 'pitfall', text: 'undated in a recent file' }),
  ].join('\n') + '\n');
  // An undated line is as old as the file's last write at most.
  const stale = agentMemoryFile(agent, 'learnings.archive.jsonl');
  writeFileSync(stale, JSON.stringify({ kind: 'decision', text: 'undated in an old file' }) + '\n');
  utimesSync(stale, new Date(OLD), new Date(OLD));
  setDays(null, 30);

  assert.deepEqual(pruneOldLearnings(NOW), { rows: 1, lines: 2 });

  assert.deepEqual((db.prepare('SELECT text FROM learnings').all() as { text: string }[]).map((r) => r.text), ['new fact']);
  const kept = readFileSync(recent, 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { text: string }).text);
  assert.deepEqual(kept, ['new dated', 'undated in a recent file']);
  assert.equal(readFileSync(stale, 'utf8'), '');
});

test('a zero setting keeps everything', () => {
  dbApi.insertLearning({ agent: 'retention-witness', kind: 'pitfall', text: 'old fact', ts: OLD });
  setDays(0, 0);
  assert.equal(pruneOldEvents(NOW), 0);
  assert.deepEqual(pruneOldLearnings(NOW), { rows: 0, lines: 0 });
  assert.equal(count('SELECT COUNT(*) n FROM learnings'), 1);
});
