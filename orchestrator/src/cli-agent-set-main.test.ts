/**
 * `timon agent set-main` (TODO #852, TIM-0142 follow-up): the CLI relays the
 * name to `PUT /api/agents/main` and turns a refusal into one readable line.
 * Witness HTTP server on `127.0.0.1:0`, never the machine's daemon.
 */
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-cli-set-main-test-'));

const TIMON = fileURLToPath(new URL('../bin/timon', import.meta.url));

type Seen = { method?: string; url?: string; body?: unknown };

function run(args: string[], answer: { status: number; body: unknown }): Promise<{ code: number | null; stdout: string; stderr: string; seen: Seen }> {
  const seen: Seen = {};
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => { raw += String(c); });
    req.on('end', () => {
      seen.method = req.method;
      seen.url = req.url;
      seen.body = raw ? JSON.parse(raw) : undefined;
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const env = { ...process.env, TIMON_API: `http://127.0.0.1:${port}`, TIMON_RESOURCE_GUARD_ENABLED: '0' };
      delete env.TIMON_API_TOKEN;
      delete env.TIMON_AGENT;
      delete env.TIMON_MISSION_ID;
      const child = spawn(process.execPath, [TIMON, 'agent', 'set-main', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c: Buffer | string) => { stdout += String(c); });
      child.stderr.on('data', (c: Buffer | string) => { stderr += String(c); });
      child.on('error', reject);
      child.on('close', (code) => server.close(() => resolve({ code, stdout, stderr, seen })));
    });
  });
}

test('puts the name to the main-orchestrator route', async () => {
  const r = await run(['boss'], { status: 200, body: { ok: true, main: 'Boss' } });
  assert.equal(r.code, 0);
  assert.equal(r.seen.method, 'PUT');
  assert.equal(r.seen.url, '/api/agents/main');
  assert.deepEqual(r.seen.body, { name: 'boss' });
  // The daemon's spelling wins: it matches the name case-insensitively.
  assert.equal(r.stdout, 'main orchestrator: Boss\n');
});

test('an unknown name fails with a clear line and a way to find the right one', async () => {
  const r = await run(['ghost'], { status: 400, body: { error: 'agent not found: ghost' } });
  assert.equal(r.code, 2);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^timon: cannot set the main orchestrator: agent not found: ghost\n/);
  assert.match(r.stderr, /timon list/);
  assert.match(r.stderr, /timon doctor/);
});

test('an ineligible agent is refused with the daemon reason', async () => {
  const r = await run(['p.coder'], { status: 400, body: { error: 'p.coder is not an orchestrator (role: coder)' } });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /cannot set the main orchestrator: p\.coder is not an orchestrator \(role: coder\)/);
  assert.doesNotMatch(r.stderr, /timon list/);
});

test('a refusal to a mission says why', async () => {
  const r = await run(['boss'], { status: 403, body: { error: 'forbidden', code: 'operator', reason: 'only a human may designate the main orchestrator' } });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /forbidden — only a human may designate the main orchestrator/);
});

test('without exactly one name it prints its usage and calls nothing', async () => {
  for (const args of [[], ['a', 'b']]) {
    const r = await run(args, { status: 200, body: {} });
    assert.equal(r.code, 64);
    assert.match(r.stderr, /usage: timon agent set-main <name>/);
    assert.equal(r.seen.url, undefined);
  }
});
