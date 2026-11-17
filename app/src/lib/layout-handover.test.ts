import assert from 'node:assert/strict';
import test from 'node:test';
import { handoverKey, handoverOf, mergeHandedList, readHandover, rowHandover } from './layout-handover';
import { workspaceRowHandover } from './workspace-route';

test('a chain lists the previous row first, consumed, then the shared one, kept', () => {
  assert.deepEqual(rowHandover('old.widgets', 'cockpit'), [{ scope: 'old.widgets', consumed: true }, { scope: 'cockpit' }]);
  assert.deepEqual(rowHandover(null, 'cockpit'), [{ scope: 'cockpit' }]);
  assert.deepEqual(rowHandover(undefined), []);
  assert.deepEqual(handoverOf('chat.columns'), [{ scope: 'chat.columns' }], 'a bare scope is the historical kept legacy');
  assert.deepEqual(handoverOf(undefined), []);
});

test('a view row hands over from the same suffix under the previous key', () => {
  assert.deepEqual(workspaceRowHandover('v2.old', 'columns', 'chat.columns'), [{ scope: 'v2.old.columns', consumed: true }, { scope: 'chat.columns' }]);
  assert.deepEqual(workspaceRowHandover(null, 'islands'), []);
});

test('the identity of a chain is its content, kept and consumed sources apart', () => {
  assert.equal(handoverKey(rowHandover('a', 'b')), handoverKey(rowHandover('a', 'b')));
  assert.notEqual(handoverKey(rowHandover('a')), handoverKey('a'));
  assert.equal(handoverKey(undefined), '');
});

test('the walk stops at the first source holding something, or at the first that cannot be read', async () => {
  const rows = new Map<string, unknown>([['b', { x: 1 }], ['c', { x: 2 }]]);
  const seen: string[] = [];
  const load = async (scope: string) => {
    seen.push(scope);
    return scope === 'broken' ? { ok: false, raw: null } : { ok: true, raw: rows.get(scope) ?? null };
  };
  assert.deepEqual(await readHandover(rowHandover('a', 'b'), load), { ok: true, raw: { x: 1 }, from: { scope: 'b' } });
  assert.deepEqual(seen, ['a', 'b']);
  seen.length = 0;
  assert.deepEqual(await readHandover(rowHandover('broken', 'c'), load), { ok: false });
  assert.deepEqual(seen, ['broken'], 'the shared row is not read past a failure');
  assert.deepEqual(await readHandover(rowHandover('a', 'z'), load), { ok: true, raw: null, from: null });
});

test('a list handed over keeps its own entries and adds only what the previous row holds alone', () => {
  type E = { id: string; name: string; size?: number };
  const rules = {
    max: 3,
    fits: (list: readonly E[]) => list.reduce((n, e) => n + (e.size ?? 1), 0) <= 4,
    sameName: (a: string, b: string) => a.toLowerCase() === b.toLowerCase(),
  };
  const current: E[] = [{ id: 'a', name: 'Alpha' }];
  assert.deepEqual(
    mergeHandedList(current, [{ id: 'a', name: 'Renamed' }, { id: 'x', name: 'alpha' }, { id: 'b', name: 'Beta' }], rules),
    [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }],
    'same id or same name is skipped: the current entry wins',
  );
  assert.equal(mergeHandedList(current, [{ id: 'a', name: 'Alpha' }], rules), null, 'nothing new, nothing to write');
  assert.equal(mergeHandedList(current, [], rules), null);
  assert.deepEqual(
    mergeHandedList(current, [{ id: 'b', name: 'B' }, { id: 'c', name: 'C' }, { id: 'd', name: 'D' }], rules)?.map((e) => e.id),
    ['a', 'b', 'c'],
    'capped at the count',
  );
  assert.deepEqual(
    mergeHandedList(current, [{ id: 'b', name: 'B', size: 2 }, { id: 'c', name: 'C', size: 2 }], rules)?.map((e) => e.id),
    ['a', 'b'],
    'the tail that does not fit is dropped, never an entry of the current list',
  );
});
