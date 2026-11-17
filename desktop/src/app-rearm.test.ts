import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonRevival, giveUpBox, nothingListens, recordingExec, requestAppRearm, serviceProgram, type RelaunchOutcome, type RevivalSeams } from './app-rearm.js';
import type { HealthResult } from './health.js';
import { instanceId } from './service.js';
import { startupText } from './startup-text.js';

function homeWithToken(token?: string): string {
  const home = mkdtempSync(join(tmpdir(), 'timon-rearm-'));
  if (token !== undefined) writeFileSync(join(home, 'daemon-token'), `${token}\n`);
  return home;
}

test('TODO #485: posts to the local daemon with the daemon token', async () => {
  const seen: { url: string; init?: RequestInit }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), init });
    return new Response(JSON.stringify({ ok: true, result: 'rearmed', message: 'starting again' }), { status: 200 });
  }) as typeof fetch;
  const line = await requestAppRearm('http://127.0.0.1:3001', homeWithToken('secret'), fetcher);
  assert.equal(line, '200 rearmed: starting again');
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, 'http://127.0.0.1:3001/api/app/rearm');
  assert.equal(seen[0]!.init?.method, 'POST');
  assert.deepEqual(seen[0]!.init?.headers, { Authorization: 'Bearer secret' });
});

test('TODO #485: never sends the token to a non-local origin', async () => {
  let called = false;
  const fetcher = (async () => { called = true; return new Response('{}'); }) as typeof fetch;
  assert.match(await requestAppRearm('http://192.168.1.5:3001', homeWithToken('secret'), fetcher), /skipped/);
  assert.match(await requestAppRearm('https://localhost:3001', homeWithToken('secret'), fetcher), /skipped/);
  assert.equal(called, false);
});

test('TODO #485: no token, an older daemon or a dead one: a log line, never a throw', async () => {
  const never = (async () => { throw new Error('must not be called'); }) as typeof fetch;
  assert.match(await requestAppRearm('http://127.0.0.1:3001', homeWithToken(), never), /skipped: daemon token unreadable/);
  const old = (async () => new Response('Cannot POST /api/app/rearm', { status: 404 })) as typeof fetch;
  assert.equal(await requestAppRearm('http://127.0.0.1:3001', homeWithToken('t'), old), '404');
  const dead = (async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }) as typeof fetch;
  assert.match(await requestAppRearm('http://127.0.0.1:3001', homeWithToken('t'), dead), /failed: connection refused/);
});

const REFUSED: HealthResult = { ok: false, status: null, error: 'connection refused: nothing listens on the port' };
const BUSY: HealthResult = { ok: false, status: null, error: 'connected, but no reply in time: the daemon is still starting, or busy' };

/** Seams around a fake daemon: `probes` answers in turn (the last one repeats), `waited` is what the bounded wait ends on. */
function revivalSeams(probes: HealthResult[], waited: HealthResult, outcome: Partial<RelaunchOutcome> = {}) {
  const calls = { relaunch: 0, wait: 0, relaunching: 0, probe: 0 };
  const lines: string[] = [];
  const seams: RevivalSeams = {
    probe: async () => probes[Math.min(calls.probe++, probes.length - 1)]!,
    relaunch: async () => { calls.relaunch++; return { line: 'start the service → started (schtasks /Run /TN TimonOrchestrator → exit 0)', selfReported: false, waited: false, ...outcome }; },
    wait: async () => { calls.wait++; return waited; },
    relaunching: () => { calls.relaunching++; },
    log: (line) => lines.push(line),
  };
  return { seams, calls, lines };
}

test('TIM-0154: only a refused connection means the daemon is gone', () => {
  assert.equal(nothingListens(REFUSED), true);
  assert.equal(nothingListens(BUSY), false);
  assert.equal(nothingListens({ ok: true, status: 200, identity: 'timon' }), false);
});

test('TIM-0154: the daemon answers but the interface does not: the dialog is the one it always was, no relaunch', async () => {
  const { seams, calls } = revivalSeams([{ ok: true, status: 200, identity: 'timon' }], REFUSED);
  const verdict = await new DaemonRevival().settle(seams);
  assert.deepEqual(verdict, { kind: 'ui-missing' });
  assert.equal(calls.relaunch, 0);
  const box = giveUpBox(verdict, startupText('en'), { giveUp: 'http://127.0.0.1:3110/ did not answer within 120s.', origin: 'http://127.0.0.1:3001', logs: 'unused' });
  assert.deepEqual(box, {
    message: 'The interface did not come up.',
    detail: 'http://127.0.0.1:3110/ did not answer within 120s.\n\nThe daemon may be running without its web app: quit and reopen Timon. If it persists, copy the diagnostic and send it to support.',
  });
});

test('TIM-0154: a busy daemon is not relaunched either', async () => {
  const { seams, calls } = revivalSeams([BUSY], REFUSED);
  assert.deepEqual(await new DaemonRevival().settle(seams), { kind: 'ui-missing' });
  assert.equal(calls.relaunch, 0);
});

test('TIM-0154: nothing listens: one relaunch, then "the background service is not running" with the logs folder', async () => {
  const revival = new DaemonRevival();
  const { seams, calls, lines } = revivalSeams([REFUSED], REFUSED);
  const verdict = await revival.settle(seams);
  assert.deepEqual(verdict, { kind: 'daemon-down', retried: true });
  assert.equal(calls.relaunch, 1);
  assert.equal(calls.wait, 1);
  assert.equal(calls.relaunching, 1);
  assert.ok(lines.some((line) => line.includes('relaunching it once')));
  assert.ok(lines.some((line) => line.includes('schtasks /Run /TN TimonOrchestrator → exit 0')));
  assert.ok(lines.some((line) => line.includes('daemon relaunch failed: connection refused')));
  const logs = join('C:', 'Users', 'sam', '.timon', 'tmp');
  const box = giveUpBox(verdict, startupText('en'), { giveUp: 'unused', origin: 'http://127.0.0.1:3001', logs });
  assert.equal(box?.message, 'The background service is not running.');
  assert.equal(box?.detail, `Nothing answers on http://127.0.0.1:3001, even after Timon started it again. Its logs are in ${logs}. If it persists, copy the diagnostic and send it to support.`);
  assert.doesNotMatch(box?.detail ?? '', /web app/);

  // A later give-up never relaunches again: no loop.
  const again = revivalSeams([REFUSED], REFUSED);
  assert.deepEqual(await revival.settle(again.seams), { kind: 'daemon-down', retried: true });
  assert.equal(again.calls.relaunch, 0);
});

test('TIM-0154: pages giving up together share the one relaunch', async () => {
  const revival = new DaemonRevival();
  const { seams, calls } = revivalSeams([REFUSED], REFUSED);
  const verdicts = await Promise.all([revival.settle(seams), revival.settle(seams), revival.settle(seams)]);
  assert.equal(calls.relaunch, 1);
  assert.equal(calls.relaunching, 3);
  for (const verdict of verdicts) assert.deepEqual(verdict, { kind: 'daemon-down', retried: true });
});

test('TIM-0154: a relaunch that brings the daemon back sends the page waiting again, once', async () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-revive-'));
  const revival = new DaemonRevival();
  const back: HealthResult = { ok: true, status: 200, identity: 'timon', instance: instanceId(home) };
  const { seams, calls, lines } = revivalSeams([REFUSED], back);
  assert.deepEqual(await revival.settle({ ...seams, home }), { kind: 'revived' });
  assert.equal(calls.relaunch, 1);
  assert.ok(lines.some((line) => line.endsWith('daemon relaunch succeeded')));
  // The daemon fell again: straight to the dialog this time.
  const again = revivalSeams([REFUSED], back);
  assert.deepEqual(await revival.settle({ ...again.seams, home }), { kind: 'daemon-down', retried: true });
  assert.equal(again.calls.relaunch, 0);
});

test('TIM-0154: another data directory answering after the relaunch is not a revival', async () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-revive-'));
  const { seams } = revivalSeams([REFUSED], { ok: true, status: 200, identity: 'timon', instance: 'someone-else' });
  assert.deepEqual(await new DaemonRevival().settle({ ...seams, home }), { kind: 'daemon-down', retried: true });
});

test('TIM-0154: the embedded relaunch already waited and reported its own failure: one probe, no second dialog', async () => {
  const { seams, calls } = revivalSeams([REFUSED], REFUSED, { selfReported: true, waited: true });
  const verdict = await new DaemonRevival().settle(seams);
  assert.deepEqual(verdict, { kind: 'reported' });
  assert.equal(calls.wait, 0);
  assert.equal(giveUpBox(verdict, startupText('en'), { giveUp: '', origin: '', logs: '' }), null);
});

test('TIM-0154: a relaunch that throws is logged and ends on the dialog', async () => {
  const lines: string[] = [];
  const verdict = await new DaemonRevival().settle({
    probe: async () => REFUSED,
    relaunch: async () => { throw new Error('spawn schtasks ENOENT'); },
    wait: async () => REFUSED,
    log: (line) => lines.push(line),
  });
  assert.deepEqual(verdict, { kind: 'daemon-down', retried: true });
  assert.ok(lines.includes('[desktop] daemon relaunch failed: spawn schtasks ENOENT'));
});

test('TIM-0154: nothing to relaunch: the dialog does not claim a second start', async () => {
  const verdict = await new DaemonRevival().settle({ probe: async () => REFUSED, relaunch: null, wait: async () => REFUSED, log: () => {} });
  assert.deepEqual(verdict, { kind: 'daemon-down', retried: false });
  const box = giveUpBox(verdict, startupText('en'), { giveUp: '', origin: 'http://127.0.0.1:3001', logs: 'logs' });
  assert.equal(box?.detail, 'Nothing answers on http://127.0.0.1:3001. Its logs are in logs. If it persists, copy the diagnostic and send it to support.');
});

test('TIM-0154: the service call and its exit code reach the log', async () => {
  const calls: string[] = [];
  const ok = recordingExec('schtasks', calls, async () => ({ stdout: 'SUCCESS' }));
  assert.deepEqual(await ok(['/Run', '/TN', 'TimonOrchestrator']), { stdout: 'SUCCESS' });
  const failing = recordingExec('systemctl', calls, async () => { throw Object.assign(new Error('failed'), { code: 5 }); });
  await assert.rejects(failing(['--user', 'start', 'timon.service']));
  assert.deepEqual(calls, ['schtasks /Run /TN TimonOrchestrator → exit 0', 'systemctl --user start timon.service → exit 5']);
  assert.equal(serviceProgram('win32'), 'schtasks');
  assert.equal(serviceProgram('darwin'), 'launchctl');
  assert.equal(serviceProgram('linux'), 'systemctl');
});
