import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeTokenStateKey, claudeTokenTone } from '../plugins-client/backends/claude-token';
import en from '../locales/en/core.json';
import fr from '../locales/fr/core.json';

test('the claude token panel names each state, in both locales', () => {
  const keys = [
    claudeTokenStateKey({ configured: false, readable: false, serviceOutsideSession: false }),
    claudeTokenStateKey({ configured: true, readable: true, serviceOutsideSession: false }),
    claudeTokenStateKey({ configured: true, readable: false, serviceOutsideSession: true }),
  ];
  assert.deepEqual(keys, ['backendsSettings.claudeToken.none', 'backendsSettings.claudeToken.set', 'backendsSettings.claudeToken.unreadable']);
  for (const locale of [en, fr] as Record<string, unknown>[]) {
    for (const key of keys) {
      const value = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], locale);
      assert.equal(typeof value, 'string', key);
    }
  }
});

test('the claude token pastille: ready, blocked, action only where missions need it, else off', () => {
  assert.deepEqual([
    claudeTokenTone({ configured: true, readable: true, serviceOutsideSession: true }),
    claudeTokenTone({ configured: true, readable: false, serviceOutsideSession: false }),
    claudeTokenTone({ configured: false, readable: false, serviceOutsideSession: true }),
    claudeTokenTone({ configured: false, readable: false, serviceOutsideSession: false }),
  ], ['ready', 'blocked', 'action', 'off']);
});
