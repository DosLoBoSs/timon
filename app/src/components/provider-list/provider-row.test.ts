/**
 * One provider's row and its slot `providers.row`: the product's row paints
 * the logo, the name, the one status line, "Update available" and the way to
 * the page; a plugin that takes the slot replaces it on every host and reads
 * the provider from `useProviderRow()`; its removal gives the product's back.
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

async function mount() {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'Element', 'Node',
    'MutationObserver', 'CustomEvent', 'Event', 'MouseEvent', 'DocumentFragment'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('IS_REACT_ACT_ENVIRONMENT', true);

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale, getLocale } = await import('@/lib/i18n');
  const previousLocale = getLocale();
  setLocale('en');
  const slots = await import('@/lib/plugin-host/slots');
  slots.resetSlotsForTests();
  const row = await import('./provider-row');
  const context = await import('./provider-row-context');
  // The product's row, registered the way the bundled half of `@timon/backends` mounts it.
  slots.register({ slot: slots.PROVIDER_ROW_SLOT, pluginId: '@timon/backends', fallback: true }, row.ProductProviderRow);

  const root = createRoot(document.getElementById('root')!);
  const render = async (element: React.ReactElement) => {
    await React.act(async () => { root.render(element); });
  };
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
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
  return { React, slots, row, context, render, until, unmount };
}

test('the product row paints the name, the status line, the update chip, and opens the page', async () => {
  const m = await mount();
  try {
    const { React, row } = m;
    let opened = 0;
    await m.render(React.createElement(row.ProviderRow, {
      provider: provider('acme', { name: 'Acme AI', status: 'not-connected', updateAvailable: true }),
      onOpen: () => { opened += 1; },
    }));
    const button = document.querySelector('[data-provider-row="acme"] button');
    assert.ok(button, 'the row opens the page');
    assert.equal(button.getAttribute('aria-label'), 'Open Acme AI');
    assert.match(button.textContent ?? '', /Acme AI/);
    assert.equal(document.querySelector('[data-provider-status]')?.getAttribute('data-provider-status'), 'not-connected');
    assert.match(document.body.textContent ?? '', /Not connected/);
    assert.match(document.querySelector('[data-provider-update]')?.textContent ?? '', /Update available/);
    await React.act(async () => { (button as HTMLElement).click(); });
    assert.equal(opened, 1);

    // The onboarding: no page to open, the surface's action at the end of the row.
    await m.render(React.createElement(row.ProviderRow, {
      provider: provider('acme', { name: 'Acme AI' }), mode: 'onboarding', action: React.createElement('button', { 'data-install': '' }, 'Install'),
    }));
    assert.equal(document.querySelector('[data-provider-row] > button'), null);
    assert.ok(document.querySelector('[data-install]'));
    assert.equal(document.querySelector('[data-provider-update]'), null);
  } finally {
    await m.unmount();
  }
});

test('a plugin that takes `providers.row` replaces the row and reads its provider; removed, the product row is back', async () => {
  const m = await mount();
  try {
    const { React, slots, row, context } = m;
    const seen: string[] = [];
    const off = slots.register({ slot: slots.PROVIDER_ROW_SLOT, pluginId: 'acme-rows' }, function CompactRow() {
      const host = context.useProviderRow();
      if (host) seen.push(`${host.mode}:${host.provider.id}:${host.status}`);
      return React.createElement('span', { 'data-compact': '' }, host?.provider.name);
    });
    await m.render(React.createElement(row.ProviderRow, { provider: provider('beta', { name: 'Beta', status: 'connected' }), onOpen: () => {} }));
    await m.until(() => document.querySelector('[data-compact]') !== null, 'the plugin row');
    assert.equal(document.querySelector('[data-compact]')?.textContent, 'Beta');
    assert.equal(document.querySelector('[data-provider-row]'), null);
    assert.deepEqual([...new Set(seen)], ['settings:beta:connected']);

    await React.act(async () => { off(); });
    await m.until(() => document.querySelector('[data-provider-row="beta"]') !== null, 'the product row again');
  } finally {
    await m.unmount();
  }
});
