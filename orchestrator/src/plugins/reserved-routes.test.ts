/**
 * A third-party `page` cannot declare a route of the product: the manifest is
 * refused at the door, whether the product path is a Next page, a page a
 * bundled module registers (on or off), or under a product wildcard.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BRAND } from '../brand.js';
import { BUNDLED_IDENTITY } from './bundled-identity.js';
import { PLUGIN_API_VERSION, readManifest } from './manifest.js';
import { reservedRouteSegment } from './reserved-routes.js';

function page(route: string): Record<string, unknown> {
  return {
    name: 'acme-page',
    version: '1.0.0',
    [BRAND.manifestKey]: { id: 'acme-page', apiVersion: PLUGIN_API_VERSION, kind: 'page', route, client: { slots: ['page'] } },
  };
}

test('a page manifest declaring a product route is refused', () => {
  // A Next page, a bundled page, a path under a bundled wildcard, a path under
  // a Next page, and a path the login middleware skips.
  for (const route of ['/chat', '/kanban', '/workflows/acme', '/trace/acme', '/settings/acme', '/login/acme', '/manifest-acme']) {
    const res = readManifest(page(route));
    assert.ok(!res.ok, `route \`${route}\` should have been refused`);
    assert.equal(res.code, 'manifest');
    assert.match(res.message, /a route of the product/);
  }
});

test('a page of its own passes, including one that only starts like a product word', () => {
  for (const route of ['/acme', '/acme/board', '/chatroom', '/kanban-pro', '/workflow']) {
    const res = readManifest(page(route));
    assert.ok(res.ok, res.ok ? '' : res.message);
  }
});

test('every route a bundled module declares is reserved', () => {
  for (const [id, identity] of Object.entries(BUNDLED_IDENTITY)) {
    if (!identity.route) continue;
    assert.ok(reservedRouteSegment(identity.route), `${id} declares \`${identity.route}\`, which no list reserves`);
  }
});

test('the home and a wildcard key are read by their first segment', () => {
  assert.equal(reservedRouteSegment('/'), '/');
  assert.equal(reservedRouteSegment('/workflows/*'), '/workflows');
  assert.equal(reservedRouteSegment('/agents?view=projects'), '/agents');
  assert.equal(reservedRouteSegment('/acme/*'), null);
});
