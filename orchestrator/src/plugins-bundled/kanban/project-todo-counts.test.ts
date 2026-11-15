/**
 * The TO DO list is capped (200 rows by default): the counts that go with it
 * must not be. A tile that counted the rows it received showed "200 open,
 * 0 done" on a project with 221 open ideas and hundreds done.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { postTestAccount } from '../../../tests/helpers/accounts.js';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-todo-counts-'));
await import('../../../tests/helpers/paid-license.js');
await import('../../../tests/helpers/claude-provider.js');

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerRoutes: registerTodo } = await import('./project-todo-routes.js');
const { dbApi } = await import('../../db.js');
const { SESSION_COOKIE } = await import('../../users/session.js');

const TOKEN = 'witness-daemon-token';
const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerTodo(app);

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); });

function sessionCookie(res: Response): string {
  const lines = res.headers.getSetCookie();
  for (const line of lines) {
    const match = new RegExp(`(?:^|,\\s*)${SESSION_COOKIE}=([^;]+)`).exec(line);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  throw new Error('no session cookie');
}

type Counts = {
  byStatus: Record<'open' | 'done' | 'promoted', number>;
  byUrgency: Record<'open' | 'done' | 'promoted', Record<string, number>>;
};
type ListBody = { items: Array<{ id: number; text: string; status: string; project: string | null; urgency: string | null }>; counts: Counts; truncated: boolean; open: number };

async function list(query: string, cookie?: string): Promise<{ status: number; body: ListBody }> {
  const res = await fetch(`${base}/api/project-todo${query}`, {
    headers: cookie ? { cookie: `${SESSION_COOKIE}=${encodeURIComponent(cookie)}` } : {},
  });
  return { status: res.status, body: (await res.json()) as ListBody };
}

const setup = await fetch(`${base}/api/auth/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'admin@example.com', name: 'Admin', password: 'admin-secret' }),
});
assert.equal(setup.status, 201);
const adminId = ((await setup.json()) as { user: { id: string } }).user.id;
const adminCookie = sessionCookie(setup);

const created = await postTestAccount(dbApi, { email: 'ada@example.com', name: 'Ada', password: 'ada-secret' });
assert.equal(created.status, 201);
const adaId = (created.json as { user: { id: string } }).user.id;
const adaLogin = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'ada@example.com', password: 'ada-secret' }),
});
const adaCookie = sessionCookie(adaLogin);

// The admin's project holds more open ideas than one page: 221 open (21 of
// them bugs), 250 done. Another project and Ada's own ideas sit beside it.
for (let i = 0; i < 221; i++) {
  dbApi.insertProjectTodo({ text: `open ${i}`, project: 'big', ownerUserId: adminId, urgency: i < 21 ? 'bug' : null });
}
for (let i = 0; i < 250; i++) {
  const row = dbApi.insertProjectTodo({ text: `done ${i}`, project: 'big', ownerUserId: adminId });
  dbApi.updateProjectTodo(row.id, { status: 'done' });
}
for (let i = 0; i < 5; i++) dbApi.insertProjectTodo({ text: `other ${i}`, project: 'other', ownerUserId: adminId });
for (let i = 0; i < 3; i++) dbApi.insertProjectTodo({ text: `ada ${i}`, project: 'big', ownerUserId: adaId });

test('an anonymous caller is refused', async () => {
  assert.equal((await list('?status=all&project=big')).status, 401);
});

test('counts are exact past the list limit, per project', async () => {
  const { status, body } = await list('?status=all&project=big', adminCookie);
  assert.equal(status, 200);
  assert.equal(body.items.length, 200);
  assert.equal(body.truncated, true);
  // The superadmin sees Ada's three open ideas too.
  assert.deepEqual(body.counts.byStatus, { open: 224, done: 250, promoted: 0 });
  assert.equal(body.counts.byUrgency.open.bug, 21);
  assert.equal(body.counts.byUrgency.open.none, 203);
  assert.equal(body.counts.byUrgency.done.none, 250);
  // `open` keeps its old meaning: every project.
  assert.equal(body.open, 229);
});

test('one view at a time, with its own truncation', async () => {
  const done = await list('?status=done&project=big&limit=1000', adminCookie);
  assert.equal(done.body.items.length, 250);
  assert.ok(done.body.items.every((i) => i.status === 'done'));
  assert.equal(done.body.truncated, false);
  assert.equal(done.body.counts.byStatus.open, 224, 'the counts cover every status');

  const other = await list('?status=open&project=other', adminCookie);
  assert.equal(other.body.items.length, 5);
  assert.equal(other.body.truncated, false);
  assert.deepEqual(other.body.counts.byStatus, { open: 5, done: 0, promoted: 0 });
});

test('the urgency filter narrows the list and the status counts, not the chips', async () => {
  const bugs = await list('?status=open&project=big&urgency=bug', adminCookie);
  assert.equal(bugs.body.items.length, 21);
  assert.equal(bugs.body.counts.byStatus.open, 21);
  assert.equal(bugs.body.counts.byUrgency.open.none, 203);

  const several = await list('?status=open&project=big&urgency=bug,none&limit=1000', adminCookie);
  assert.equal(several.body.items.length, 224);
  const untagged = await list('?status=open&project=big&urgency=none&limit=1000', adminCookie);
  assert.ok(untagged.body.items.every((i) => i.urgency === null));
  assert.equal(untagged.body.items.length, 203);
});

test('another user counts only her own ideas', async () => {
  const { body } = await list('?status=all&project=big', adaCookie);
  assert.equal(body.items.length, 3);
  assert.deepEqual(body.counts.byStatus, { open: 3, done: 0, promoted: 0 });
  assert.equal(body.truncated, false);
  assert.equal(body.open, 3);
});

test('ids fetches given ideas whatever their status, within the viewer\'s rows', async () => {
  const all = await list('?status=all&project=big&limit=1000', adminCookie);
  const doneId = all.body.items.find((i) => i.status === 'done')!.id;
  const adminOpenId = all.body.items.find((i) => i.text.startsWith('open '))!.id;
  const picked = await list(`?status=all&ids=${doneId},${adminOpenId}`, adminCookie);
  assert.deepEqual(picked.body.items.map((i) => i.id).sort((a, b) => a - b), [doneId, adminOpenId].sort((a, b) => a - b));
  const hidden = await list(`?status=all&ids=${adminOpenId}`, adaCookie);
  assert.equal(hidden.body.items.length, 0);
});

test('a malformed limit, ids or urgency is refused', async () => {
  for (const q of ['?limit=0', '?limit=1001', '?limit=abc', '?ids=1,x', '?ids=', '?urgency=loud', '?urgency=bug,loud']) {
    assert.equal((await list(q, adminCookie)).status, 400, q);
  }
});
