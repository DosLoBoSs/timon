import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STALE_AFTER_MS, checkLocalUpdatesIfStale, checkUpdatesIfStale, updateCheckDue } from './update-freshness.js';

const now = Date.parse('2026-11-17T10:00:00.000Z');
const ago = (ms: number): string => new Date(now - ms).toISOString();

test('a success older than 30 min, a failure or no verdict yet call for a check', () => {
  assert.equal(updateCheckDue({ state: 'up_to_date', checkedAt: ago(STALE_AFTER_MS + 1) }, now), true);
  assert.equal(updateCheckDue({ state: 'available', checkedAt: ago(2 * 3_600_000) }, now), true);
  assert.equal(updateCheckDue({ state: 'failed', checkedAt: ago(60_000) }, now), true, 'the last success is unknown');
  assert.equal(updateCheckDue({ state: 'unchecked', checkedAt: null }, now), true);
  assert.equal(updateCheckDue({ state: 'up_to_date', checkedAt: null }, now), true);
});

test('a recent success, off, a source build or an unreadable status call for nothing', () => {
  assert.equal(updateCheckDue({ state: 'up_to_date', checkedAt: ago(STALE_AFTER_MS - 1) }, now), false);
  assert.equal(updateCheckDue({ state: 'available', checkedAt: ago(5 * 60_000) }, now), false);
  assert.equal(updateCheckDue({ state: 'off', checkedAt: null }, now), false);
  assert.equal(updateCheckDue({ state: 'dev', checkedAt: null }, now), false);
  assert.equal(updateCheckDue('<html>', now), false);
  assert.equal(updateCheckDue(null, now), false);
});

test('on reconnection, a stale status runs one check; a fresh one none', async () => {
  let checks = 0;
  const requestCheck = async (): Promise<number> => { checks += 1; return 200; };
  const stale = await checkUpdatesIfStale({ readStatus: async () => ({ state: 'up_to_date', checkedAt: ago(45 * 60_000) }), requestCheck, now: () => now });
  assert.equal(stale, 'checked: 200');
  const fresh = await checkUpdatesIfStale({ readStatus: async () => ({ state: 'up_to_date', checkedAt: ago(10 * 60_000) }), requestCheck, now: () => now });
  assert.equal(fresh, 'skipped: recent enough');
  assert.equal(checks, 1);
});

test('a daemon that cannot be asked, or a check that fails, is a log line', async () => {
  const unreadable = await checkUpdatesIfStale({ readStatus: async () => { throw new Error('daemon answered 404'); }, requestCheck: async () => 200 });
  assert.equal(unreadable, 'skipped: status unreadable (daemon answered 404)');
  const failed = await checkUpdatesIfStale({ readStatus: async () => ({ state: 'failed', checkedAt: null }), requestCheck: async () => { throw new TypeError('fetch failed'); } });
  assert.equal(failed, 'failed: fetch failed');
});

test('the local daemon is asked with its token, on the loopback only, and the check takes no body', async () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-update-freshness-'));
  writeFileSync(join(home, 'daemon-token'), 'secret\n');
  const seen: { url: string; init?: RequestInit }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), init });
    if (init?.method === 'POST') return new Response('{"state":"up_to_date"}', { status: 200 });
    return new Response(JSON.stringify({ state: 'failed', checkedAt: new Date().toISOString() }), { status: 200 });
  }) as typeof fetch;
  assert.equal(await checkLocalUpdatesIfStale('http://127.0.0.1:3001', home, fetcher), 'checked: 200');
  assert.deepEqual(seen.map((call) => [call.init?.method, call.url]), [
    ['GET', 'http://127.0.0.1:3001/api/updates'],
    ['POST', 'http://127.0.0.1:3001/api/updates/check'],
  ]);
  assert.deepEqual(seen[1]!.init?.headers, { Authorization: 'Bearer secret' });
  assert.equal(seen[1]!.init?.body, undefined);

  seen.length = 0;
  assert.match(await checkLocalUpdatesIfStale('http://192.168.1.5:3001', home, fetcher), /skipped: status unreadable \(not a local daemon\)/);
  assert.equal(seen.length, 0, 'the token never leaves the loopback');
});
