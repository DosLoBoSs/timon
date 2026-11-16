/**
 * `agent-name-rule.ts` is a verbatim copy of the daemon's
 * `orchestrator/src/agent-name.ts` (independent packages, as for `brand.ts`):
 * the native browser must take exactly the agent names the daemon takes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isValidAgentName, normalizeAgentName } from './agent-name-rule.js';

test('agent name rule: the copy is the daemon file, byte for byte', () => {
  const here = readFileSync(new URL('./agent-name-rule.ts', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../../orchestrator/src/agent-name.ts', import.meta.url), 'utf8');
  assert.equal(here, source, 'copy orchestrator/src/agent-name.ts over desktop/src/agent-name-rule.ts');
});

test('agent name rule: every script is taken, what a folder cannot hold is not', () => {
  for (const name of ['马斯克', 'שלום', 'Нова', '_main']) assert.equal(isValidAgentName(name), true, name);
  assert.equal(isValidAgentName(normalizeAgentName('Zoë')), true, 'a decomposed name, once composed');
  for (const name of ['..', '-x', 'a b', '😀', 'nul.txt', 'foo.']) assert.equal(isValidAgentName(name), false, name);
});
