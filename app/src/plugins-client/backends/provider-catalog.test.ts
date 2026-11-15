import assert from 'node:assert/strict';
import test from 'node:test';
import { waitUntil } from '@/lib/test-wait';

/**
 * The rows of the real `ProviderCatalog`: one state line says what is installed and what is offered, the
 * search keeps the matching agents, an unverified install is offered the verified build (never installed by
 * itself), an installed agent's sign-in methods are asked for on a click only, with the methods billed per
 * token marked and never recommended, and an installed agent opens the page of the provider it became. The
 * daemon's refusal of anyone but a superadmin signed in to the app is covered by `acp-registry-routes.test.ts`.
 */
test('the catalog reads each agent in one line, searches, offers the verified build and opens its page', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/?settings=models%2Fbackends', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('window', dom.window);
  install('self', dom.window);
  for (const key of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'DocumentFragment', 'MutationObserver', 'NodeFilter', 'HTMLInputElement', 'SVGElement', 'Event', 'CustomEvent', 'FocusEvent', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);

  const registry = {
    registryVersion: '1', dropped: 0, stale: false,
    agents: [{
      id: 'antigravity-acp', name: 'Google Antigravity', version: '1.5.0', description: null, website: null, license: null,
      supported: true, reason: null, integrity: 'sha256',
      installed: { version: '1.4.1', integrity: 'unverified', updateAvailable: true, verifiedUpdate: true, state: 'ok', profileId: 'acp-antigravity-acp' },
    }, {
      id: 'opencode', name: 'OpenCode', version: '2.0.0', description: 'An open coding agent', website: null, license: null,
      supported: true, reason: null, integrity: 'none', installed: null,
    }],
  };
  const methods = [
    { id: 'gemini-api-key', name: 'Gemini API key', description: null, kind: 'agent', billedPerToken: true, recommended: false, command: null },
    { id: 'oauth-personal', name: 'Log in with Google', description: null, kind: 'agent', billedPerToken: false, recommended: true, command: null },
  ];
  const posts: { url: string; body: unknown }[] = [];
  install('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      if (url.endsWith('/auth-methods')) return Response.json({ methods });
      return Response.json({ agent: registry.agents[0] });
    }
    if (url.startsWith('/api/ui/providers/acp-registry')) return Response.json(registry);
    return Response.json({});
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { SearchParamsContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const { ProviderCatalog } = await import('./provider-catalog');

  const root = createRoot(document.getElementById('root')!);
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const button = (label: string) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes(label));
  const opened: string[] = [];
  const rows = () => Array.from(document.querySelectorAll('[data-catalog-agent]')).map((row) => row.getAttribute('data-catalog-agent'));
  const type = (input: HTMLInputElement, value: string) => React.act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  const click = (el: Element) => React.act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });

  try {
    await React.act(async () => {
      root.render(React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams('') as never },
        React.createElement(ProviderCatalog, { onOpen: (id: string) => { opened.push(id); } })));
    });
    await until(() => button('Install verified version') !== undefined, 'the verified build to be offered');
    const state = (id: string) => document.querySelector(`[data-catalog-agent="${id}"] [data-catalog-state]`);
    assert.equal(state('antigravity-acp')?.textContent, 'Installed 1.4.1 without a published checksum · verified 1.5.0 available to replace it',
      'the mixed state reads in one line');
    assert.equal(state('antigravity-acp')?.getAttribute('data-tone'), 'action');
    assert.equal(state('opencode')?.textContent, 'Version 2.0.0, no published checksum');
    assert.doesNotMatch(document.body.textContent ?? '', /Verified sha256|Unverified/, 'no badge per version any more');
    assert.equal(button('Update'), undefined, 'the verified build is the offer, not a plain update');
    assert.equal(posts.length, 0, 'nothing is installed nor started by itself');

    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
    await type(search, 'coding');
    assert.deepEqual(rows(), ['opencode'], 'the description is searched');
    await type(search, 'ANTIGRÁVITY');
    assert.deepEqual(rows(), ['antigravity-acp'], 'accents and case are ignored');
    await type(search, 'nothing like it');
    assert.match(document.body.textContent ?? '', /No agent matches “nothing like it”/);
    await type(search, '');
    assert.equal(rows().length, 2);

    await click(button('Open its page')!);
    assert.deepEqual(opened, ['catalog:antigravity-acp'], 'an installed agent opens the provider it became');
    assert.equal(document.querySelector('[data-catalog-agent="opencode"]')?.textContent?.includes('Open its page'), false,
      'an agent not installed has no page yet');

    await click(button('Sign-in methods')!);
    await until(() => document.body.textContent?.includes('Billed per token') === true, 'the methods to show');
    assert.deepEqual(posts.map((p) => p.url), ['/api/ui/providers/acp-registry/antigravity-acp/auth-methods']);
    const items = Array.from(document.querySelectorAll('li li')).map((li) => li.textContent ?? '');
    assert.match(items[0] ?? '', /Log in with Google.*Recommended/, 'the subscription method comes first, suggested');
    assert.match(items[1] ?? '', /Gemini API key.*Billed per token/);
    assert.doesNotMatch(items[1] ?? '', /Recommended/);
    assert.match(document.body.textContent ?? '', /never chosen for you/);

    await click(button('Install verified version')!);
    await until(() => posts.length === 2, 'the install to be sent');
    assert.deepEqual(posts[1], { url: '/api/ui/providers/acp-registry/install', body: { agentId: 'antigravity-acp' } }, 'a verified build needs no acknowledgement');
  } finally {
    await React.act(async () => { root.unmount(); });
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
