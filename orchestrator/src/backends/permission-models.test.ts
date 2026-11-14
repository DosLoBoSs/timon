import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PERMISSION_MODEL_OBLIGATIONS, resolveSupportedPermissionMode, sandboxLevelForPermissionMode } from './permission-models.js';
import { PERMISSION_MODELS } from './types.js';

test('permission_mode maps to the three sandbox levels, defaulting to the safe middle', () => {
  assert.equal(sandboxLevelForPermissionMode('plan'), 'read-only');
  assert.equal(sandboxLevelForPermissionMode('read-only'), 'read-only');
  assert.equal(sandboxLevelForPermissionMode('bypassPermissions'), 'danger-full-access');
  for (const mode of ['auto', 'acceptEdits', 'default', undefined, 'something-new']) {
    assert.equal(sandboxLevelForPermissionMode(mode), 'workspace-write', String(mode));
  }
});

test('every permission model says what a dialect owes for it', () => {
  assert.deepEqual(Object.keys(PERMISSION_MODEL_OBLIGATIONS).sort(), [...PERMISSION_MODELS].sort());
});

test('supportedModes: a listed mode runs as itself, any other in plan, and no list changes nothing', () => {
  const two = ['plan', 'bypassPermissions'];
  assert.equal(resolveSupportedPermissionMode('bypassPermissions', two), 'bypassPermissions');
  assert.equal(resolveSupportedPermissionMode('danger-full-access', two), 'bypassPermissions', 'a sandbox name reads as its mode');
  for (const mode of ['plan', 'read-only', 'default', 'acceptEdits', 'auto', 'dontAsk', 'workspace-write', 'typo', undefined, null]) {
    assert.equal(resolveSupportedPermissionMode(mode, two), 'plan', String(mode));
  }
  assert.equal(resolveSupportedPermissionMode('auto', ['plan', 'auto']), 'auto');
  assert.equal(resolveSupportedPermissionMode('workspace-write', ['plan', 'auto']), 'auto');
  for (const mode of ['default', 'auto', 'bypassPermissions', 'typo']) {
    assert.equal(resolveSupportedPermissionMode(mode, undefined), mode);
  }
  assert.equal(resolveSupportedPermissionMode(undefined, undefined), undefined);
});
