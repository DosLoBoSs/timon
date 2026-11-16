/**
 * The sign-in page wears the installation's theme. Without a session the
 * plugin list answers 401, so the Timon theme's bundle never mounts: the page
 * is painted by the floor alone, and the product's fallback must not paint its
 * blue over it once the loader gives up: the sign-in was shown blue while
 * every account behind it wore Timon.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReactElement } from 'react';
import { readPublicTheme, PUBLIC_THEME_PATH } from './public-theme';
import { TIMON_THEME_PLUGIN } from '@/plugins-client/theme-timon-floor';

const PRODUCT = '@timon/ui-theme';

const answer = (status: number, body: unknown) => async (): Promise<Response> =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('the server reads the installation\'s theme on the public route, and only a built-in one', async () => {
  let asked = '';
  const seen = await readPublicTheme(async (path) => { asked = path; return answer(200, { theme: TIMON_THEME_PLUGIN })(); }, PRODUCT);
  assert.equal(asked, PUBLIC_THEME_PATH);
  assert.equal(seen, TIMON_THEME_PLUGIN);
  assert.equal(await readPublicTheme(answer(200, { theme: PRODUCT }), TIMON_THEME_PLUGIN), PRODUCT);
  // Anything else keeps what `/api/auth/me` said: the daemon names nothing else.
  assert.equal(await readPublicTheme(answer(200, { theme: 'acme-theme' }), TIMON_THEME_PLUGIN), TIMON_THEME_PLUGIN);
  assert.equal(await readPublicTheme(answer(404, { error: 'not_found' }), TIMON_THEME_PLUGIN), TIMON_THEME_PLUGIN, 'an older daemon');
  assert.equal(await readPublicTheme(async () => { throw new Error('down'); }, TIMON_THEME_PLUGIN), TIMON_THEME_PLUGIN);
});

type Page = { html: () => string; tokensPainted: () => boolean; done: () => Promise<void> };

/** The root layout's theme part, rendered in a browser, once the loader has settled. */
async function renderPage(opts: { pathname: string; theme: string; signedIn: boolean; plugins?: unknown[] }): Promise<Page> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: `http://localhost${opts.pathname}`, pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of [
    'window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'CustomEvent', 'Event',
    'localStorage', 'sessionStorage', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
  ] as const) install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  install('self', dom.window);
  install('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  (dom.window as unknown as { matchMedia: unknown }).matchMedia = (globalThis as unknown as { matchMedia: unknown }).matchMedia;
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/ui/plugins')) {
      return opts.signedIn
        ? new Response(JSON.stringify({ plugins: opts.plugins ?? [] }))
        : new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    }
    if (url.includes('/api/ui/auth/me')) {
      return new Response(JSON.stringify({ user: opts.signedIn ? { id: 'u1' } : null, prefs: { theme: TIMON_THEME_PLUGIN, layout: '@timon/ui-layout', scheme: 'dark' } }));
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;

  const React = await import('react');
  install('React', React);
  const { act } = React;
  const { createRoot } = await import('react-dom/client');
  const { PathnameContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const { ThemeProvider } = await import('@/components/theme-provider');
  // The floor takes an optional props object: typed here so `createElement` keeps the `theme` prop.
  const ThemeFloor = (await import('./plugin-host/theme-floor')).ThemeFloor as (props: { theme?: string }) => ReactElement;
  const { ThemeRoot, THEME_TOKENS_STYLE_ID } = await import('@/plugins-client/ui-theme');
  const loader = await import('./plugin-host/loader');
  const { forgetSharedReads } = await import('./shared-read');
  loader.resetClientPluginsForTests();
  forgetSharedReads();

  const tree: ReactElement = React.createElement(PathnameContext.Provider, { value: opts.pathname },
    React.createElement(ThemeProvider, { initialTheme: opts.theme, children: [
      React.createElement(ThemeFloor, { key: 'floor', theme: opts.theme }),
      React.createElement(ThemeRoot, { key: 'slot' }),
    ] }));
  const root = createRoot(dom.window.document.getElementById('root')!);
  await act(async () => { root.render(tree); });
  // What the client host does on mount: the page settles with or without a list.
  await act(async () => { await loader.syncClientPlugins(); });
  assert.equal(loader.pluginsSynced(), true, 'the loader settled');

  return {
    html: () => dom.window.document.getElementById('root')!.innerHTML,
    tokensPainted: () => dom.window.document.getElementById(THEME_TOKENS_STYLE_ID) !== null,
    async done() {
      await act(async () => { root.unmount(); });
      loader.resetClientPluginsForTests();
      forgetSharedReads();
      globalThis.fetch = originalFetch;
      dom.window.close();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    },
  };
}

for (const pathname of ['/login', '/invite', '/confirm-email/abc', '/setup']) {
  test(`${pathname} without a session wears the Timon theme the installation wears`, async () => {
    const page = await renderPage({ pathname, theme: TIMON_THEME_PLUGIN, signedIn: false });
    try {
      assert.equal(page.tokensPainted(), false, 'the product palette must not paint over the floor once the loader gives up');
      // The Timon tokens, dark and light: the page's scheme picks one.
      assert.ok(page.html().includes('--surface-0: 266 15% 10.5%'), 'the Timon dark tokens reach the page');
      assert.ok(page.html().includes('--surface-0: 33 32% 93.2%'), 'and the light ones');
    } finally {
      await page.done();
    }
  });
}

test('an installation on the product theme keeps it on the sign-in page', async () => {
  const page = await renderPage({ pathname: '/login', theme: PRODUCT, signedIn: false });
  try {
    assert.equal(page.tokensPainted(), true);
    assert.equal(page.html().includes('--surface-0: 266 15% 10.5%'), false, 'no Timon token');
  } finally {
    await page.done();
  }
});

test('signed in, a Timon theme that never mounts still leaves the product palette to paint', async () => {
  // The list was read and holds no Timon theme (switched off): the fallback paints, as before.
  const page = await renderPage({ pathname: '/', theme: TIMON_THEME_PLUGIN, signedIn: true, plugins: [] });
  try {
    assert.equal(page.tokensPainted(), true);
  } finally {
    await page.done();
  }
});
