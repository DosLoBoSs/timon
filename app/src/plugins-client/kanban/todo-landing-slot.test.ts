/**
 * The landing badge of a TO DO idea (`kanban.todo.landing`): the product's
 * chip for each state, the link to an existing pull request, the detail of
 * several jobs, a plugin's badge in its place once it takes the slot, and the
 * landing filter of the TO DO widget.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ComponentType, ReactElement } from 'react';
import { waitUntil } from '../../lib/test-wait';
import { filterByLanding, showLandingFilter } from '../../lib/project-todo-filter';
import type { ProjectTodo, TodoLanding, TodoLandingJob } from './project-todo-types';

const job = (state: TodoLandingJob['state'], branch: string, prNumber: number | null = null): TodoLandingJob => ({
  state, branch, prNumber, prUrl: prNumber === null ? null : `https://github.com/acme/app/pull/${prNumber}`,
});
const landing = (worst: TodoLandingJob, ...others: TodoLandingJob[]): TodoLanding => ({ ...worst, jobs: [worst, ...others] });

function idea(id: number, l: TodoLanding | null): ProjectTodo {
  return {
    id, text: `idea ${id}`, project: 'timon', author: 'user', status: 'open', notes: null,
    created_at: 1, updated_at: 1, done_at: null, promoted_task_id: null, urgency: null, progress: null, landing: l,
  };
}

async function mount(items: ProjectTodo[] = []) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement',
    'HTMLTextAreaElement', 'SVGElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'Event',
    'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent', 'DocumentFragment'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const urls: string[] = [];
  install('fetch', async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (url.startsWith('/api/ui/project-todo')) {
      const wanted = new URL(url, 'http://localhost').searchParams.get('landing');
      const rows = wanted ? items.filter((i) => i.landing?.state === wanted) : items;
      return Response.json({ items: rows, counts: { byStatus: { open: rows.length, done: 0, promoted: 0 }, byUrgency: {
        open: { critical: 0, bug: 0, minor: 0, idea: 0, none: rows.length },
        done: { critical: 0, bug: 0, minor: 0, idea: 0, none: 0 },
        promoted: { critical: 0, bug: 0, minor: 0, idea: 0, none: 0 },
      } } });
    }
    if (url.startsWith('/api/ui/layout')) return Response.json({ layout: null });
    return Response.json({});
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale, getLocale } = await import('@/lib/i18n');
  const previousLocale = getLocale();
  setLocale('en');
  const slots = await import('@/lib/plugin-host/slots');
  slots.resetSlotsForTests();
  const root = createRoot(document.getElementById('root')!);
  const render = async (element: ReactElement) => { await React.act(async () => { root.render(element); }); };
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const click = async (el: Element | null | undefined) => {
    assert.ok(el, 'element to click');
    await React.act(async () => { (el as HTMLElement).click(); });
  };
  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    await React.act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    slots.resetSlotsForTests();
    setLocale(previousLocale);
    dom.window.close();
    for (const [k, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  };
  return { React, slots, urls, render, until, click, unmount };
}

const IDEAS = [
  idea(1, null),
  idea(2, landing(job('branch', 'sec/fix-auth'))),
  idea(3, landing(job('pending', 'feat/pending'))),
  idea(4, landing(job('open', 'feat/open', 12))),
  idea(5, landing(job('merged', 'feat/merged', 13))),
  idea(6, landing(job('closed', 'feat/closed', 14))),
  idea(7, landing(job('pending', 'feat/second'), job('open', 'feat/first', 21))),
];

test('the product badge says each state, and links an existing pull request', async () => {
  const m = await mount();
  try {
    const { TodoLandingSlot } = await import('./todo-landing-slot');
    await m.render(m.React.createElement('div', null, IDEAS.map((it) =>
      m.React.createElement('div', { key: it.id, 'data-idea': it.id }, m.React.createElement(TodoLandingSlot, { item: it })))));
    const badge = (id: number) => document.querySelector(`[data-idea="${id}"] [data-todo-landing]`);
    assert.equal(badge(1), null, 'no job: no badge');
    assert.equal(badge(2)?.textContent, 'Branch');
    assert.equal(badge(3)?.textContent, 'PR not created');
    assert.equal(badge(3)?.tagName, 'SPAN', 'nothing to open before the pull request exists');
    assert.equal(badge(4)?.textContent, 'PR #12');
    assert.equal(badge(4)?.getAttribute('href'), 'https://github.com/acme/app/pull/12');
    assert.equal(badge(4)?.getAttribute('target'), '_blank');
    assert.equal(badge(4)?.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(badge(5)?.textContent, 'PR #13 merged');
    assert.equal(badge(6)?.textContent, 'PR #14 closed');
    assert.equal(badge(6)?.getAttribute('data-todo-landing'), 'closed');
  } finally {
    await m.unmount();
  }
});

test('several jobs: the worst one shows, every one is named', async () => {
  const m = await mount();
  try {
    const { TodoLandingSlot } = await import('./todo-landing-slot');
    await m.render(m.React.createElement(TodoLandingSlot, { item: IDEAS[6]! }));
    const chip = document.querySelector('[data-todo-landing]');
    assert.equal(chip?.getAttribute('data-todo-landing'), 'pending');
    assert.match(chip?.textContent ?? '', /^PR not created\+1$/);
    const label = chip?.getAttribute('aria-label') ?? '';
    assert.match(label, /feat\/second: PR not created/);
    assert.match(label, /feat\/first: PR #21/);
  } finally {
    await m.unmount();
  }
});

test('a plugin that takes kanban.todo.landing paints in place of the product, from useTodoItem', async () => {
  const m = await mount();
  try {
    const { TodoLandingSlot } = await import('./todo-landing-slot');
    const { ProductTodoLanding } = await import('./product-todo-landing');
    const { useTodoItem } = await import('./todo-badge-slot');
    m.slots.register({ slot: 'kanban.todo.landing', fallback: true, pluginId: '@timon/kanban' }, ProductTodoLanding);
    const Acme: ComponentType = () => {
      const item = useTodoItem();
      return m.React.createElement('span', { 'data-acme-landing': item?.landing?.state ?? 'none' }, item?.landing?.prUrl ?? '');
    };
    await m.render(m.React.createElement('div', null,
      m.React.createElement('div', { 'data-idea': 4 }, m.React.createElement(TodoLandingSlot, { item: IDEAS[3]! })),
      m.React.createElement('div', { 'data-idea': 1 }, m.React.createElement(TodoLandingSlot, { item: IDEAS[0]! }))));
    assert.ok(document.querySelector('[data-idea="4"] [data-todo-landing="open"]'), 'the product badge under its fallback');

    let dispose: () => void = () => {};
    await m.React.act(async () => { dispose = m.slots.register({ slot: 'kanban.todo.landing', pluginId: 'acme-issues' }, Acme); });
    await m.until(() => !!document.querySelector('[data-acme-landing]'), 'the plugin\'s badge');
    assert.ok(!document.querySelector('[data-todo-landing]'), 'the product badge is not painted under it');
    assert.equal(document.querySelector('[data-idea="4"] [data-acme-landing]')?.getAttribute('data-acme-landing'), 'open');
    assert.equal(document.querySelector('[data-idea="4"] [data-acme-landing]')?.textContent, 'https://github.com/acme/app/pull/12');
    // A replacement may have something to say about an idea without a job.
    assert.equal(document.querySelector('[data-idea="1"] [data-acme-landing]')?.getAttribute('data-acme-landing'), 'none');

    await m.React.act(async () => { dispose(); });
    await m.until(() => !!document.querySelector('[data-idea="4"] [data-todo-landing="open"]'), 'the product badge back');
  } finally {
    await m.unmount();
  }
});

test('the TO DO widget filters on an open or a missing pull request', async () => {
  const m = await mount(IDEAS);
  try {
    const { ProjectTodoTile } = await import('./project-todo-tile');
    await m.render(m.React.createElement(ProjectTodoTile, {
      scope: { kind: 'project', slug: 'timon' }, titre: 'Project TO DO', handle: null, realtime: { subscribe: () => () => {} }, editing: false,
    } as never));
    await m.until(() => !!document.querySelector('[data-landing-filter="open"]'), 'the landing filter');
    assert.equal(document.querySelectorAll('[data-todo-landing]').length, 6, 'one badge per idea with a job');

    await m.click(document.querySelector('[data-landing-filter="open"]'));
    await m.until(() => m.urls.some((u) => u.includes('landing=open')), 'the filter reaches the daemon');
    await m.until(() => document.querySelectorAll('[data-todo-landing]').length === 1, 'only the open pull request');
    assert.equal(document.querySelector('[data-landing-filter="open"]')?.getAttribute('aria-pressed'), 'true');

    await m.click(document.querySelector('[data-landing-filter="pending"]'));
    await m.until(() => m.urls.some((u) => u.includes('landing=pending')), 'the other state');
    await m.until(() => document.querySelectorAll('[data-todo-landing="pending"]').length === 2, 'the two ideas without a pull request');

    await m.click(document.querySelector('[data-landing-filter="pending"]'));
    await m.until(() => document.querySelectorAll('[data-todo-landing]').length === 6, 'the filter off');
  } finally {
    await m.unmount();
  }
});

test('filter helpers: a single state, shown once an idea could match', () => {
  assert.deepEqual(filterByLanding(IDEAS, 'open').map((i) => i.id), [4]);
  assert.deepEqual(filterByLanding(IDEAS, 'pending').map((i) => i.id), [3, 7]);
  assert.equal(filterByLanding(IDEAS, null).length, IDEAS.length);
  assert.equal(showLandingFilter([IDEAS[0]!, IDEAS[4]!], null), false, 'nothing to filter on');
  assert.equal(showLandingFilter([IDEAS[0]!], 'open'), true, 'an active choice stays reachable');
  assert.equal(showLandingFilter([IDEAS[3]!], null), true);
});
