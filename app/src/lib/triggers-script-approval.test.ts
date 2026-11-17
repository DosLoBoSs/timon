/**
 * Triggers page (TODO #1051): a trigger whose script has no approval, or
 * changed since it, says so on its row, and its one main action approves the
 * files again through the session route.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { needsScriptApproval } from '../plugins-client/triggers/model';

test('only a script without approval, or changed since, asks for an action', () => {
  assert.equal(needsScriptApproval({ script_approval: 'unapproved' }), true);
  assert.equal(needsScriptApproval({ script_approval: 'changed' }), true);
  assert.equal(needsScriptApproval({ script_approval: 'approved' }), false);
  assert.equal(needsScriptApproval({ script_approval: null }), false);
  // An older daemon does not send the field: nothing is claimed.
  assert.equal(needsScriptApproval({}), false);
});

test('the row shows the state and re-approves the script', async (suite) => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/triggers?tab=routines', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'FocusEvent', 'MouseEvent', 'PointerEvent', 'CustomEvent', 'DocumentFragment', 'NodeFilter', 'HTMLInputElement', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    const value = (dom.window as unknown as Record<string, unknown>)[key];
    install(key, key === 'window' ? dom.window : typeof value === 'function' && /^[a-z]/.test(key) ? value.bind(dom.window) : value);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { TriggerList } = await import('../plugins-client/triggers/trigger-list');
  const { answerConfirmsForTests } = await import('../components/confirm-dialog/confirm-dialog-context');

  const script = { type: 'script', command: '/usr/bin/node', args: ['watch.js'], cwd: '/projects/growth' };
  const base = {
    slug: null, source: 'schedule', enabled: true, config: { cron: '*/5 * * * *' }, filter: null,
    created_by: 'user', creator_agent: null, has_secret: false, url: null, last_run_at: null, next_run_at: null, created_at: 1, updated_at: 1,
  };
  const triggers: Record<string, unknown>[] = [
    { ...base, id: 'tr-changed', name: 'Watcher', actions: [script], script_approval: 'changed' },
    { ...base, id: 'tr-new', name: 'Legacy job', actions: [script], script_approval: 'unapproved' },
    { ...base, id: 'tr-ok', name: 'Approved job', actions: [script], script_approval: 'approved' },
    { ...base, id: 'tr-plain', name: 'Reminder', actions: [{ type: 'notify', title: 'x' }], script_approval: null },
  ];
  const approvals: string[] = [];
  let answer = true;
  answerConfirmsForTests(() => answer);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === '/api/ui/agents') return Response.json({ agents: [] });
    if (url === '/api/ui/triggers?source=schedule') return Response.json({ triggers });
    const approve = /^\/api\/ui\/triggers\/([^/]+)\/approve-script$/.exec(url);
    if (approve && init?.method === 'POST') {
      approvals.push(approve[1]!);
      if (approve[1] === 'tr-new') return Response.json({ error: 'script watch.js: what it runs cannot be read' }, { status: 400 });
      const row = triggers.find((tr) => tr.id === approve[1])!;
      row.script_approval = 'approved';
      return Response.json({ trigger: row, approved: [] });
    }
    throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${url}`);
  };

  const root = createRoot(document.getElementById('root')!);
  const settle = async () => { await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  const rowOf = (name: string) => Array.from(document.querySelectorAll('article')).find((a) => a.textContent?.includes(name));
  const reapprove = (name: string) => Array.from(rowOf(name)?.querySelectorAll('button') ?? []).find((b) => b.textContent === 'Re-approve');
  const state = (name: string) => rowOf(name)?.querySelector('[data-testid="trigger-script-approval"]')?.textContent ?? null;
  const click = async (el: Element | undefined | null) => {
    assert.ok(el, 'element to click');
    await React.act(async () => { (el as HTMLElement).click(); });
    await settle();
  };

  try {
    await React.act(async () => root.render(React.createElement(TriggerList, { source: 'schedule', excludeRoutines: true })));
    await settle();

    await suite.test('the state and the action appear only where a person has to act', () => {
      assert.equal(state('Watcher'), 'Script changed since it was approved');
      assert.equal(state('Legacy job'), 'Script not approved');
      assert.equal(state('Approved job'), null);
      assert.equal(state('Reminder'), null);
      assert.ok(reapprove('Watcher'));
      assert.ok(reapprove('Legacy job'));
      assert.equal(reapprove('Approved job'), undefined);
      assert.equal(reapprove('Reminder'), undefined);
    });

    await suite.test('a cancelled confirmation sends nothing', async () => {
      answer = false;
      await click(reapprove('Watcher'));
      assert.deepEqual(approvals, []);
      answer = true;
    });

    await suite.test('Re-approve calls the route, then the row reads the new state', async () => {
      await click(reapprove('Watcher'));
      await settle();
      assert.deepEqual(approvals, ['tr-changed']);
      assert.equal(state('Watcher'), null);
      assert.equal(reapprove('Watcher'), undefined);
    });

    await suite.test('a refusal keeps the state and the action', async () => {
      await click(reapprove('Legacy job'));
      await settle();
      assert.deepEqual(approvals, ['tr-changed', 'tr-new']);
      assert.equal(state('Legacy job'), 'Script not approved');
      assert.ok(reapprove('Legacy job'));
    });
  } finally {
    answerConfirmsForTests(null);
    await React.act(async () => root.unmount());
    for (let tick = 0; tick < 2; tick += 1) await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    globalThis.fetch = originalFetch;
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    dom.window.close();
  }
});
