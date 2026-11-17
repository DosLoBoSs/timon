import assert from 'node:assert/strict';
import { waitUntil } from './test-wait';
import test from 'node:test';

/**
 * The width handle of a chat column, mounted for real: what a keyboard, a
 * double-click and a pointer drag ask of the page.
 */
test('column width handle: keyboard, double-click and drag, on both sides', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('self', dom.window);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  install('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0) as unknown as number);
  install('cancelAnimationFrame', (id: number) => clearTimeout(id));
  const React = await import('react');
  install('React', React);

  const COL = 'chat.left.widget';
  install('fetch', async (input: string) => {
    const url = String(input);
    if (url === '/api/ui/auth/me') return Response.json({ user: { id: 'owner' } });
    if (url.startsWith('/api/ui/layout?scope=')) return Response.json({ layout: [{ id: 'plugin:fixture:a', rail: COL, rang: 0, hauteur: 200 }] });
    return new Response(null, { status: 404 });
  });

  const { declareSlot, register, resetSlotsForTests } = await import('./plugin-host/slots');
  resetSlotsForTests();
  declareSlot('cockpit.widget', 'list');
  register({ slot: 'cockpit.widget', pluginId: 'fixture', key: 'a', widget: { title: 'Alpha' } }, () => React.createElement('p', null, 'body'));

  const { createRoot } = await import('react-dom/client');
  const { PathnameContext, SearchParamsContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const { WorkspaceLayoutProvider } = await import('../components/workspace-layout-provider');
  const { WidgetHost } = await import('../components/widget-host/widget-host');
  const { ChatWidgetRail } = await import('../components/chat/chat-rails');

  const calls: Array<[number, boolean] | 'reset'> = [];
  let side: 'left' | 'right' = 'left';
  let apart = false;
  const view = () => React.createElement(PathnameContext.Provider, { value: '/chat' },
    React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams() },
      React.createElement(WorkspaceLayoutProvider, null,
        React.createElement(WidgetHost, null,
          React.createElement(ChatWidgetRail, {
            zone: COL,
            side,
            label: 'Left',
            pushedAside: apart,
            resize: {
              width: 300,
              max: 500,
              onChange: (l: number, p: boolean) => { calls.push([l, p]); },
              onReset: () => { calls.push('reset'); },
            },
          })))));

  const root = createRoot(document.getElementById('root')!);
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  await React.act(async () => { root.render(view()); });

  const handle = () => document.querySelector<HTMLElement>('[role="separator"][aria-orientation="vertical"]');
  const press = async (key: string, shiftKey = false) => {
    await React.act(async () => { handle()!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, shiftKey, bubbles: true })); });
  };
  const pointer = async (type: string, clientX: number) => {
    await React.act(async () => { handle()!.dispatchEvent(new dom.window.MouseEvent(type, { clientX, button: 0, bubbles: true })); });
  };
  await until(() => handle() !== null, 'the column to paint its width handle');

  try {
    const p = handle();
    assert.ok(p, 'the column has a width handle');
    assert.equal(p.getAttribute('aria-valuenow'), '300');
    assert.equal(p.getAttribute('aria-valuemin'), '240');
    assert.equal(p.getAttribute('aria-valuemax'), '500');
    assert.equal(p.tabIndex, 0, 'reachable from the keyboard');

    await press('ArrowRight');
    await press('ArrowLeft', true);
    await press('Home');
    await press('End');
    assert.deepEqual(calls.splice(0), [[316, true], [240, true], [240, true], [500, true]],
      'on the left, the right arrow widens; bounds hold');

    await pointer('pointerdown', 100);
    await pointer('pointerup', 100);
    await React.act(async () => { handle()!.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true })); });
    assert.deepEqual(calls.splice(0), ['reset'], 'a click writes nothing, a double-click resets');

    await pointer('pointerdown', 100);
    await pointer('pointermove', 180);
    await until(() => calls.length > 0, 'the drag to show its width');
    await pointer('pointerup', 180);
    assert.deepEqual(calls.splice(0), [[380, false], [380, true]], 'shown while dragging, written on release');

    side = 'right';
    await React.act(async () => { root.render(view()); });
    await press('ArrowRight');
    await pointer('pointerdown', 100);
    await pointer('pointermove', 60);
    await until(() => calls.length > 1, 'the drag to show its width');
    await pointer('pointerup', 60);
    assert.deepEqual(calls.splice(0), [[284, true], [340, false], [340, true]], 'on the right, the column grows leftwards');

    apart = true;
    await React.act(async () => { root.render(view()); });
    assert.equal(handle(), null, 'a column slid out by focus mode has no handle');
  } finally {
    await React.act(async () => { root.unmount(); });
    resetSlotsForTests();
  }
});
