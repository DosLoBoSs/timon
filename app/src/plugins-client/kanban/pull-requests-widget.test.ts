/**
 * The "Open pull requests" widget: the list of one project, the author filter,
 * the verdict on the row, and the prepared brief shown beside the diff, which
 * the person copies: the widget starts no relecture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  anyReviewRunning, filterByAuthor, pullAuthors, reviewBadge, type PullRequestItem,
} from './pull-requests-model';

function pull(extra: Partial<PullRequestItem> = {}): PullRequestItem {
  return {
    number: 12, title: 'Add a dark theme', author: 'stranger', url: 'https://github.com/acme/widgets/pull/12',
    isDraft: false, updatedAt: '2026-11-17T10:00:00Z', headOwner: 'stranger', external: true, review: null, ...extra,
  };
}

const review = (extra: Partial<NonNullable<PullRequestItem['review']>> = {}): NonNullable<PullRequestItem['review']> => ({
  id: 'r1', number: 12, state: 'done', agent: 'acme.reviewer', verdict: 'mergeable', report: 'VERDICT: MERGEABLE',
  mission_id: 'm1', pr_updated_at: '2026-11-17T10:00:00Z', updated_at: 1, ...extra,
});

test('the author filter lists each author once and keeps their pull requests', () => {
  const list = [pull(), pull({ number: 13, author: 'ai-bot' }), pull({ number: 14 }), pull({ number: 15, author: null })];
  assert.deepEqual(pullAuthors(list), ['ai-bot', 'stranger']);
  assert.deepEqual(filterByAuthor(list, 'stranger').map((p) => p.number), [12, 14]);
  assert.equal(filterByAuthor(list, null).length, 4);
});

test('a row shows the verdict, outdated once the pull request changed; a draft shows nothing', () => {
  assert.equal(reviewBadge(pull()), null);
  assert.equal(reviewBadge(pull({ review: review({ state: 'draft' }) })), null);
  assert.deepEqual(reviewBadge(pull({ review: review({ state: 'running', verdict: null }) })), { kind: 'running' });
  assert.deepEqual(reviewBadge(pull({ review: review() })), { kind: 'verdict', verdict: 'mergeable', outdated: false });
  assert.deepEqual(reviewBadge(pull({ updatedAt: '2026-11-18T08:00:00Z', review: review() })),
    { kind: 'verdict', verdict: 'mergeable', outdated: true });
  assert.ok(anyReviewRunning([pull(), pull({ review: review({ state: 'running' }) })]));
});

type Call = { url: string; method: string; body: string | null };

async function mount(list: PullRequestItem[]) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('window', dom.window);
  install('self', dom.window);
  for (const key of ['document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLSelectElement', 'Element', 'Node',
    'DocumentFragment', 'MutationObserver', 'NodeFilter', 'HTMLInputElement', 'SVGElement', 'Event', 'CustomEvent',
    'FocusEvent', 'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'getComputedStyle', 'localStorage']) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const copied: string[] = [];
  Object.defineProperty(dom.window.navigator, 'clipboard', {
    value: { writeText: async (text: string) => { copied.push(text); } }, configurable: true,
  });

  const calls: Call[] = [];
  install('fetch', async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? 'GET', body: typeof init.body === 'string' ? init.body : null });
    if (url === '/api/ui/projects') return Response.json({ projects: [{ slug: 'acme', name: 'Acme' }] });
    if (url === '/api/ui/projects/acme/pull-requests') return Response.json({ repo: 'acme/widgets', pulls: list });
    if (url.endsWith('/review')) {
      return Response.json({
        review: { id: '7d1c2a43-9b1e-4f3c-8a52-1f0e2d3c4b5a', agent: 'acme.reviewer', state: 'draft' },
        brief: 'Review pull request #12 of acme/widgets…\n<untrusted-data>\n{}\n</untrusted-data>',
      });
    }
    if (url.endsWith('/diff')) return Response.json({ diff: 'diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new', truncated: false });
    return Response.json({ error: 'not_found' }, { status: 404 });
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale, getLocale } = await import('@/lib/i18n');
  const previousLocale = getLocale();
  setLocale('en');
  const { PullRequestsWidget } = await import('./pull-requests-widget');
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => {
    root.render(React.createElement(PullRequestsWidget, { handle: null }));
  });
  const settle = async () => {
    for (let i = 0; i < 5; i += 1) await React.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  };
  await settle();
  const choose = async (select: HTMLSelectElement | null, value: string) => {
    assert.ok(select);
    await React.act(async () => {
      select.value = value;
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    await settle();
  };
  const click = async (el: Element | null) => {
    assert.ok(el);
    await React.act(async () => { (el as HTMLElement).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await settle();
  };
  // Radix tabs switch on a mouse down, not on a click.
  const pressTab = async (el: Element | null) => {
    assert.ok(el);
    await React.act(async () => {
      (el as HTMLElement).dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0 }));
    });
    await settle();
  };
  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    setLocale(previousLocale);
    dom.window.close();
    for (const [k, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  };
  return { calls, copied, choose, click, pressTab, settle, unmount };
}

test('the widget lists a project\'s pull requests, filters by author, and shows the brief and the diff without starting anything', async () => {
  const m = await mount([
    pull({ review: review({ verdict: 'changes_requested' }) }),
    pull({ number: 13, title: 'Tidy the docs', author: 'ai-bot', external: false, isDraft: true }),
  ]);
  try {
    assert.match(document.body.textContent ?? '', /Choose a project/);
    await m.choose(document.querySelector('[data-pull-project]'), 'acme');

    const rows = () => Array.from(document.querySelectorAll('[data-pull-row]')).map((r) => r.getAttribute('data-pull-row'));
    assert.deepEqual(rows(), ['12', '13']);
    const first = document.querySelector('[data-pull-row="12"]')!;
    assert.match(first.textContent ?? '', /Add a dark theme/);
    assert.equal(first.querySelector('[data-pull-verdict]')?.textContent, 'Changes requested');
    assert.match(document.querySelector('[data-pull-row="13"]')?.textContent ?? '', /draft/);

    await m.choose(document.querySelector('[data-pull-author-filter]'), 'ai-bot');
    assert.deepEqual(rows(), ['13']);
    await m.choose(document.querySelector('[data-pull-author-filter]'), '');
    assert.deepEqual(rows(), ['12', '13']);

    const button = document.querySelector('[data-pull-row="12"] [data-pull-review]');
    assert.equal(button?.getAttribute('aria-label'), 'Prepare the review');
    await m.click(button);
    assert.ok(m.calls.some((c) => c.method === 'POST' && c.url === '/api/ui/projects/acme/pull-requests/12/review'));
    assert.ok(m.calls.some((c) => c.method === 'GET' && c.url === '/api/ui/projects/acme/pull-requests/12/diff'));
    assert.match(document.querySelector('[data-pull-brief]')?.textContent ?? '', /untrusted-data/);
    assert.ok(!document.querySelector('[data-pull-send]'), 'no send button');
    assert.ok(!Array.from(document.querySelectorAll('button')).some((b) => /^Send/.test(b.textContent ?? '')));

    await m.click(document.querySelector('[data-pull-copy]'));
    assert.deepEqual(m.copied, ['Review pull request #12 of acme/widgets…\n<untrusted-data>\n{}\n</untrusted-data>']);

    await m.pressTab(document.querySelector('[data-pull-diff-tab]'));
    const diff = document.querySelector('[data-pull-diff]');
    assert.ok(diff, 'the diff tab shows the diff');
    assert.match(diff.textContent ?? '', /\+new/);

    // Only reads and the preparation: nothing that could start a mission.
    assert.deepEqual(
      m.calls.filter((c) => c.method !== 'GET').map((c) => c.url),
      ['/api/ui/projects/acme/pull-requests/12/review'],
    );

    await m.click(Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Close') ?? null);
    assert.ok(!document.querySelector('[data-pull-brief]'), 'the dialog closes');
  } finally {
    await m.unmount();
  }
});
