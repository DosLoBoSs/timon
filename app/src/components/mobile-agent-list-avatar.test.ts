/**
 * TODO #887: the mobile list of the Agents page draws each row through
 * `AgentAvatar`, so it follows the agent's picked head (`config.avatar`).
 * TODO #889: an agent without a head of its own takes its project's logo and
 * colour, as in every other view.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { JSDOM } from 'jsdom';

const LOOK = { shape: 'hex', color: '#7ed957', eyes: 'code', acc: 'coffee' };
const FULL = { emoji: '🦊', icon_url: '/api/uploads/nova.png', look: LOOK };

/** Mounts the list over a mocked daemon, opens the sheet, hands its DOM to `check`. */
async function withOpenList(
  agents: unknown[],
  projects: unknown[],
  check: (dom: JSDOM, rowOf: (name: string) => HTMLElement | undefined) => void,
): Promise<void> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/agents', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of [
    'window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter',
    'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event', 'MouseEvent', 'getComputedStyle',
    'requestAnimationFrame', 'cancelAnimationFrame',
  ] as const) install(key, key === 'self' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  install('EventSource', class { close() {} addEventListener() {} removeEventListener() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  install('fetch', async (input: string | URL | Request) => {
    const url = String(input);
    if (url === '/api/ui/agents') return Response.json({ agents });
    if (url === '/api/ui/projects') return Response.json({ projects });
    return Response.json({ agents: [] });
  });
  const React = await import('react');
  install('React', React);
  const { createElement } = React;
  const { createRoot } = await import('react-dom/client');
  const { MobileAgentList } = await import('./mobile-agent-list');
  const root = createRoot(dom.window.document.getElementById('root')!);
  try {
    await React.act(async () => { root.render(createElement(MobileAgentList)); });
    const opener = dom.window.document.querySelector<HTMLButtonElement>('button');
    assert.ok(opener, 'the floating button');
    await React.act(async () => { opener.click(); });
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const rowOf = (name: string) => Array.from(dom.window.document.querySelectorAll<HTMLElement>('a'))
      .find((a) => a.textContent?.includes(name));
    check(dom, rowOf);
  } finally {
    await React.act(async () => { root.unmount(); });
    dom.window.close();
    for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
  }
}

test('mobile list: each row draws the agent through AgentAvatar, picked head first', async () => {
  await withOpenList([
    { name: 'alpha', main: true, role: 'orchestrator', ...FULL, avatar: 'mascot' },
    { name: 'beta', role: 'orchestrator', ...FULL, avatar: 'emoji' },
    { name: 'gamma', role: 'orchestrator', ...FULL },
  ], [], (_dom, rowOf) => {
    assert.ok(rowOf('alpha')?.querySelector('[data-agent-mascot] svg'), 'alpha: its mascot');
    const beta = rowOf('beta');
    assert.ok(beta && !beta.querySelector('[data-agent-mascot], img') && beta.textContent?.includes('🦊'), 'beta: its emoji');
    assert.equal(rowOf('gamma')?.querySelector('img')?.getAttribute('src'), '/api/uploads/nova.png', 'gamma: no pick, its picture');
  });
});

test('mobile list: an agent without a head of its own takes its project logo and colour', async () => {
  await withOpenList([
    { name: 'delta', role: 'orchestrator', project: 'logoed' },
    { name: 'epsilon', role: 'orchestrator', project: 'emojied' },
    { name: 'zeta', role: 'orchestrator', project: 'logoed', icon_url: '/api/uploads/own.png' },
  ], [
    { slug: 'logoed', icon: '/api/uploads/project.png', color: '#3366ff', name: 'Logoed' },
    { slug: 'emojied', icon: '🚀', color: '#ff5533', name: 'Emojied' },
  ], (_dom, rowOf) => {
    assert.equal(rowOf('delta')?.querySelector('img')?.getAttribute('src'), '/api/uploads/project.png', 'delta: the project logo');
    const epsilon = rowOf('epsilon');
    assert.ok(epsilon && !epsilon.querySelector('img') && epsilon.textContent?.includes('🚀'), 'epsilon: the project emoji');
    // The disc is tinted from the project colour (`accentVars`), not from the name's hashed palette.
    const disc = epsilon?.querySelector<HTMLElement>('[style*="--accent"]');
    assert.ok(disc, 'epsilon: a tinted disc');
    // `--accent-dark` keeps the colour as given; `--accent` may be darkened for contrast.
    assert.match(disc.getAttribute('style') ?? '', /--accent-dark:\s*#ff5533/i, 'epsilon: the project colour');
    assert.equal(rowOf('zeta')?.querySelector('img')?.getAttribute('src'), '/api/uploads/own.png', 'zeta: its own picture wins');
  });
});
