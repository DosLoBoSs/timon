/**
 * `useSetupChat` as `/setup/agent` uses it, rendered (jsdom) against a fake
 * daemon: a status the daemon does not answer leaves the reader on the name
 * form (the welcome keeps the start's error), and the hook says why it hands
 * the reader back — the step already over, the agent ending it after its last
 * words, or the reader skipping it. A conversation not on screen yet reads
 * nothing and starts nothing; shown, it starts once.
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

type Rendered = {
  chat: () => SetupChat; left: SetupLeave[]; react: typeof import('react'); state: Daemon;
  calls: string[]; setShown: (shown: boolean) => Promise<void>;
};

async function renderHook(
  state: Daemon,
  opts: { statusFailure?: 'unavailable' | 'unnamed'; shown?: boolean },
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
  const daemon = fakeDaemon(state);
  const calls: string[] = [];
  const fetcher: Fetcher = (input, init) => { calls.push(`${init?.method ?? 'GET'} ${input}`); return daemon(input, init); };
  // `requestSkip` reads the daemon through the global fetch.
  install('fetch', ((input: RequestInfo | URL, init?: RequestInit) => fetcher(String(input), init)) as typeof fetch);
  try {
    const React = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { useSetupChat } = await import('./setup-chat');
    const left: SetupLeave[] = [];
    let latest: SetupChat | null = null;
    let show: (shown: boolean) => void = () => {};
    const { shown: initiallyShown, ...hookOpts } = opts;
    function Harness(): null {
      const [shown, setShown] = React.useState(initiallyShown ?? true);
      show = setShown;
      latest = useSetupChat({ fetcher, leave: (why) => { left.push(why); }, shown, ...hookOpts });
      return null;
    }
    const host = document.getElementById('root');
    assert.ok(host);
    const root = createRoot(host);
    await React.act(async () => { root.render(React.createElement(Harness)); });
    await settle(React);
    try {
      await run({
        chat: () => { assert.ok(latest); return latest; }, left, react: React, state, calls,
        setShown: async (shown) => { await React.act(async () => { show(shown); }); await settle(React); },
      });
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

test('a conversation not on screen reads nothing and starts nothing, and starts once when it shows', async () => {
  const startsOf = (calls: readonly string[]): number => calls.filter((c) => c === 'POST /api/ui/setup/main-agent/chat').length;
  await renderHook({ status: 'pending', named: true }, { shown: false }, async ({ chat, calls, setShown }) => {
    assert.deepEqual(calls, [], 'a hidden page asks the daemon nothing');
    assert.deepEqual(chat().stage, { kind: 'loading' });
    await setShown(true);
    assert.equal(startsOf(calls), 1, 'shown: the conversation starts');
    assert.deepEqual(chat().stage, { kind: 'chat', agent: 'nova', missionId: 'mission-1' });
    await setShown(false);
    await setShown(true);
    assert.equal(startsOf(calls), 1, 'hidden and shown again: no second mission');
  });
});
