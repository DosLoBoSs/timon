import assert from 'node:assert/strict';
import test from 'node:test';
import { waitUntil } from '@/lib/test-wait';
import type { ProviderOverview } from '@/lib/provider-overview';

/**
 * "Add a provider" through the real `ProvidersSettings`: the list offers the button and no longer
 * shows the registry (nor reads it), the page offers the catalog or a compatible endpoint and reads
 * nothing before a choice, an installed catalogue agent opens the page of the provider it became, and
 * an endpoint added from the form lands on its own page. The daemon's refusal of anyone but a
 * superadmin is covered by `acp-registry-routes.test.ts` and `custom-routes.test.ts`.
 */
const claude: ProviderOverview = {
  id: 'provider-claude', name: 'Claude', brand: null, icon: null, origin: 'plugin', pluginId: 'provider-claude', plugin: null, catalogAgent: null,
  enabled: true, isDefault: true,
  backends: [{ id: 'claude', label: 'Claude', active: true, disabled: false, reason: null, modelCount: 1, defaultModel: null, isDefault: true, remote: false }],
  modelCount: 1, agentCount: 0,
  connection: { signedIn: true, signInCommand: null, signInThen: null, acceptsAccounts: false, accounts: [] },
  secret: { required: false, present: false, names: [] },
  programs: [], status: 'connected', updateAvailable: false,
};

const registry = {
  registryVersion: '1', dropped: 0, stale: false,
  agents: [{
    id: 'antigravity-acp', name: 'Google Antigravity', version: '1.5.0', description: null, website: null, license: null,
    supported: true, reason: null, integrity: 'sha256',
    installed: { version: '1.5.0', integrity: 'sha256', updateAvailable: false, state: 'ok', profileId: 'acp-antigravity-acp' },
  }],
};

test('"Add a provider" offers the catalog or an endpoint, and what is added opens its own page', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/?settings=models%2Fbackends', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('window', dom.window);
  install('self', dom.window);
  for (const key of ['document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'Element', 'Node', 'DocumentFragment', 'MutationObserver', 'NodeFilter', 'HTMLInputElement', 'SVGElement', 'Event', 'CustomEvent', 'FocusEvent', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('EventSource', class { close() {} addEventListener() {} removeEventListener() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);

  const reads: string[] = [];
  const posts: { url: string; body: unknown }[] = [];
  install('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      if (url === '/api/ui/backends/custom') {
        return Response.json({ backend: { id: 'deepseek', label: 'DeepSeek', origin: 'file', models: [], warnings: [] } }, { status: 201 });
      }
      return Response.json({});
    }
    // The Providers screen is painted at the caller's level: the superadmin's, full.
    if (url === '/api/ui/auth/me') return Response.json({ user: { id: 'u-root', is_superadmin: true }, can: {} });
    reads.push(url);
    if (url === '/api/ui/providers/overview') return Response.json({ providers: [claude], defaultBackend: 'claude' });
    if (url.startsWith('/api/ui/providers/acp-registry')) return Response.json(registry);
    if (url === '/api/ui/backends/manage') return Response.json({ backends: [], protocols: [] });
    return Response.json({});
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { SearchParamsContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const { AppRouterContext } = await import('next/dist/shared/lib/app-router-context.shared-runtime');
  const { setLocale, getLocale } = await import('@/lib/i18n');
  const previousLocale = getLocale();
  setLocale('en');
  const { ProvidersSettings } = await import('./providers-settings');

  const moves: { how: 'push' | 'replace'; href: string }[] = [];
  const router = {
    push: (href: string) => { moves.push({ how: 'push', href }); },
    replace: (href: string) => { moves.push({ how: 'replace', href }); },
    back: () => {}, forward: () => {}, refresh: () => {}, prefetch: () => {},
  };
  const root = createRoot(document.getElementById('root')!);
  const render = (search: string) => React.act(async () => {
    root.render(React.createElement(AppRouterContext.Provider, { value: router as never },
      React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams(search) as never },
        React.createElement(ProvidersSettings))));
  });
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const button = (label: string) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);
  const click = (el: Element) => React.act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  const type = (input: HTMLInputElement, value: string) => React.act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  const last = () => {
    const move = moves.at(-1);
    return move ? { how: move.how, params: new URL(move.href, 'http://localhost').searchParams } : null;
  };
  const registryRead = () => reads.some((url) => url.startsWith('/api/ui/providers/acp-registry'));

  try {
    // The list: a button, and no registry any more.
    await render('settings=models%2Fbackends');
    await until(() => button('Add a provider') !== undefined, 'the list and its button');
    assert.ok(!document.querySelector('[data-provider-catalog]'), 'the registry is no longer shown on the list');
    assert.equal(registryRead(), false, 'nor read');
    await click(button('Add a provider')!);
    assert.equal(last()?.how, 'push', 'Back returns to the list');
    assert.equal(last()?.params.get('add-provider'), '');
    assert.equal(last()?.params.get('settings'), 'models/backends');

    // The page before a choice: two ways, nothing read.
    await render('settings=models%2Fbackends&add-provider=');
    await until(() => document.querySelectorAll('[role="radio"]').length === 2, 'the two ways');
    assert.equal(document.querySelector('nav')?.textContent, 'ProvidersAdd a provider', 'the breadcrumb leads back to the list');
    assert.ok(!document.querySelector('[aria-checked="true"]'), 'nothing is chosen for the person');
    assert.equal(registryRead(), false, 'the third-party registry is read only once the catalog is chosen');
    await click(document.querySelector('[data-add-choice="catalog"]')!);
    assert.equal(last()?.how, 'replace');
    assert.equal(last()?.params.get('add-provider'), 'catalog');

    // The catalog: an installed agent opens the provider it became.
    await render('settings=models%2Fbackends&add-provider=catalog');
    await until(() => button('Open its page') !== undefined, 'the catalog');
    assert.equal(document.querySelector('[data-add-choice="catalog"]')?.getAttribute('aria-checked'), 'true');
    await click(button('Open its page')!);
    assert.equal(last()?.params.get('provider'), 'catalog:antigravity-acp');
    assert.equal(last()?.params.has('add-provider'), false, 'the page of the provider, not the add page any more');

    // A compatible endpoint: the form, then the new provider's page.
    await render('settings=models%2Fbackends&add-provider=endpoint');
    await until(() => document.querySelector('[data-add-endpoint]') !== null, 'the endpoint form');
    await type(document.querySelector<HTMLInputElement>('#backend-name')!, 'DeepSeek');
    await type(document.querySelector<HTMLInputElement>('#backend-url')!, 'https://api.deepseek.com/anthropic');
    await click(button('Add this provider')!);
    await until(() => posts.length === 1 && last()?.params.get('provider') === 'user:deepseek', 'the endpoint to be added and its page opened');
    assert.equal(posts[0]?.url, '/api/ui/backends/custom');
    const body = posts[0]?.body as { name?: string; baseUrl?: string };
    assert.equal(body.name, 'DeepSeek');
    assert.equal(body.baseUrl, 'https://api.deepseek.com/anthropic');
    assert.equal(last()?.how, 'replace', 'Back does not return to an emptied form');
  } finally {
    await React.act(async () => { root.unmount(); });
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    setLocale(previousLocale);
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
