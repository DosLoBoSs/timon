/**
 * A pinned path refused by the daemon reads as a sentence of the locale: never
 * the path that was typed, never the daemon's own text for an unknown code.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { binaryErrorMessage } from '@/lib/backend-binaries';

test('daemon codes become sentences; an unknown one does not leak its message', () => {
  assert.match(binaryErrorMessage(400, 'path_not_executable'), /not executable/);
  assert.match(binaryErrorMessage(403, 'operator'), /superadmin/);
  assert.match(binaryErrorMessage(500, 'whatever'), /error 500/);
});
