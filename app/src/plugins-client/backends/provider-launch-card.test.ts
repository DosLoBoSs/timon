import assert from 'node:assert/strict';
import test from 'node:test';
import { waitUntil } from '@/lib/test-wait';
import type { ProviderOverview } from '@/lib/provider-overview';

/**
 * A refused third-party launch raises a card (`provider-launch:<plugin>`, TODO #598) that opens
 * Settings › AI models › Providers with `?provider=<plugin>`. Mounts the real `ProvidersSettings`
 * and checks what the operator can do there: the provider's page offers the program's review, the
 * dialog shows the paths the daemon resolves at the click and authorizes nothing until confirmed,
 * and the page reads the provider again afterwards. A provider with nothing to authorize offers no
 * such button. The daemon's refusal of anyone but a superadmin signed in to the app is covered by
 * `provider-routes.test.ts`.
 */
const moved = '/home/u/.local/share/acme/2.0.0/acme-agent';

function overviewOf(id: string, name: string, authorization: 'authorize' | 'ready'): ProviderOverview {
  return {
    id, name, brand: null, icon: null, origin: 'plugin', pluginId: id, plugin: null, catalogAgent: null, enabled: true, isDefault: false,
    backends: [{ id: `${id}-profile`, label: name, active: true, disabled: false, reason: null, modelCount: 1, defaultModel: null, isDefault: false, remote: false }],
    modelCount: 1, agentCount: 0,
    connection: { signedIn: null, signInCommand: null, signInThen: null, acceptsAccounts: false, accounts: [] },
    secret: { required: false, present: false, names: [] },
    programs: [{
      name: `${id}-agent`, path: moved, linkTarget: null, pinned: false, pin: null, version: null, latest: null, updateAvailable: false,
      unsupportedVersion: false, bundled: false, installable: false, installCommand: null, installDocs: null, authorization, refusedReason: null,
    }],
    status: authorization === 'authorize' ? 'needs-authorization' : 'available', updateAvailable: false,
  };
}

test('the refused launch card lands on the provider page, whose Program section authorizes nothing before its confirm', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/?settings=models%2Fbackends&provider=acme', pretendToBeVisual: true });
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
  install('IS_REACT_ACT_ENVIRONMENT', true);

  let acmeAllowed = false;
  const plugins = () => [{
    id: 'acme', label: 'Acme agent', version: '1.0.0', state: 'active', reason: null, error: null, signed: true,
    binaries: [{ name: 'acme-agent', found: 'acme-agent', resolved: moved, allowed: acmeAllowed, refused: null }], backends: ['acme-profile'],
  }];
  const posts: { url: string; body: unknown }[] = [];
  let overviewReads = 0;
  install('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    // The superadmin: the whole page (`lib/provider-access.ts`).
    if (url === '/api/ui/auth/me') return Response.json({ user: { id: 'u-admin', is_superadmin: true }, can: {} });
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      acmeAllowed = true;
      return Response.json({ granted: [moved] });
    }
    if (url === '/api/ui/providers/list') return Response.json({ providers: plugins() });
    if (url === '/api/ui/providers/overview') {
      overviewReads += 1;
      return Response.json({
        providers: [overviewOf('acme', 'Acme agent', acmeAllowed ? 'ready' : 'authorize'), overviewOf('beta', 'Beta agent', 'ready')],
        defaultBackend: null,
      });
    }
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
  const slots = await import('@/lib/plugin-host/slots');
  slots.resetSlotsForTests();
  // Declared at boot by the product layout (`UI_LAYOUT_CHILD_SLOTS`).
  slots.declareSlot('settings.provider.section', 'list');
  const { coreBackendsClient } = await import('@/plugins-client/backends');
  coreBackendsClient.apply({
    id: '@timon/backends',
    realtime: { subscribe: () => () => {} } as never,
    caps: null,
    zoneVisible: () => true,
    options: {},
    register: (options, Component) => (options.slot === 'settings.provider.section'
      ? slots.register({ ...options, pluginId: '@timon/backends' }, Component)
      : () => {}),
    onDispose: () => {},
  });
  const { ProvidersSettings } = await import('./providers-settings');

  const router = { push: () => {}, replace: () => {}, back: () => {}, forward: () => {}, refresh: () => {}, prefetch: () => {} };
  const root = createRoot(document.getElementById('root')!);
  const render = (search: string) => React.act(async () => {
    root.render(React.createElement(AppRouterContext.Provider, { value: router as never },
      React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams(search) as never },
        React.createElement(ProvidersSettings))));
  });
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const program = () => document.querySelector('[data-provider-section="program"]');
  const reviewButton = () => Array.from(program()?.querySelectorAll('button') ?? []).find((b) => b.textContent === 'Review and authorize');
  const dialog = () => document.querySelector('[role="dialog"]');
  const confirm = () => Array.from(dialog()?.querySelectorAll('button') ?? []).find((b) => b.textContent === 'Allow these programs');
  const click = (el: Element) => React.act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });

  try {
    await render('settings=models%2Fbackends&provider=acme');
    await until(() => reviewButton() !== undefined, 'the Program section to offer the review');
    assert.equal(document.querySelector('h3')?.textContent, 'Acme agent');
    assert.equal(dialog(), null, 'arriving opens nothing by itself');

    await click(reviewButton()!);
    await until(() => confirm() !== undefined, 'the authorization dialog');
    assert.match(dialog()!.textContent ?? '', /Acme agent/);
    assert.ok((dialog()!.textContent ?? '').includes(moved), 'the dialog shows the path the daemon resolved');
    assert.equal(posts.length, 0, 'opening the review authorizes nothing');

    const readsBefore = overviewReads;
    await click(confirm()!);
    await until(() => posts.length === 1 && dialog() === null, 'the authorization to be sent and the dialog closed');
    assert.deepEqual(posts[0], { url: '/api/ui/providers/acme/authorize', body: { paths: [moved] } });
    await until(() => overviewReads > readsBefore && reviewButton() === undefined, 'the page to read the provider again');

    // A provider with nothing to authorize: no review offered.
    await render('settings=models%2Fbackends&provider=beta');
    await until(() => document.querySelector('h3')?.textContent === 'Beta agent', 'the other provider page');
    assert.equal(reviewButton(), undefined);
    assert.equal(posts.length, 1, 'nothing else was authorized');
  } finally {
    await React.act(async () => { root.unmount(); });
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    slots.resetSlotsForTests();
    setLocale(previousLocale);
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
