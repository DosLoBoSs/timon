/**
 * TODO #1013 — a task created from inside a mission belongs to its series: the
 * daemon reads the pilot from `X-TIMON-Mission`, which the CLI must send on
 * `timon task create` as the MCP catalogue does. And `timon task attach`
 * reaches the route that attaches an orphan chain. Witness HTTP server on
 * `127.0.0.1:0`, never the machine's daemon.
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

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-cli-task-attach-test-'));

const TIMON = fileURLToPath(new URL('../bin/timon', import.meta.url));

type Seen = { method?: string; url?: string; body?: unknown; headers?: http.IncomingHttpHeaders };

function run(
  args: string[],
  answer: { status: number; body: unknown },
  env: Record<string, string | undefined> = {},
): Promise<{ code: number | null; stdout: string; stderr: string; seen: Seen }> {
  const seen: Seen = {};
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => { raw += String(c); });
    req.on('end', () => {
      seen.method = req.method;
      seen.url = req.url;
      seen.headers = req.headers;
      seen.body = raw ? JSON.parse(raw) : undefined;
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const childEnv: Record<string, string | undefined> = {
        ...process.env, TIMON_API: `http://127.0.0.1:${port}`, TIMON_RESOURCE_GUARD_ENABLED: '0',
      };
      // This suite may itself run inside a mission: only what a case sets counts.
      delete childEnv.TIMON_API_TOKEN;
      delete childEnv.TIMON_MISSION_ID;
      delete childEnv.TIMON_AGENT;
      delete childEnv.TIMON_TRACE_ID;
      Object.assign(childEnv, env);
      const child = spawn(process.execPath, [TIMON, 'task', ...args], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c: Buffer | string) => { stdout += String(c); });
      child.stderr.on('data', (c: Buffer | string) => { stderr += String(c); });
      child.on('error', reject);
      child.on('close', (code) => server.close(() => resolve({ code, stdout, stderr, seen })));
    });
  });
}

const created = { status: 201, body: { task: { id: 't-1' } } };

test('task create inside a mission names it to the daemon', async () => {
  const r = await run(['create', '--title', 'T', '--agent', 'a.coder'], created, {
    TIMON_MISSION_ID: 'pilot-mission', TIMON_AGENT: 'a.main',
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.seen.url, '/api/tasks');
  assert.equal(r.seen.headers?.['x-timon-mission'], 'pilot-mission');
  assert.equal(r.seen.headers?.['x-timon-agent'], 'a.main');
});

test('task create outside a mission sends no mission header', async () => {
  const r = await run(['create', '--title', 'T', '--agent', 'a.coder'], created);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.seen.headers?.['x-timon-mission'], undefined);
  assert.equal(r.seen.headers?.['x-timon-agent'], undefined);
});

test('task attach posts the series to the attach route', async () => {
  const r = await run(['attach', 'task-1', '--series', 'current'], {
    status: 200, body: { series_id: 's-1', pilot_mission_id: 'p-1', attached: ['task-1', 'r-1', 'm-1'] },
  }, { TIMON_MISSION_ID: 'p-1' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.seen.method, 'POST');
  assert.equal(r.seen.url, '/api/tasks/task-1/attach-series');
  assert.deepEqual(r.seen.body, { series: 'current' });
  assert.equal(r.seen.headers?.['x-timon-mission'], 'p-1');
  assert.equal(r.stdout, '3 task(s) attached to series s-1 (pilot p-1)\n');
});

test('task attach: a refusal of the daemon fails the command', async () => {
  const r = await run(['attach', 'task-1', '--series', 'nope'], {
    status: 404, body: { error: 'Series nope not found', code: 'series_not_found' },
  });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /series_not_found/);
});

test('task attach without an id or a series prints its usage', async () => {
  const r = await run(['attach', 'task-1'], { status: 200, body: {} });
  assert.equal(r.code, 64);
  assert.match(r.stderr, /usage: timon task attach/);
  assert.equal(r.seen.url, undefined);
});
