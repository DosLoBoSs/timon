/**
 * `AcpAgentSpec.sessionModes`: the provider's table from Timon's permission modes to the agent's own session
 * modes, end to end through `defineProvider(...).codec.openSession` over in-memory pipes. The agent is an
 * invented one (`acme`): the table is the provider's data, the driver names no vendor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP_HOME = mkdtempSync(join(tmpdir(), 'timon-acp-modes-'));
process.env.TIMON_HOME = TMP_HOME;
process.on('exit', () => rmSync(TMP_HOME, { recursive: true, force: true }));

const { defineProvider } = await import('./provider.js');
const { createAcpReplayPeer } = await import('../../../../packages/sdk/src/testing/acp-checks.js');
type Spec = Parameters<typeof defineProvider>[1];
type Step = import('../../../../packages/sdk/src/testing/acp-checks.js').AcpScriptStep;

const services = { mcp: async () => ({ servers: [] }) } as unknown as Parameters<typeof defineProvider>[0];
const BASE: Spec = { id: 'acme', args: ['acp'], binary: { names: ['acme-agent'] } };
const TABLE = { plan: 'read-only', default: 'ask', acceptEdits: 'edit' } as const;

const INIT: Step = { on: 'initialize', reply: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } };
const MODES = { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'read-only', name: 'Read only' }, { id: 'edit', name: 'Edit' }] };

/** Opens a session of `spec` for an agent whose `permission_mode` is `mode`; returns the `session/set_mode` calls. */
async function open(spec: Spec, mode: string | undefined, announced: boolean): Promise<unknown[]> {
  const peer = createAcpReplayPeer([
    INIT,
    { on: 'session/new', reply: { sessionId: 's-1', ...(announced ? { modes: MODES } : {}) } },
    { on: 'session/set_mode', reply: {} },
  ]);
  const definition = defineProvider(services, spec);
  assert.equal(definition.codec.kind, 'driver');
  if (definition.codec.kind !== 'driver') return [];
  const spawn = {
    agentName: 'acme', systemPrompt: '', message: 'hi', resumeSession: null, missionId: `m-${Math.random()}`,
    cfg: { cwd: TMP_HOME, ...(mode !== undefined ? { permission_mode: mode } : {}) },
  } as never;
  const driver = definition.codec.openSession({
    io: peer.io, spawn, host: { emit: () => undefined, requestPermission: async () => ({ allow: false }) }, profileId: 'acme',
  });
  try {
    await driver.start();
    return peer.received.filter((m) => m.method === 'session/set_mode').map((m) => m.params);
  } finally {
    driver.close();
    peer.close();
  }
}

test('the permission mode selects the agent mode the table maps it to', async () => {
  const spec = { ...BASE, sessionModes: TABLE };
  assert.deepEqual(await open(spec, 'plan', true), [{ sessionId: 's-1', modeId: 'read-only' }]);
  assert.deepEqual(await open(spec, 'acceptEdits', true), [{ sessionId: 's-1', modeId: 'edit' }]);
});

test('a sandbox name counts as the mode it means', async () => {
  assert.deepEqual(await open({ ...BASE, sessionModes: TABLE }, 'read-only', true), [{ sessionId: 's-1', modeId: 'read-only' }]);
});

test('nothing is sent when the agent announces no modes, the table maps nothing, or there is no table', async () => {
  assert.deepEqual(await open({ ...BASE, sessionModes: TABLE }, 'plan', false), [], 'no modes announced');
  assert.deepEqual(await open({ ...BASE, sessionModes: TABLE }, 'bypassPermissions', true), [], 'a mode the table leaves out');
  assert.deepEqual(await open({ ...BASE, sessionModes: TABLE }, undefined, true), [], 'no permission mode set');
  assert.deepEqual(await open({ ...BASE, sessionModes: TABLE }, 'default', true), [], 'the mode the session already runs');
  assert.deepEqual(await open(BASE, 'plan', true), [], 'a provider that declares no table');
});

test('a table that names an unknown permission mode or an empty agent mode is refused at definition', () => {
  assert.throws(() => defineProvider(services, { ...BASE, sessionModes: { readonly: 'plan' } as never }), /unknown permission mode "readonly"/);
  assert.throws(() => defineProvider(services, { ...BASE, sessionModes: { plan: ' ' } }), /sessionModes\.plan/);
  assert.throws(() => defineProvider(services, { ...BASE, sessionModes: ['plan'] as never }), /must map permission modes/);
  assert.doesNotThrow(() => defineProvider(services, { ...BASE, sessionModes: TABLE }));
});
