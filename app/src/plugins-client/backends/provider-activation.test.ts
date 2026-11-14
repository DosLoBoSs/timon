/**
 * Switching a provider on or off from its page: off first shows what still
 * uses it and writes nothing before the confirm; on writes at once; a plugin
 * switched off elsewhere is not this switch's to turn on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitUntil } from '../../lib/test-wait';
import type { ProviderOverview } from '@/lib/provider-overview';

function provider(id: string, over: Partial<ProviderOverview> = {}): ProviderOverview {
  return {
    id, name: id, brand: null, icon: null, origin: 'plugin', pluginId: id, plugin: null, catalogAgent: null, enabled: true, isDefault: false,
    backends: [{ id, label: id, active: true, disabled: false, reason: null, modelCount: 1, defaultModel: null, isDefault: false, remote: false }],
    modelCount: 1, agentCount: 0,
    connection: { signedIn: null, signInCommand: null, signInThen: null, acceptsAccounts: false, accounts: [] },
    secret: { required: false, present: false, names: [] }, programs: [], status: 'available', updateAvailable: false, ...over,
  };
}

type Server = { provider: ProviderOverview; patches: Array<{ id: string; body: unknown }>; overviewReads: number };

async function mount(server: Server) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Element', 'Node',
    'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'FocusEvent', 'PointerEvent', 'DocumentFragment', 'NodeFilter', 'HTMLDivElement'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('IS_REACT_ACT_ENVIRONMENT', true);
  install('fetch', async (input: string, init?: { method?: string; body?: string }) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === '/api/ui/providers/overview') {
      server.overviewReads += 1;
      return Response.json({ providers: [server.provider], defaultBackend: null });
    }
    if (url === '/api/ui/backends/manage' && method === 'GET') {
      return Response.json({
        backends: server.provider.backends.map((backend) => ({
          id: backend.id, label: backend.label, origin: 'plugin', dialect: 'acme', disabled: backend.disabled,
          usages: { agents: [{ id: 'a1', label: 'Scout' }], routines: [], tasks: [{ id: 't1', label: 'Nightly digest' }] },
        })),
      });
    }
    const patch = /^\/api\/ui\/backends\/manage\/([^/]+)$/.exec(url);
    if (patch && method === 'PATCH') {
      const body = JSON.parse(init?.body ?? '{}') as { disabled: boolean };
      server.patches.push({ id: decodeURIComponent(patch[1]!), body });
      server.provider = {
        ...server.provider,
        enabled: !body.disabled,
        status: body.disabled ? 'disabled' : 'available',
        backends: server.provider.backends.map((backend) => ({ ...backend, disabled: body.disabled })),
      };
      return Response.json({ ok: true });
    }
    return new Response(null, { status: 404 });
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale, getLocale } = await import('@/lib/i18n');
  const previousLocale = getLocale();
  setLocale('en');
  const slots = await import('@/lib/plugin-host/slots');
  slots.resetSlotsForTests();
  slots.declareSlot('settings.provider.section', 'list');
  const page = await import('@/components/provider-page/provider-page');
  const { ProviderActivation } = await import('./provider-activation');

  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => {
    root.render(React.createElement(page.ProviderPage, { requested: server.provider.id, onBack: () => {}, HeaderAction: ProviderActivation }));
  });
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const click = async (element: Element | null | undefined) => {
    assert.ok(element, 'element to click');
    await React.act(async () => { (element as HTMLElement).click(); });
  };
  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    slots.resetSlotsForTests();
    setLocale(previousLocale);
    dom.window.close();
    for (const [k, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  };
  return { until, click, unmount };
}

const toggle = () => document.querySelector('[data-provider-activation]');

test('off lists what uses the provider and writes nothing before the confirm; on writes at once', async () => {
  const server: Server = { provider: provider('acme', { name: 'Acme' }), patches: [], overviewReads: 0 };
  const m = await mount(server);
  try {
    await m.until(() => toggle() !== null, 'the switch');
    assert.equal(toggle()?.getAttribute('aria-checked'), 'true');
    assert.equal(toggle()?.getAttribute('aria-label'), 'Enable or disable Acme');

    await m.click(toggle());
    await m.until(() => document.querySelector('[data-usage="agents"]') !== null, 'the confirmation');
    assert.match(document.body.textContent ?? '', /Disable Acme\?/);
    assert.match(document.querySelector('[data-usage="agents"]')?.textContent ?? '', /Scout/);
    assert.match(document.querySelector('[data-usage="tasks"]')?.textContent ?? '', /Nightly digest/);
    assert.equal(document.querySelector('[data-usage="routines"]'), null);
    assert.deepEqual(server.patches, [], 'nothing written before the confirm');

    const reads = server.overviewReads;
    await m.click(Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Disable provider'));
    await m.until(() => toggle()?.getAttribute('aria-checked') === 'false', 'the switch off');
    assert.deepEqual(server.patches, [{ id: 'acme', body: { disabled: true } }]);
    assert.ok(server.overviewReads > reads, 'the page reads the provider again');

    await m.click(toggle());
    await m.until(() => toggle()?.getAttribute('aria-checked') === 'true', 'the switch on');
    assert.deepEqual(server.patches.at(-1), { id: 'acme', body: { disabled: false } });
  } finally {
    await m.unmount();
  }
});

test('a provider whose plugin is off elsewhere cannot be turned on here; one without backend has no switch', async () => {
  const plugin = { id: 'acme', label: 'Acme', version: '1.0.0', state: 'disabled', reason: null, signed: true, builtin: false };
  const off = await mount({ provider: provider('acme', { plugin, enabled: false, status: 'disabled' }), patches: [], overviewReads: 0 });
  try {
    await off.until(() => toggle() !== null, 'the switch');
    assert.equal(toggle()?.hasAttribute('disabled'), true);
    assert.equal(toggle()?.getAttribute('aria-checked'), 'false');
  } finally {
    await off.unmount();
  }
  const bare = await mount({ provider: provider('bare', { backends: [] }), patches: [], overviewReads: 0 });
  try {
    await bare.until(() => document.querySelector('h3')?.textContent === 'bare', 'the page');
    assert.equal(toggle(), null);
  } finally {
    await bare.unmount();
  }
});
