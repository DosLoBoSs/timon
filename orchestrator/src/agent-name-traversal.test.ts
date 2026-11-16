/**
 * An agent name is one folder under `agents/`, never a path: `.` is `agents/`
 * itself and `..` the Timon home, where a delete or a write would reach every
 * agent at once. Both the name check and the path helper refuse them.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'timon-agent-name-traversal-'));
process.env.TIMON_HOME = HOME;
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
delete process.env.TIMON_AGENT_TRASH_ENABLED;

import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../tests/helpers/claude-provider.js');
const { createEphemeralAgent, deleteAgent, getAgent, listAgents, renameAgent, upsertAgent } = await import('./agent.js');
const { isValidAgentName } = await import('./agent-config.js');
const { AGENTS_DIR, agentConfig, agentDir, agentMemoryDir } = await import('./paths.js');

// Something that must survive: a file at the home root and an agent beside.
const WITNESS = join(HOME, 'witness.txt');
writeFileSync(WITNESS, 'still here');
upsertAgent({ name: 'bystander', system_prompt: 'p', config: { role: 'coder' } });

function homeIntact(): void {
  assert.equal(existsSync(HOME), true, 'the home is still there');
  assert.equal(existsSync(WITNESS), true, 'the home root was not touched');
  assert.equal(existsSync(agentDir('bystander')), true, 'the other agents are still there');
  assert.equal(existsSync(join(HOME, 'trash', 'agents')) && readdirSync(join(HOME, 'trash', 'agents')).length > 0, false, 'nothing went to the trash');
}

const TRAVERSAL = ['.', '..', '...', '.hidden', '../x', 'a/..', 'a\\..', ''];

test('the name check refuses dot names and keeps the legitimate ones', () => {
  for (const name of TRAVERSAL) assert.equal(isValidAgentName(name), false, name);
  for (const name of ['_main', '_main.client', '_eph-abc123', 'foo.bar', 'TIMON.main', 'a-b_c.d', 'x..y']) {
    assert.equal(isValidAgentName(name), true, name);
  }
});

test('the path helper refuses anything but a direct child of agents/', () => {
  for (const name of ['.', '..', '...', '../x', 'a/b', 'a\\b', '', 'a\0b']) {
    assert.throws(() => agentDir(name), /invalid agent name/, JSON.stringify(name));
    assert.throws(() => agentConfig(name), /invalid agent name/, JSON.stringify(name));
    assert.throws(() => agentMemoryDir(name), /invalid agent name/, JSON.stringify(name));
  }
  assert.equal(agentDir('foo.bar'), join(AGENTS_DIR, 'foo.bar'));
});

test('deleting `..` or `.` is refused and leaves the home intact', () => {
  assert.throws(() => deleteAgent('..'), /invalid agent name/);
  assert.throws(() => deleteAgent('..', { purge: true }), /invalid agent name/);
  assert.throws(() => deleteAgent('.'), /invalid agent name/);
  assert.throws(() => deleteAgent('.', { purge: true }), /invalid agent name/);
  homeIntact();
});

test('creating or renaming to `..` is refused and writes nothing', () => {
  assert.throws(() => upsertAgent({ name: '..', system_prompt: 'p' }), /invalid agent name/);
  assert.throws(() => upsertAgent({ name: '.', system_prompt: 'p' }), /invalid agent name/);
  assert.throws(() => renameAgent('bystander', '..'), /invalid agent name/);
  assert.throws(() => renameAgent('..', 'loot'), /invalid agent name/);
  assert.equal(existsSync(join(HOME, 'system-prompt.md')), false);
  assert.equal(existsSync(join(HOME, 'config.json')), false);
  assert.equal(existsSync(agentDir('loot')), false);
  homeIntact();
});

test('legitimate names still work end to end', () => {
  for (const name of ['_main', 'foo.bar']) {
    upsertAgent({ name, system_prompt: `prompt of ${name}`, config: { role: 'coder' } });
    assert.ok(getAgent(name), name);
  }
  const eph = createEphemeralAgent({ system_prompt: 'scratch', hint: 'probe' }).name;
  assert.match(eph, /^_eph-probe-/);
  assert.ok(getAgent(eph));
  // A hidden folder left by a sync tool is not listed as an agent.
  mkdirSync(join(AGENTS_DIR, '.stfolder'));
  const listed = listAgents().map((a) => a.name);
  for (const name of ['_main', 'foo.bar', 'bystander', eph]) assert.ok(listed.includes(name), name);
  assert.equal(listed.includes('.stfolder'), false);
  assert.equal(deleteAgent('foo.bar'), true);
  assert.equal(existsSync(agentDir('foo.bar')), false);
  assert.equal(existsSync(WITNESS), true);
});
