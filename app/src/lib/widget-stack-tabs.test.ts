import assert from 'node:assert/strict';
import { waitUntil } from './test-wait';
import test from 'node:test';

/**
 * What a stack's tabs carry besides a title: a short name, the count a
 * widget publishes, and the header actions it hands to the menu. A widget
 * that publishes a count stays mounted behind the front tab, so its count
 * stays true; any other is painted only in front.
 */
const mounts: Record<string, number> = { list: 0, plain: 0 };
let reloads = 0;
const seenTabbed: boolean[] = [];

async function mountStack(stored: Array<{ id: string } & Record<string, unknown>>) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'getComputedStyle']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('self', dom.window);
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('DOMRect', (dom.window as unknown as Record<string, unknown>).DOMRect);
  install('MouseEvent', dom.window.MouseEvent);
  for (const key of ['MutationObserver', 'HTMLInputElement', 'HTMLButtonElement', 'FocusEvent', 'CustomEvent', 'DocumentFragment']) install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  install('fetch', async (input: string) => {
    const url = String(input);
    if (url === '/api/ui/auth/me') return Response.json({ user: { id: 'owner' } });
    if (url.startsWith('/api/ui/layout?scope=')) return Response.json({ layout: stored });
    return new Response(null, { status: 404 });
  });

  const { declareSlot, register, resetSlotsForTests } = await import('./plugin-host/slots');
  const { createRoot } = await import('react-dom/client');
  const { PathnameContext, SearchParamsContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const { WorkspaceLayoutProvider } = await import('../components/workspace-layout-provider');
  const { WidgetHost } = await import('../components/widget-host/widget-host');
  const { WidgetZone } = await import('../components/widget-host/widget-zone');
  const { useWidgetCount, useWidgetMenu } = await import('../components/widget-host/widget-self');
  const h = React.createElement;

  // A list that counts its rows and hands its reload button to the menu.
  function List() {
    React.useEffect(() => { mounts.list += 1; }, []);
    const tabbed = useWidgetCount(7);
    const inMenu = useWidgetMenu(React.useMemo(() => [{ key: 'reload', label: 'Reload list', onSelect: () => { reloads += 1; } }], []));
    seenTabbed.push(tabbed);
    return h('section', null, h('header', null, h('span', null, 'Pull requests'), !tabbed && h('span', { 'data-own-count': '' }, '7'),
      !inMenu && h('button', { type: 'button', 'data-own-reload': '' }, 'Reload')), h('p', { 'data-list-body': '' }, 'rows'));
  }
  function Plain() {
    React.useEffect(() => { mounts.plain += 1; }, []);
    return h('p', { 'data-plain-body': '' }, 'plain');
  }

  resetSlotsForTests();
  declareSlot('cockpit.widget', 'list');
  register({ slot: 'cockpit.widget', pluginId: '@timon/fixture', key: 'list', widget: { title: 'Pull requests', tabTitle: 'PR', liveCount: true, frame: 'none' } }, List as never);
  register({ slot: 'cockpit.widget', pluginId: '@timon/fixture', key: 'plain', widget: { title: 'Plain' } }, Plain as never);
  // A third party cannot use the product's short tab names.
  register({ slot: 'cockpit.widget', pluginId: 'third', key: 'x', widget: { title: 'Third party', tabTitle: 'T' } as never }, Plain as never);

  const root = createRoot(document.getElementById('root')!);
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  await React.act(async () => {
    root.render(h(PathnameContext.Provider, { value: '/' },
      h(SearchParamsContext.Provider, { value: new URLSearchParams() },
        h(WorkspaceLayoutProvider, null,
          h(WidgetHost, null, h(WidgetZone, { zone: 'droite', slot: 'cockpit.widget', label: 'Cockpit' }))))));
  });
  await until(() => document.querySelectorAll('[data-widget-id]').length > 0, 'the stored cards to be painted');
  const cleanup = async () => {
    await React.act(async () => { root.unmount(); });
    resetSlotsForTests();
  };
  return { React, until, cleanup };
}

const reset = () => { mounts.list = 0; mounts.plain = 0; reloads = 0; seenTabbed.length = 0; };
const tab = (id: string) => document.querySelector<HTMLElement>(`[id="tab-plugin:${id}"]`);
const menuEntries = () => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]'));

test('a stacked widget shows its short name and its count on its tab, and stays mounted behind', async () => {
  reset();
  const { React, until, cleanup } = await mountStack([
    { id: 'plugin:@timon/fixture:plain', rail: 'droite', rang: 0, hauteur: 200, group: 'stack:t:1', activeTab: true },
    { id: 'plugin:@timon/fixture:list', rail: 'droite', rang: 1, hauteur: 200, group: 'stack:t:1' },
    { id: 'plugin:third:x', rail: 'droite', rang: 2, hauteur: 200, group: 'stack:t:1' },
  ]);
  try {
    await until(() => !!tab('@timon/fixture:list')?.querySelector('[data-tab-count]'), 'the count on the tab');
    const listTab = tab('@timon/fixture:list')!;
    assert.equal(listTab.querySelector('[data-tab-title]')?.textContent, 'PR');
    assert.equal(listTab.querySelector('[data-tab-count]')?.textContent, '7');
    assert.equal(listTab.getAttribute('title'), 'Pull requests', 'the full name stays in the tooltip');
    assert.equal(listTab.getAttribute('aria-label'), 'Pull requests 7');
    assert.equal(tab('third:x')?.querySelector('[data-tab-title]')?.textContent, 'Third party', 'a third party keeps its title');
    assert.equal(mounts.list, 1, 'the counting widget is mounted behind the front tab');
    assert.equal(document.getElementById('panel-plugin:@timon/fixture:list')?.className, 'hidden');
    assert.ok(seenTabbed.every(Boolean), 'it knows it is a tab, so it does not paint its own count');
    assert.ok(!document.querySelector('[data-own-count]'));
    await React.act(async () => { listTab.click(); });
    await until(() => !!document.querySelector('[data-list-body]')?.closest('.widget-content'), 'the list in front');
    assert.equal(mounts.list, 1, 'bringing it to the front does not remount it');
    assert.ok(!document.querySelector('[data-plain-body]'), 'a widget without a count leaves with its tab');
    await React.act(async () => { tab('@timon/fixture:plain')!.click(); });
    await until(() => !!document.querySelector('[data-plain-body]'), 'the plain widget back in front');
    assert.equal(mounts.plain, 2, 'and is painted again when it comes back');
  } finally {
    await cleanup();
  }
});

test('a stacked widget hands its header button to the menu; alone, it keeps it and its count', async () => {
  reset();
  const stacked = await mountStack([
    { id: 'plugin:@timon/fixture:list', rail: 'droite', rang: 0, hauteur: 200, group: 'stack:t:1', activeTab: true },
    { id: 'plugin:@timon/fixture:plain', rail: 'droite', rang: 1, hauteur: 200, group: 'stack:t:1' },
  ]);
  try {
    const { React, until } = stacked;
    assert.ok(!document.querySelector('[data-own-reload]'), 'no button kept in the header');
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
    await React.act(async () => { tab('@timon/fixture:list')!.dispatchEvent(menu); });
    await until(() => menuEntries().length > 0, 'the menu to open');
    const reload = menuEntries().find((item) => item.textContent === 'Reload list');
    assert.ok(reload, 'the reload is the menu\'s first business');
    assert.equal(menuEntries()[0], reload);
    await React.act(async () => { reload!.click(); });
    assert.equal(reloads, 1);
  } finally {
    await stacked.cleanup();
  }

  reset();
  const alone = await mountStack([{ id: 'plugin:@timon/fixture:list', rail: 'droite', rang: 0, hauteur: 200 }]);
  try {
    assert.ok(!document.querySelector('[role="tab"]'));
    assert.ok(document.querySelector('[data-own-reload]'), 'alone, the header keeps its button');
    assert.ok(document.querySelector('[data-own-count]'), 'and the widget paints its count by its title');
  } finally {
    await alone.cleanup();
  }
});

test('the tab strip goes tight only when a title would be cut', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div class="widget-tablist"><button role="tab"><span data-tab-title>Branches</span></button><button role="tab"><span data-tab-title>Chantiers</span></button></div>');
  const list = dom.window.document.querySelector<HTMLElement>('.widget-tablist')!;
  const titles = Array.from(list.querySelectorAll<HTMLElement>('[data-tab-title]'));
  const size = (el: HTMLElement, scroll: number, client: number) => {
    Object.defineProperty(el, 'scrollWidth', { value: scroll, configurable: true });
    Object.defineProperty(el, 'clientWidth', { value: client, configurable: true });
  };
  const { fitTabs } = await import('../components/widget-host/widget-card');
  size(titles[0]!, 52, 52); size(titles[1]!, 53, 53);
  fitTabs(list);
  assert.equal(list.dataset.tight, undefined, 'room enough: the roomy form');
  size(titles[1]!, 60, 53);
  fitTabs(list);
  assert.equal(list.dataset.tight, '', 'a title cut: tight');
  size(titles[1]!, 53, 53);
  fitTabs(list);
  assert.equal(list.dataset.tight, undefined, 'room again: back to roomy');
});
