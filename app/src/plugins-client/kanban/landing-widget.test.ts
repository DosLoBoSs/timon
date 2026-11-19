import assert from 'node:assert/strict';
import test from 'node:test';
import type { Landing, LandingPreview } from './landing-api';

/**
 * The "Pull requests" widget: one card per job with its state and checks,
 * the checks asked again while one runs, and the preview dialog with the diff,
 * the commits and the dry pre-checks.
 */

const branchJob: Landing = {
  id: 'job-branch', project: 'acme', series_id: 's1', branch: 'feat/add-export', remote: 'origin', target: 'main',
  mode: 'pr', state: 'branch', pr_number: null, pr_url: null, head_sha: null, merge_sha: null, landed: false,
  created_at: 2, updated_at: 2, checks: null, conflict: null, checks_running: false, pr_title: null,
};

const openJob: Landing = {
  ...branchJob,
  id: 'job-open', branch: 'feat/csv', state: 'open', pr_number: 12, pr_url: 'https://github.com/acme/app/pull/12',
  pr_title: 'Add CSV export', conflict: true, checks_running: true,
  checks: {
    read_at: 1, draft: false, mergeable: 'conflicting', review: 'review_required',
    counts: { pass: 2, fail: 1, pending: 1, skipped: 0 },
    items: [],
  },
};

const settled: Landing = {
  ...openJob,
  checks_running: false,
  checks: { ...openJob.checks!, counts: { pass: 3, fail: 1, pending: 0, skipped: 0 } },
};

const preview: LandingPreview = {
  integration: branchJob, head_sha: 'b'.repeat(40), target_sha: 'a'.repeat(40), problem: null,
  commit_count: 1,
  commits: [{ sha: 'c'.repeat(40), short: 'ccccccc', author: 'Acme Bot', subject: 'feat(app): add export' }],
  commits_truncated: false,
  files: [{
    path: 'src/export.ts', additions: 1, deletions: 1, binary: false, patch_truncated: false,
    patch: 'diff --git a/src/export.ts b/src/export.ts\nindex 1..2 100644\n--- a/src/export.ts\n+++ b/src/export.ts\n@@ -1 +1 @@\n-old line\n+new line',
  }],
  files_truncated: false, patch_truncated: false,
  totals: { files: 1, additions: 1, deletions: 1 },
  conflict: { state: 'clean', files: [] },
  pull_request: null,
  prechecks: {
    ran: true, ready: false,
    checks: [
      { name: 'account', ok: true, detail: 'gh signs in as ai-bot' },
      { name: 'commit_messages', ok: false, detail: 'messages carry internal references' },
      { name: 'public_tree', ok: true, skipped: true, detail: 'checked only when the pull request is opened' },
    ],
  },
};

type Ctx = { React: typeof import('react'); calls: string[] };

async function show(run: (ctx: Ctx) => Promise<void>) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of [
    'window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement',
    'Element', 'Node', 'NodeFilter', 'DocumentFragment', 'MutationObserver',
    'CustomEvent', 'Event', 'KeyboardEvent', 'PointerEvent', 'MouseEvent', 'FocusEvent', 'getComputedStyle',
    'requestAnimationFrame', 'cancelAnimationFrame',
  ] as const) install(key, key === 'self' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const calls: string[] = [];
  install('fetch', async (input: string, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.endsWith('/job-open/checks')) return Response.json({ landing: settled, fresh: true });
    if (url.endsWith('/job-branch/preview')) return Response.json(preview);
    if (url.startsWith('/api/ui/kanban/landings')) return Response.json({ landings: [branchJob, openJob] });
    return Response.json({});
  });
  const { createRoot } = await import('react-dom/client');
  const { LandingWidget } = await import('./landing-widget');
  const root = createRoot(document.getElementById('root')!);
  try {
    await React.act(async () => {
      root.render(React.createElement(LandingWidget, { handle: null }));
    });
    // Let the list and the first checks answer.
    await React.act(async () => { await new Promise<void>((r) => setTimeout(r, 30)); });
    await run({ React, calls });
  } finally {
    await React.act(async () => { root.unmount(); });
    await new Promise<void>((r) => setTimeout(r, 20));
    const globals = globalThis as Record<string, unknown>;
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globals[key];
    }
    dom.window.close();
  }
}

function card(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-landing="${id}"]`);
  assert.ok(el, `card ${id} is rendered`);
  return el;
}

test('one card per job, with its state, conflict and checks', async () => {
  await show(async ({ calls }) => {
    const branch = card('job-branch');
    assert.match(branch.textContent!, /feat\/add-export/);
    assert.match(branch.textContent!, /Not pushed/);
    assert.match(branch.textContent!, /into origin\/main/);

    const open = card('job-open');
    assert.match(open.textContent!, /PR #12/);
    assert.match(open.textContent!, /Add CSV export/);
    assert.match(open.textContent!, /Conflict/);
    assert.match(open.textContent!, /Review required/);
    const link = open.querySelector<HTMLAnchorElement>('a[href="https://github.com/acme/app/pull/12"]');
    assert.ok(link, 'the pull request is one click away');

    // The check that was running is asked again at once; the branch never is.
    assert.ok(calls.includes('POST /api/ui/kanban/landings/job-open/checks'));
    assert.ok(!calls.some((c) => c.includes('job-branch/checks')));
    // Settled: 3 passed, 1 failed, none running.
    assert.ok(open.querySelector('[title="3 checks passed"]'));
    assert.ok(open.querySelector('[title="1 check failed"]'));
    assert.ok(!open.querySelector('[title$="running"]'));
  });
});

test('the preview shows the diff, the commits and the dry pre-checks', async () => {
  await show(async ({ React, calls }) => {
    const button = Array.from(card('job-branch').querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === 'Preview');
    assert.ok(button);
    await React.act(async () => { button.click(); });
    await React.act(async () => { await new Promise<void>((r) => setTimeout(r, 30)); });
    assert.ok(calls.includes('POST /api/ui/kanban/landings/job-branch/preview'));

    const body = document.body.textContent!;
    assert.match(body, /1 commit, 1 file/);
    assert.match(body, /Merges cleanly into origin\/main/);
    assert.match(body, /1 check refuses/);
    // A short diff opens whole, its lines painted by kind.
    assert.equal(document.querySelector('[data-kind="add"]')?.textContent, '+new line');
    assert.equal(document.querySelector('[data-kind="del"]')?.textContent, '-old line');
    assert.equal(document.querySelector('[data-kind="hunk"]')?.textContent, '@@ -1 +1 @@');
  });
});

test('diff lines, patch bodies and the jobs to refresh', async () => {
  const { diffLineKind, patchBody, landingsToRefresh } = await import('./landing-api');
  assert.equal(diffLineKind('+++ b/x'), 'meta');
  assert.equal(diffLineKind('+x'), 'add');
  assert.equal(diffLineKind('-x'), 'del');
  assert.equal(diffLineKind('@@ -1 +1 @@'), 'hunk');
  assert.equal(diffLineKind(' x'), 'context');
  assert.deepEqual(patchBody('diff --git a/x b/x\nindex 1..2\n@@ -1 +1 @@\n-a\n+b'), ['@@ -1 +1 @@', '-a', '+b']);
  assert.deepEqual(landingsToRefresh([branchJob, openJob, settled, { ...settled, id: 'unread', checks: null }]).map((l) => l.id), ['job-open', 'unread']);
});
