import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// An island with a colour of its own (the AppFrame's right rail, the chat's
// widget drawer) kept it under the glass: a `bg-*` utility beats the glass
// rules, which are deliberately as weak as a utility. Its colour now goes
// through `--timon-island-fill`, which only the glass-off rule reads, so the
// glass scope decides its fill like any other island's (TODO #805).

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..');
const css = readFileSync(path.join(src, 'styles/globals.css'), 'utf8');

test('an island\'s own colour is a variable that only the glass-off rule reads', () => {
  const base = /\n {2}\.timon-island \{([^}]*)\}/.exec(css);
  assert.ok(base, 'the island rule exists');
  assert.match(base[1]!, /background: var\(--timon-island-fill, hsl\(var\(--background\)\)\);/);
  const glass = /:where\(html\[data-glass\]\) \.timon-island \{([^}]*)\}/.exec(css);
  assert.ok(glass, 'the glass rule exists');
  assert.match(glass[1]!, /background: var\(--timon-glass-island-plate, transparent\);/);
  assert.doesNotMatch(glass[1]!, /--timon-island-fill/, 'the glass replaces the island\'s own colour');
  assert.ok(css.indexOf(glass[0]) > css.indexOf(base[0]), 'same specificity: the glass rule comes after');
});

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : sources(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

test('no island paints its colour with a bg-* utility: it would beat the glass scope', () => {
  const offenders: string[] = [];
  for (const file of sources(src)) {
    const text = readFileSync(file, 'utf8');
    for (const [literal] of text.matchAll(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g)) {
      const tokens = literal.slice(1, -1).split(/\s+/);
      if (!tokens.includes('timon-island')) continue;
      const fills = tokens.filter((tok) => /(^|:)bg-/.test(tok));
      if (fills.length) offenders.push(`${path.relative(src, file)}: ${fills.join(' ')}`);
    }
  }
  assert.deepEqual(offenders, [], 'set `[--timon-island-fill:…]` instead');
});

test('the right rail keeps its surface colour with the glass off', () => {
  const layout = readFileSync(path.join(src, 'lib/plugin-host/ui-layout.tsx'), 'utf8');
  assert.match(layout, /zone="sidebar\.right\.widget"[\s\S]*?className="timon-island [^"]*\[--timon-island-fill:hsl\(var\(--surface-1\)\)\]/);
});

/**
 * The drawer slides over the thread: with the glass on it lays its own frosted
 * copy of the wallpaper (`GlassClear`), which the scope then fills (plate) or
 * leaves sharp (widgets). Glass off, nothing is laid and the island's default
 * colour shows.
 */
test('the chat\'s widget drawer frosts its own copy of the wallpaper in every glass scope', async (t) => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const globals = globalThis as Record<string, unknown>;
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'KeyboardEvent', 'IS_REACT_ACT_ENVIRONMENT', 'React'];
  const saved = new Map(keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const));
  for (const key of keys) {
    if (key === 'React') continue;
    const value = key === 'IS_REACT_ACT_ENVIRONMENT' ? true : key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key];
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const React = await import('react');
  // The components compile to the classic JSX runtime under the test runner.
  Object.defineProperty(globalThis, 'React', { value: React, configurable: true, writable: true });
  const { createRoot } = await import('react-dom/client');
  const { DrawerPanel } = await import('../components/chat/chat-rails');
  const { IslandGlassScopeProvider } = await import('../components/glass-scope');
  const { applyGlassAttributes } = await import('../plugins-client/ui-theme-variants');
  const root = createRoot(document.getElementById('root')!);
  t.after(async () => {
    await React.act(async () => { root.unmount(); });
    dom.window.close();
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(globalThis, k, d);
      else delete globals[k];
    }
  });

  const render = (scope: 'island' | 'widgets' | null) => React.act(async () => {
    const drawer = React.createElement(DrawerPanel, {
      id: 'drawer', side: 'right', label: 'Widgets', open: true, onClose: () => {}, width: 320,
      children: React.createElement('p', null, 'card'),
    });
    root.render(React.createElement(IslandGlassScopeProvider, { value: scope }, drawer));
  });
  const drawer = () => document.getElementById('drawer')!;
  const frost = () => drawer().querySelector(':scope > .timon-glass-clear');

  await render(null);
  assert.ok(drawer().classList.contains('timon-island'));
  assert.equal(Array.from(drawer().classList).filter((c) => /(^|:)bg-/.test(c)).length, 0, 'no fill that would beat the glass');
  assert.equal(frost(), null, 'glass off: nothing laid, the island\'s own colour shows');

  await React.act(async () => { applyGlassAttributes({ glass: true, glassBubbles: false, glassScope: 'island' }); });
  await render(null);
  assert.ok(frost(), 'island scope: its own frosted plate');
  assert.equal(drawer().firstElementChild, frost(), 'under the cards');

  await render('widgets');
  assert.ok(frost(), 'widgets scope: the copy stays, sharp, so the thread never shows through');

  await React.act(async () => { applyGlassAttributes({ glass: false, glassBubbles: false }); });
  await render(null);
  assert.equal(frost(), null);
});
