/**
 * `backend_fallback` on the bus: published where an actor really moves to its
 * fallback (a spawn redirect, a series switch), never where the cascade is only
 * asked a question. The telemetry's `fallback_used` counts these, so a question
 * counted as a move, or a move announced twice, would skew it.
 *
 * The database opens in a temporary TIMON_HOME: imports are dynamic, after the
 * environment is set.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-fallback-event-test-'));
process.env.TIMON_FALLBACK_ENABLED = '1';
process.env.TIMON_FALLBACK_BACKEND = 'codex';
process.env.TIMON_FALLBACK_MODEL = '';
process.env.TIMON_FALLBACK_COOLDOWN_MS = '3600000';

const { dbApi } = await import('./db.js');
const { bus } = await import('./bus.js');
type BusEvent = import('./bus.js').BusEvent;
const { mountOfficialProviders, stubCliBinaries } = await import('../tests/helpers/official-providers.js');
await stubCliBinaries('grok');
await mountOfficialProviders();
const {
  noteBackendRateLimit, clearBackendCooldown, fallbackFor, redirectIfExhausted, redirectTaskSpawn,
  redirectIfStillDry, backendResumeRoute, switchSeriesToFallback,
} = await import('./backend-fallback.js');
const { setBackendBinaryAvailabilityForTest } = await import('./backends/binary-check.js');
const { setUsageProbeForTest } = await import('./backend-recheck.js');
setBackendBinaryAvailabilityForTest(() => true);
// No provider is asked anything: the registry alone says what is dry.
setUsageProbeForTest(async () => null);

const hit = { kind: 'rate_limit' as const, window: 'five_hour', resetsAt: null, source: 'event' as const, pending: false };

/** The `backend_fallback` events published while `run` runs. */
async function fallbacksDuring(run: () => unknown): Promise<Extract<BusEvent, { kind: 'backend_fallback' }>[]> {
  const seen: Extract<BusEvent, { kind: 'backend_fallback' }>[] = [];
  const listener = (ev: BusEvent): void => { if (ev.kind === 'backend_fallback') seen.push(ev); };
  bus.on('event', listener);
  try { await run(); } finally { bus.off('event', listener); }
  return seen;
}

function resetCooldowns(): void {
  for (const name of ['claude', 'codex', 'grok']) clearBackendCooldown(name);
}

test('a spawn redirected off a dry backend announces one move, from it to the fallback', async () => {
  resetCooldowns();
  noteBackendRateLimit('grok', hit);
  try {
    const scope = { seriesId: null, scope: 'code' as const, fromModel: null };
    let target: Awaited<ReturnType<typeof redirectTaskSpawn>> = null;
    const events = await fallbacksDuring(async () => { target = await redirectTaskSpawn('grok', scope); });
    assert.ok(target, 'the dry backend is redirected');
    assert.deepEqual(events, [{ kind: 'backend_fallback', fromBackend: 'grok', toBackend: target!.backend }]);
  } finally {
    resetCooldowns();
  }
});

test("a pilot's wake redirected off a dry backend announces its move too", async () => {
  resetCooldowns();
  noteBackendRateLimit('grok', hit);
  try {
    const events = await fallbacksDuring(() => redirectIfStillDry('grok', { seriesId: null, scope: 'orchestrator', fromModel: null }));
    assert.equal(events.length, 1);
    assert.equal(events[0]!.fromBackend, 'grok');
  } finally {
    resetCooldowns();
  }
});

test('asking where a dry backend would go announces nothing: only a move is a fallback used', async () => {
  resetCooldowns();
  noteBackendRateLimit('grok', hit);
  try {
    const scope = { seriesId: null, scope: 'code' as const, fromModel: null };
    const events = await fallbacksDuring(() => {
      assert.ok(fallbackFor('grok', scope));
      assert.ok(redirectIfExhausted('grok', scope));
      assert.equal(backendResumeRoute('grok', scope), 'fallback');
    });
    assert.deepEqual(events, []);
  } finally {
    resetCooldowns();
  }
});

test('a spawn on a backend with quota left announces nothing', async () => {
  resetCooldowns();
  const events = await fallbacksDuring(() => redirectTaskSpawn('grok', { seriesId: null, scope: 'code', fromModel: null }));
  assert.deepEqual(events, []);
});

test('a series switch announces one move per task type moved, and a second pass none', async () => {
  resetCooldowns();
  const pilot = randomUUID();
  dbApi.createMission(pilot, 'a.main', 'pilot');
  dbApi.setMissionLlmOverrides(pilot, 'claude', 'claude-opus-5-5');
  const review = randomUUID();
  const review2 = randomUUID();
  dbApi.createTask(review, 'review one', 'a.reviewer', { creatorMissionId: pilot, type: 'review', backendOverride: 'codex' });
  dbApi.createTask(review2, 'review two', 'a.reviewer', { creatorMissionId: pilot, type: 'review', backendOverride: 'codex' });
  const seriesId = dbApi.seriesIdForMission(pilot)!;
  noteBackendRateLimit('codex', hit);
  try {
    const first = await fallbacksDuring(() => switchSeriesToFallback(seriesId, { pilotMissionId: pilot, reason: 'codex dry' }));
    const moved = dbApi.getTask(review)?.backend_override;
    assert.ok(moved && moved !== 'codex', 'the reviews leave the dry backend');
    // Two tasks of one type are one move; the pilot on claude is not governed.
    assert.deepEqual(first, [{ kind: 'backend_fallback', fromBackend: 'codex', toBackend: moved }]);

    const second = await fallbacksDuring(() => switchSeriesToFallback(seriesId, { pilotMissionId: pilot, reason: 'codex dry' }));
    assert.deepEqual(second, [], 'an idempotent pass moves nothing, so announces nothing');

    // The task spawns next on its new backend, which has quota: no second count.
    const spawn = await fallbacksDuring(() => redirectTaskSpawn(moved, { seriesId, scope: 'review', fromModel: null }));
    assert.deepEqual(spawn, []);
  } finally {
    resetCooldowns();
  }
});
