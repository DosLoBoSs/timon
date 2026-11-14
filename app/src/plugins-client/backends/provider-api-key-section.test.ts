import assert from 'node:assert/strict';
import test from 'node:test';
import { waitUntil } from '@/lib/test-wait';
import type { ProviderOverview } from '@/lib/provider-overview';

/**
 * The API key section of a provider page: mounts the real `ProvidersSettings` and checks that it
 * says whether the vault holds the provider's key, writes it reserved to the provider's backends
 * through the vault's own route, forgets the typed value once saved and reads the provider again.
 * The value is never shown, nor put in an address. A provider without a key paints no section.
 * The vault's refusal of anyone but a superadmin to grant is covered by the secrets-vault tests.
 */
function overviewOf(id: string, name: string, secret: ProviderOverview['secret']): ProviderOverview {
  return {
    id, name, brand: null, icon: null, origin: 'user', pluginId: null, plugin: null, catalogAgent: null, enabled: true, isDefault: false,
    backends: [{ id, label: name, active: secret.present, disabled: false, reason: null, modelCount: 1, defaultModel: null, isDefault: false, remote: true }],
    modelCount: 1, agentCount: 0,
    connection: { signedIn: null, signInCommand: null, signInThen: null, acceptsAccounts: false, accounts: [] },
    secret,
    programs: [],
    status: secret.present || !secret.required ? 'available' : 'not-connected', updateAvailable: false,
  };
}

test('the API key section writes the provider\'s key, reserved to it, and never shows it back', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/?settings=models%2Fbackends&provider=llmtr', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('window', dom.window);
  install('self', dom.window);
  for (const key of ['document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLFormElement', 'Element', 'Node', 'DocumentFragment', 'MutationObserver', 'NodeFilter', 'HTMLInputElement', 'HTMLSelectElement', 'SVGElement', 'Event', 'CustomEvent', 'FocusEvent', 'MouseEvent', 'KeyboardEvent', 'SubmitEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);

  let stored = false;
  const writes: { url: string; method: string; body: unknown }[] = [];
  const addresses: string[] = [];
  let overviewReads = 0;
  install('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    // The superadmin: the whole page (`lib/provider-access.ts`).
    if (url === '/api/ui/auth/me') return Response.json({ user: { id: 'u-admin', is_superadmin: true }, can: {} });
    const method = init?.method ?? 'GET';
    addresses.push(url);
    if (url === '/api/ui/providers/overview') {
      overviewReads += 1;
      return Response.json({
        providers: [
          overviewOf('llmtr', 'LLM router', { required: true, present: stored, names: ['LLMTR_API_KEY'] }),
          overviewOf('local', 'Local', { required: false, present: false, names: [] }),
        ],
        defaultBackend: null,
      });
    }
    if (url === '/api/ui/secrets' && method === 'GET') return Response.json({ secrets: [] });
    if (url.startsWith('/api/ui/secrets')) {
      writes.push({ url, method, body: JSON.parse(String(init?.body)) });
      stored = true;
      return Response.json({ id: 's1' }, { status: 201 });
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
  const section = () => document.querySelector('[data-provider-section="apiKey"]');
  const click = (el: Element) => React.act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });

  try {
    await render('settings=models%2Fbackends&provider=llmtr');
    await until(() => section()?.querySelector('[data-api-key="absent"]') != null, 'the key reported missing');
    assert.equal(section()!.querySelector('input'), null, 'no field on the page');
    await click(Array.from(section()!.querySelectorAll('button')).find((b) => b.textContent === 'Add a key')!);
    const dialog = () => document.querySelector('[data-secret-dialog]');
    await until(() => dialog()?.querySelector('input') != null, 'the key dialog');
    const input = dialog()!.querySelector('input')!;
    assert.equal(input.type, 'password');
    assert.equal(input.value, '', 'the field starts empty');

    await React.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, ' sk-live-123 ');
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    const readsBefore = overviewReads;
    const save = Array.from(dialog()!.querySelectorAll('button')).find((b) => b.textContent === 'Save')!;
    await React.act(async () => { save.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await until(() => writes.length === 1, 'the key to be written');
    assert.deepEqual(writes[0], {
      url: '/api/ui/secrets', method: 'POST',
      body: { name: 'LLMTR_API_KEY', mode: 'inject', note: null, grants: [{ scope_kind: 'backend', scope_ref: 'llmtr' }], value: 'sk-live-123' },
    });
    await until(() => overviewReads > readsBefore && section()?.querySelector('[data-api-key="present"]') != null, 'the key reported saved');
    await until(() => dialog() === null, 'the dialog closed once saved');
    assert.ok(!(document.body.textContent ?? '').includes('sk-live'), 'the key is never shown');
    assert.ok(addresses.every((address) => !address.includes('sk-live')), 'nor put in an address');
    assert.ok(Array.from(section()!.querySelectorAll('button')).some((b) => b.textContent === 'Replace'));

    await render('settings=models%2Fbackends&provider=local');
    await until(() => document.querySelector('h3')?.textContent === 'Local', 'the other provider page');
    assert.equal(section()?.textContent ?? '', '', 'no API key section');
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
