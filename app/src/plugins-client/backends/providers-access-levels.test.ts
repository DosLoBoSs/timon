import assert from 'node:assert/strict';
import test from 'node:test';
import { waitUntil } from '@/lib/test-wait';
import type { ProviderOverview } from '@/lib/provider-overview';

/**
 * The Providers screen at each level of an account that is not the superadmin
 * (`lib/provider-access.ts`), mounted in the real `ProvidersSettings`:
 * own accounts only reads the list without its controls and a page with the
 * Connection section alone; full access gets every section and the switch;
 * hidden gets nothing, not even a read of the providers. The daemon's own
 * refusals are `provider-access-routes.test.ts`.
 */
function overviewOf(id: string, name: string): ProviderOverview {
  return {
    id, name, brand: null, icon: null, origin: 'plugin', pluginId: id, plugin: null, catalogAgent: null, enabled: true, isDefault: false,
    backends: [{ id: `${id}-profile`, label: name, active: true, disabled: false, reason: null, modelCount: 1, defaultModel: null, isDefault: false, remote: false }],
    modelCount: 1, agentCount: 0,
    connection: { signedIn: null, signInCommand: null, signInThen: null, acceptsAccounts: true, accounts: [] },
    secret: { required: false, present: false, names: [] },
    programs: [{
      name: `${id}-agent`, path: '/opt/acme/agent', linkTarget: null, pinned: false, pin: null, version: '1.0.0', latest: null, updateAvailable: false,
      unsupportedVersion: false, bundled: false, installable: false, installCommand: null, installDocs: null, authorization: 'ready', refusedReason: null,
    }],
    status: 'available', updateAvailable: false,
  };
}

test('own accounts reads the list and the Connection section alone; full gets every section; hidden gets nothing', async () => {
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
  install('IS_REACT_ACT_ENVIRONMENT', true);

  let can: Record<string, boolean> = { 'providers:accounts': true };
  let overviewReads = 0;
  install('fetch', async (input: string | URL | Request) => {
    const url = String(input);
    if (url === '/api/ui/auth/me') return Response.json({ user: { id: 'u-ada', is_superadmin: false }, can });
    if (url === '/api/ui/providers/overview') {
      overviewReads += 1;
      return Response.json({ providers: [overviewOf('acme', 'Acme agent')], defaultBackend: null });
    }
    if (url === '/api/ui/backends/accounts') return Response.json({ accounts: [], backends: ['acme-profile'] });
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
  const { refreshMe } = await import('@/hooks/use-me');
  const slots = await import('@/lib/plugin-host/slots');
  slots.resetSlotsForTests();
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
  const buttons = () => Array.from(document.querySelectorAll('button')).map((b) => b.textContent ?? '');
  const sections = () => Array.from(document.querySelectorAll('[data-provider-section]')).map((el) => el.getAttribute('data-provider-section'));

  try {
    // Own accounts only: the list, its search and its rows; nothing that changes the install.
    await refreshMe();
    await render('settings=models%2Fbackends');
    await until(() => document.querySelector('[data-providers-list]') !== null, 'the list');
    await until(() => buttons().some((label) => label.includes('Acme agent')), 'the provider row');
    assert.equal(document.querySelector('[data-default-provider]'), null, 'the default provider is the install\'s');
    assert.equal(buttons().some((label) => /Reorder|Check/.test(label)), false);
    assert.equal(document.querySelector('[data-providers-hidden]'), null);

    // Its page: the Connection section and nothing else, no switch.
    await render('settings=models%2Fbackends&provider=acme');
    await until(() => document.querySelector('h3')?.textContent === 'Acme agent', 'the provider page');
    await until(() => document.querySelector('[data-connection="accounts"]') !== null, 'the own accounts');
    assert.deepEqual(sections(), ['connection']);
    assert.equal(document.querySelector('[data-provider-activation]'), null);

    // Full access, without being the superadmin: every section, and the switch.
    can = { 'providers:manage': true };
    await refreshMe();
    await render('settings=models%2Fbackends&provider=acme');
    await until(() => sections().includes('program'), 'the full page');
    assert.ok(sections().includes('models'));
    await until(() => document.querySelector('[data-provider-activation]') !== null, 'the on/off switch');

    // Hidden: a pasted link reads a refusal, and the providers are not even read.
    can = {};
    await refreshMe();
    const reads = overviewReads;
    await render('settings=models%2Fbackends&provider=acme');
    await until(() => document.querySelector('[data-providers-hidden]') !== null, 'the refusal');
    assert.deepEqual(sections(), []);
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    assert.equal(overviewReads, reads);
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
