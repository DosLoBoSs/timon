/**
 * `useSetupChat` as `/setup/agent` uses it, rendered (jsdom) against a fake
 * daemon: a status the daemon does not answer leaves the reader on the name
 * form (the welcome keeps the start's error), and the hook says why it hands
 * the reader back — the step already over, the agent ending it after its last
 * words, or the reader skipping it.
 */
import '@/lib/i18n-test-locales';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { SetupChat, SetupLeave } from './setup-chat';

type Daemon = { status: 'pending' | 'complete' | 'down'; named: boolean };
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

function fakeDaemon(state: Daemon): Fetcher {
  return async (input, init) => {
    const method = init?.method ?? 'GET';
    if (input === '/api/ui/setup/main-agent' && method === 'GET') {
      if (state.status === 'down') return Response.json({ error: 'down' }, { status: 503 });
      return Response.json({ status: state.status, available: true, name: 'nova', named: state.named, tour: false, team: [] });
    }
    if (input === '/api/ui/setup/main-agent' && method === 'POST') {
      state.status = 'complete';
      return Response.json({ status: 'complete' });
    }
    if (input === '/api/ui/setup/main-agent/chat') return Response.json({ mission_id: 'mission-1', agent: 'nova' }, { status: 201 });
    if (input.startsWith('/api/ui/missions/')) return Response.json({ status: 'running', liveness: 'alive' });
    return Response.json({ error: 'not_found' }, { status: 404 });
  };
}

type Rendered = { chat: () => SetupChat; left: SetupLeave[]; react: typeof import('react'); state: Daemon };

async function renderHook(
  state: Daemon,
  opts: { statusFailure?: 'unavailable' | 'unnamed' },
  run: (r: Rendered) => Promise<void>,
): Promise<void> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/setup/agent', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown): void => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'sessionStorage', 'localStorage']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const fetcher = fakeDaemon(state);
  // `requestSkip` reads the daemon through the global fetch.
  install('fetch', ((input: RequestInfo | URL, init?: RequestInit) => fetcher(String(input), init)) as typeof fetch);
  try {
    const React = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { useSetupChat } = await import('./setup-chat');
    const left: SetupLeave[] = [];
    let latest: SetupChat | null = null;
    function Harness(): null {
      latest = useSetupChat({ fetcher, leave: (why) => { left.push(why); }, ...opts });
      return null;
    }
    const host = document.getElementById('root');
    assert.ok(host);
    const root = createRoot(host);
    await React.act(async () => { root.render(React.createElement(Harness)); });
    await settle(React);
    try {
      await run({ chat: () => { assert.ok(latest); return latest; }, left, react: React, state });
    } finally {
      await React.act(async () => { root.unmount(); });
    }
  } finally {
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
}

const settle = (react: typeof import('react'), ms = 30): Promise<void> => react.act(async () => { await new Promise((r) => setTimeout(r, ms)); });

test('a daemon that does not answer leaves /setup/agent on its form, and the welcome on the start error', async () => {
  await renderHook({ status: 'down', named: true }, { statusFailure: 'unnamed' }, async ({ chat, left }) => {
    assert.deepEqual(chat().stage, { kind: 'unnamed' });
    assert.deepEqual(left, []);
  });
  await renderHook({ status: 'down', named: true }, {}, async ({ chat }) => {
    assert.deepEqual(chat().stage, { kind: 'unavailable', agent: '' });
  });
});

test('a step already over hands the reader back at once', async () => {
  await renderHook({ status: 'complete', named: true }, { statusFailure: 'unnamed' }, async ({ left }) => {
    assert.deepEqual(left, ['done']);
  });
});

test('the agent ending the step hands the reader back after its last words', async () => {
  await renderHook({ status: 'pending', named: true }, { statusFailure: 'unnamed' }, async ({ chat, left, react, state }) => {
    assert.deepEqual(chat().stage, { kind: 'chat', agent: 'nova', missionId: 'mission-1' });
    state.status = 'complete';
    await settle(react, 2700);
    assert.deepEqual(chat().leaving, { tour: false }, 'the end is known at once');
    assert.deepEqual(left, [], 'its last words stay on screen');
    await settle(react, 2600);
    assert.deepEqual(left, ['finished']);
  });
});

test('skipping hands the reader back as skipped', async () => {
  await renderHook({ status: 'pending', named: true }, { statusFailure: 'unnamed' }, async ({ chat, left, react }) => {
    await react.act(async () => { await chat().skip(); });
    assert.equal(chat().skipped, true);
    assert.deepEqual(left, ['skipped']);
  });
});
