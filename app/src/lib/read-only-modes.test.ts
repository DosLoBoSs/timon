/**
 * The modes a backend runs read-only: grok honours only plan and an explicit
 * bypassPermissions, every other backend runs the mode it is given.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modeRunsReadOnly } from './read-only-modes';

test('grok runs every guarded mode read-only, its account instances too', () => {
  for (const backend of ['grok', 'grok@acct1']) {
    for (const mode of ['default', 'auto', 'acceptEdits', 'dontAsk', 'unknown', undefined]) {
      assert.equal(modeRunsReadOnly(backend, mode), true, `${backend} ${String(mode)}`);
    }
    assert.equal(modeRunsReadOnly(backend, 'plan'), false, 'plan is already read-only: nothing to say');
    assert.equal(modeRunsReadOnly(backend, 'bypassPermissions'), false);
  }
});

test('another backend, or none known yet, gets no warning', () => {
  for (const backend of ['claude', 'codex', 'claude@acct1', null, undefined]) {
    assert.equal(modeRunsReadOnly(backend, 'auto'), false, String(backend));
  }
});
