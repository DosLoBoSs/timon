/**
 * The project of an imported agent (plugins/agent-import), mounted from the
 * shipped `lib/client.js` the way the platform loads it: picked in a list when
 * the preview names the projects of this Timon, typed when it names none, and
 * a source project this Timon lacks shown as such instead of "no project".
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { after } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { ComponentType } from 'react';

type Manifest = { timon: { id: string; client: { slots: string[] } } };
type Call = { url: string; method: string; body: unknown };
type Reply = { status: number; body: unknown };

const repo = resolve(process.cwd(), '..');
const pluginDir = join(repo, 'plugins', 'agent-import');
const manifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')) as Manifest;
const tmp = mkdtempSync(join(tmpdir(), 'agent-import-project-picker-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const install = (key: string, value: unknown) => {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
};

type Platform = {
  React: typeof import('react');
  createRoot: typeof import('react-dom/client').createRoot;
  register: typeof import('./plugin-host/slots').register;
  resetSlotsForTests: typeof import('./plugin-host/slots').resetSlotsForTests;
  slotEntries: typeof import('./plugin-host/slots').slotEntries;
  clientContext: typeof import('./plugin-host/loader').clientContext;
  UI_LAYOUT_CHILD_SLOTS: typeof import('./plugin-host/ui-layout').UI_LAYOUT_CHILD_SLOTS;
  client: { apply(ctx: unknown): () => void };
};

let loading: Promise<Platform> | null = null;

/** A DOM, the platform's modules, then the browser half with its `react` and `@timon/ui` imports bound to them. */
function platform(): Promise<Platform> {
  loading ??= (async () => {
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
    for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'DocumentFragment', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle',
      // What the kit's Select (Radix) reaches for once open.
      'CustomEvent', 'FocusEvent', 'MutationObserver', 'HTMLSelectElement', 'requestAnimationFrame', 'cancelAnimationFrame'] as const) {
      install(key, (dom.window as unknown as Record<string, unknown>)[key]);
    }
    const proto = dom.window.HTMLElement.prototype as unknown as Record<string, unknown>;
    proto.scrollIntoView ??= () => undefined;
    proto.hasPointerCapture ??= () => false;
    proto.releasePointerCapture ??= () => undefined;
    install('IS_REACT_ACT_ENVIRONMENT', true);
    const React = await import('react');
    // The kit's components are compiled with the classic JSX runtime.
    install('React', React);
    const { createRoot } = await import('react-dom/client');
    const { UI_KIT } = await import('./plugin-host/ui-kit');
    const { Slot } = await import('./plugin-host/render');
    const { register, resetSlotsForTests, slotEntries } = await import('./plugin-host/slots');
    const { clientContext } = await import('./plugin-host/loader');
    const { UI_LAYOUT_CHILD_SLOTS } = await import('./plugin-host/ui-layout');

    const source = readFileSync(join(pluginDir, 'lib', 'client.js'), 'utf8');
    const bound = source
      .replace(/^import (\w+) from "react";$/gm, 'const $1 = globalThis.__projectPickerReact;')
      .replace(/^import \* as (\w+) from "@timon\/ui";$/gm, 'const $1 = globalThis.__projectPickerUi;');
    assert.doesNotMatch(bound, /^import /m, 'every import of the bundle is the platform\'s');
    install('__projectPickerReact', React);
    install('__projectPickerUi', { ...UI_KIT, Slot });
    const file = join(tmp, 'client.mjs');
    writeFileSync(file, bound);
    const client = await import(pathToFileURL(file).href) as { apply(ctx: unknown): () => void };
    return { React, createRoot, register, resetSlotsForTests, slotEntries, clientContext, UI_LAYOUT_CHILD_SLOTS, client };
  })();
  return loading;
}

const STAGED = { token: 'T'.repeat(43), sha256: 'a'.repeat(64), size: 321, expiresAt: Date.now() + 3_600_000 };
const PROJECTS = [{ slug: 'alpha-proj', name: 'Alpha' }, { slug: 'zeta-proj', name: 'Zeta' }];

function previewWith(projects: unknown, project: string | null = null): Reply {
  return {
    status: 200,
    body: {
      archive: { sha256: STAGED.sha256, size: STAGED.size, expiresAt: STAGED.expiresAt },
      ready: true,
      preview: {
        source: { app: 'hermes', exportedAt: null },
        warnings: [],
        agents: [{ sourceRef: 'hermes:default', displayName: 'Hermes', finalName: 'hermes.default', action: 'create', role: 'research', project, warnings: [] }],
        ...(projects === undefined ? {} : { projects }),
      },
    },
  };
}

/** Mounts the import's settings section against a fake daemon and opens the preview through the Hermes card. */
async function openPreview(preview: Reply) {
  const { React, createRoot, register, resetSlotsForTests, slotEntries, clientContext, UI_LAYOUT_CHILD_SLOTS, client } = await platform();
  const calls: Call[] = [];
  const replies: Record<string, Reply> = {
    hermes: { status: 200, body: { found: true, label: '~/.hermes', profiles: [{ name: 'default', displayName: 'Hermes' }] } },
    'hermes/stage': { status: 201, body: STAGED },
    preview,
  };
  install('fetch', async (input: string, init?: RequestInit) => {
    const route = String(input).replace(/^\/api\/ui\/plugins\/agent-import\//, '');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : init?.body;
    calls.push({ url: route, method: init?.method ?? 'GET', body });
    const reply = replies[route] ?? { status: 404, body: { error: 'no route', code: 'not_found' } };
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
  });
  resetSlotsForTests();
  register({ slot: 'root', pluginId: '@timon/ui-layout', children: UI_LAYOUT_CHILD_SLOTS }, () => null);
  const dispose = client.apply(clientContext(manifest.timon.id, manifest.timon.client.slots));
  const section = slotEntries('settings.section').find((e) => e.pluginId === manifest.timon.id);
  assert.ok(section, 'the import paints its settings section');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const settle = () => React.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  await React.act(async () => { root.render(React.createElement(section.Component as ComponentType)); });
  await settle();
  const button = Array.from(container.querySelectorAll('button'))
    .find((b) => /Hermes/.test(b.textContent ?? '') && b.closest('[data-source="hermes"]'));
  assert.ok(button, 'the Hermes card offers its import');
  await React.act(async () => { button.click(); });
  await settle();
  assert.match(container.textContent ?? '', /hermes\.default/, 'the preview is open');
  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    container.remove();
    dispose();
    resetSlotsForTests();
  };
  return { calls, container, unmount, act: React.act, settle };
}

const projectField = (container: Element) => {
  const label = Array.from(container.querySelectorAll('label')).find((l) => l.textContent === 'Project');
  assert.ok(label, 'the card has a project field');
  const field = container.querySelector(`[id="${label.getAttribute('for')}"]`);
  assert.ok(field, 'the label names its field');
  return field;
};

test('the projects of this Timon are picked in a list, and the choice goes back to the engine', async () => {
  const m = await openPreview(previewWith(PROJECTS));
  try {
    const field = projectField(m.container);
    assert.equal(field.getAttribute('role'), 'combobox', 'a list, not a text box');
    assert.match(field.textContent ?? '', /No project/);

    // Opened from the keyboard, the way Radix lets a test reach its options without a pointer.
    (field as HTMLElement).focus();
    await m.act(async () => {
      field.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    const options = Array.from(document.querySelectorAll('[role="option"]'));
    assert.deepEqual(options.map((o) => o.textContent), ['No project (bot)', 'Alpha', 'Zeta']);

    await m.act(async () => { (options[2] as HTMLElement).click(); });
    await m.settle();
    assert.match(projectField(m.container).textContent ?? '', /Zeta/);
    // The refreshed preview carries the user's choice: the slug, never the label.
    const update = Array.from(m.container.querySelectorAll('button')).find((b) => b.textContent === 'Update the preview');
    assert.ok(update, 'a change asks for a fresh preview');
    await m.act(async () => { update.click(); });
    await m.settle();
    const refresh = m.calls.filter((c) => c.url === 'preview').at(-1);
    const agents = (refresh?.body as { options?: { agents?: Array<{ project?: unknown }> } }).options?.agents;
    assert.equal(agents?.[0]?.project, 'zeta-proj');
  } finally {
    await m.unmount();
  }
});

test('a project of the source this Timon lacks is shown as such, not as "no project"', async () => {
  const m = await openPreview(previewWith(PROJECTS, 'gone-proj'));
  try {
    const field = projectField(m.container);
    assert.equal(field.getAttribute('role'), 'combobox');
    assert.match(field.textContent ?? '', /gone-proj \(not on this Timon\)/);
  } finally {
    await m.unmount();
  }
});

test('a daemon that lists no project keeps the typed slug', async () => {
  for (const projects of [undefined, []]) {
    const m = await openPreview(previewWith(projects, 'web'));
    try {
      const field = projectField(m.container) as HTMLInputElement;
      assert.equal(field.tagName, 'INPUT', JSON.stringify(projects));
      assert.equal(field.value, 'web');
    } finally {
      await m.unmount();
    }
  }
});
