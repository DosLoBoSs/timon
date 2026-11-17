/**
 * The page's Glass submenu, as the top bar's Appearance menu holds it: offered
 * only while the glass is on and a workspace published the page's control.
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { GlassScope } from '@/lib/glass-scope';

async function mount(ctx: TestContext, { glass }: { glass: boolean }) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/kanban', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'MutationObserver']) {
    install(key, key === 'window' ? dom.window : Reflect.get(dom.window, key));
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  if (glass) dom.window.document.documentElement.setAttribute('data-glass', '');
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } = await import('@/components/ui/dropdown-menu');
  const { PageGlassSubmenu } = await import('./island-glass-menu');
  const { publishPageGlass } = await import('./page-glass');
  const root = createRoot(document.getElementById('root')!);
  const act = (fn: () => void | Promise<void>) => React.act(async () => { await fn(); });
  await act(() => {
    root.render(React.createElement(DropdownMenu, { open: true, modal: false },
      React.createElement(DropdownMenuTrigger, null, 'Appearance'),
      React.createElement(DropdownMenuContent, null, React.createElement(PageGlassSubmenu))));
  });
  ctx.after(async () => {
    await act(() => root.unmount());
    // Radix returns the focus of the unmounted menu on a timer: let it run on this window.
    await new Promise((resolve) => setTimeout(resolve, 0));
    dom.window.close();
    for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
  });
  return { act, publishPageGlass };
}

const trigger = () => document.querySelector<HTMLElement>('[data-island-menu="glass"]');

test('the page alone gets its Glass submenu in the Appearance menu, and it writes there', async (t) => {
  const w = await mount(t, { glass: true });
  assert.equal(trigger(), null, 'no workspace published a page without a header');
  const chosen: (GlassScope | null)[] = [];
  let withdraw: () => void = () => {};
  await w.act(() => { withdraw = w.publishPageGlass({ scope: 'widgets', set: (scope) => { chosen.push(scope); } }); });
  assert.equal(trigger()?.textContent, 'Glass of this page', 'says whose glass, among the menu of the whole app');
  await w.act(() => {
    trigger()!.focus();
    trigger()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  });
  assert.equal(document.querySelector('[data-island-glass="widgets"]')?.getAttribute('aria-checked'), 'true');
  assert.ok(!document.querySelector('[data-island-glass="both"]'), 'what glass tuning hides stays hidden');
  await w.act(() => { document.querySelector<HTMLElement>('[data-island-glass="follow"]')!.click(); });
  assert.deepEqual(chosen, [null], '"Follow" hands the page back to the Appearance setting');
  await w.act(() => { withdraw(); });
  assert.equal(trigger(), null, 'split again: the island header offers it');
});

test('with the glass off, the Appearance menu offers no page Glass', async (t) => {
  const w = await mount(t, { glass: false });
  await w.act(() => { w.publishPageGlass({ scope: null, set: () => {} }); });
  assert.equal(trigger(), null);
});
