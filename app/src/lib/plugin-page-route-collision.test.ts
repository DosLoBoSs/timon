/**
 * A third-party `page` cannot take a route the product already serves.
 *
 * Three guards. A Next page (`/chat`) is served before the catch-all, so a
 * plugin page keyed `/chat` is never painted. A page a bundled module
 * registers in the `page` slot (`/kanban`) holds its key first, and a second
 * registration under it throws. And a list of reserved first segments, read
 * by the manifest (daemon) and by `clientContext` (here), closes what the two
 * others leave open: a route declared as `/chat` whose nav entry would point
 * at the product page, a bundled page whose module is off or hidden from the
 * viewer, and an exact key under a product wildcard (`/workflows/*`).
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import React from 'react';
import { declareLayoutSlots } from './plugin-host/client-plugin-host';
import { clientContext } from './plugin-host/loader';
import { RESERVED_ROUTE_PREFIXES, RESERVED_ROUTE_SEGMENTS, reservedRouteSegment } from './plugin-host/reserved-routes';
import { resetSlotsForTests, slotEntries, slotEntry } from './plugin-host/slots';
import { mountBundledClients } from '@/plugins-client/mount';

const Empty = () => React.createElement('div');

// The daemon's file, read as data: the two packages share no import.
const daemonUrl = pathToFileURL(join(process.cwd(), '..', 'orchestrator', 'src', 'plugins', 'reserved-routes.ts')).href;
type ReservedModule = { RESERVED_ROUTE_SEGMENTS: readonly string[]; RESERVED_ROUTE_PREFIXES: readonly string[] };

test('a Next product route is served before the catch-all a plugin page goes through', () => {
  for (const route of ['chat', 'settings', 'agents', 'projects']) {
    const served = ['page.tsx', 'page.ts'].some((file) =>
      existsSync(new URL(`../app/${route}/${file}`, import.meta.url))
      || existsSync(new URL(`../app/(main)/${route}/${file}`, import.meta.url)));
    assert.ok(served, `/${route} is a Next page`);
  }
});

test('the browser reserves the same routes as the manifest', async () => {
  const daemon = await import(daemonUrl) as ReservedModule;
  assert.deepEqual([...RESERVED_ROUTE_SEGMENTS], [...daemon.RESERVED_ROUTE_SEGMENTS]);
  assert.deepEqual([...RESERVED_ROUTE_PREFIXES], [...daemon.RESERVED_ROUTE_PREFIXES]);
});

test('every first segment Next serves is reserved', () => {
  const appDir = fileURLToPath(new URL('../app/', import.meta.url));
  const segments = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    // A route group `(main)` adds no segment; a dynamic `[...route]` is the catch-all itself.
    .flatMap((entry) => entry.name.startsWith('(') ? segments(join(dir, entry.name)) : [entry.name])
    .filter((name) => !name.startsWith('['));
  for (const segment of segments(appDir)) {
    assert.ok(reservedRouteSegment(`/${segment}`), `/${segment} is a Next route that no list reserves`);
  }
});

test('every page a bundled module registers is reserved', () => {
  resetSlotsForTests();
  declareLayoutSlots();
  mountBundledClients(null);
  const keys = slotEntries('page').map((entry) => entry.key).filter((key): key is string => !!key?.startsWith('/'));
  assert.ok(keys.includes('/kanban') && keys.includes('/workflows/*'), 'the bundled pages are in the slot');
  for (const key of keys) assert.ok(reservedRouteSegment(key), `${key} is a bundled page that no list reserves`);
});

test('a plugin page cannot take the key of a page a bundled module registered', () => {
  resetSlotsForTests();
  declareLayoutSlots();
  mountBundledClients(null);
  const product = slotEntry('page', '/kanban');
  assert.ok(product, 'the Kanban page is in the page slot');
  const plugin = clientContext('acme-kanban', ['page', 'nav.item']);
  assert.throws(() => plugin.slots.register({ slot: 'page', key: '/kanban' }, Empty), /route of the product/);
  assert.equal(slotEntry('page', '/kanban')?.pluginId, product.pluginId, 'the product keeps its page');
  plugin.dispose();
});

test('a plugin page cannot take a product route its module left free', () => {
  // No bundled module mounted: the Kanban is off, or hidden from this viewer.
  resetSlotsForTests();
  declareLayoutSlots();
  const plugin = clientContext('acme-kanban', ['page']);
  for (const key of ['/kanban', '/chat', '/workflows/acme', '/trace/acme', '/login/acme', '/kanban/*']) {
    assert.throws(() => plugin.slots.register({ slot: 'page', key }, Empty), /route of the product/, key);
    assert.equal(slotEntry('page', key), null, `${key} stays free`);
  }
  plugin.dispose();
});

test('a plugin page registers under a path of its own, never under a bare key', () => {
  resetSlotsForTests();
  declareLayoutSlots();
  const plugin = clientContext('acme-board', ['page']);
  plugin.slots.register({ slot: 'page', key: '/acme' }, Empty);
  plugin.slots.register({ slot: 'page', key: '/acme/*' }, Empty);
  assert.equal(slotEntry('page', '/acme')?.pluginId, 'acme-board');
  for (const key of ['next-router', undefined]) {
    assert.throws(() => plugin.slots.register({ slot: 'page', key }, Empty), /registers under its route/, String(key));
  }
  plugin.dispose();
});
