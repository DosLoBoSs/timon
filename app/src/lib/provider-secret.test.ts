import assert from 'node:assert/strict';
import test from 'node:test';
import type { SecretSummary } from '@/lib/secrets';
import { planProviderSecretWrite, reservableBackends, saveProviderSecret } from './provider-secret';

function secret(id: string, name: string, grants: SecretSummary['grants'], updated = 1): SecretSummary {
  return { id, name, mode: 'inject', grants, configured: true, updated_at: updated };
}

test('a reservation names the backends, never an account instance', () => {
  assert.deepEqual(reservableBackends(['llmtr', 'claude@abc', 'llmtr', 'llmtr-eu']), ['llmtr', 'llmtr-eu']);
});

test('a key with nothing reserved to the provider is created, reserved to its backends', () => {
  const secrets = [
    secret('g', 'LLMTR_API_KEY', [{ scope_kind: 'global', scope_ref: null }]),
    secret('o', 'LLMTR_API_KEY', [{ scope_kind: 'backend', scope_ref: 'other' }]),
    secret('n', 'OTHER_KEY', [{ scope_kind: 'backend', scope_ref: 'llmtr' }]),
  ];
  assert.deepEqual(planProviderSecretWrite(secrets, 'LLMTR_API_KEY', ['llmtr', 'claude@x']), {
    kind: 'create', grants: [{ scope_kind: 'backend', scope_ref: 'llmtr' }],
  });
});

test('a key already reserved to the provider has its value replaced, the newest first', () => {
  const secrets = [
    secret('old', 'LLMTR_API_KEY', [{ scope_kind: 'backend', scope_ref: 'llmtr' }], 1),
    secret('new', 'LLMTR_API_KEY', [{ scope_kind: 'project', scope_ref: 'p' }, { scope_kind: 'backend', scope_ref: 'llmtr' }], 5),
  ];
  assert.deepEqual(planProviderSecretWrite(secrets, 'LLMTR_API_KEY', ['llmtr']), { kind: 'replace', id: 'new' });
});

test('saving sends the value in the body only, and replacing keeps the entry\'s grants', async () => {
  const calls: { url: string; method: string; body: unknown }[] = [];
  let listed: SecretSummary[] = [];
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (method === 'GET') return Response.json({ secrets: listed });
      return Response.json({ id: 'x' }, { status: method === 'POST' ? 201 : 200 });
    },
  });
  try {
    await saveProviderSecret('LLMTR_API_KEY', 'sk-1', ['llmtr']);
    assert.deepEqual(calls.at(-1), {
      url: '/api/ui/secrets', method: 'POST',
      body: { name: 'LLMTR_API_KEY', mode: 'inject', note: null, grants: [{ scope_kind: 'backend', scope_ref: 'llmtr' }], value: 'sk-1' },
    });
    assert.ok(calls.every((call) => !call.url.includes('sk-1')), 'the value never rides in an address');

    listed = [secret('s1', 'LLMTR_API_KEY', [{ scope_kind: 'backend', scope_ref: 'llmtr' }])];
    await saveProviderSecret('LLMTR_API_KEY', 'sk-2', ['llmtr']);
    assert.deepEqual(calls.at(-1), { url: '/api/ui/secrets/s1', method: 'PUT', body: { value: 'sk-2' } });
  } finally {
    if (saved) Object.defineProperty(globalThis, 'fetch', saved);
  }
});

test('a refusal comes back as the daemon\'s words', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async (_input: string | URL | Request, init?: RequestInit) => ((init?.method ?? 'GET') === 'GET'
      ? Response.json({ secrets: [] })
      : Response.json({ error: 'superadmin only' }, { status: 403 })),
  });
  try {
    await assert.rejects(saveProviderSecret('LLMTR_API_KEY', 'sk', ['llmtr']), /superadmin only/);
  } finally {
    if (saved) Object.defineProperty(globalThis, 'fetch', saved);
  }
});
