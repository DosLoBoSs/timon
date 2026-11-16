/**
 * A newer Timon as a bottom-left notice card (docs/AUTO-UPDATE.md §10): the
 * product's source of the `notices` slot pushes "Timon x.y.z is available"
 * only while the daemon offers it, with one main gesture that goes through
 * `openUpdateDialog()`; closing it is "later" for that version, per account;
 * the end of the build turns it into a warning, or is a card of its own; the
 * desktop flow (download, verify, install, missions first) runs inside it;
 * and the deprecated `updates.banner` slot still loads a plugin but paints
 * nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { waitUntil } from '../../lib/test-wait';
import type { UpdateStatus } from '../../lib/updates';

const NOW = Date.now();
const DAY = 86_400_000;
const OFFER_STATUS: UpdateStatus = {
  installed: '0.1.6', channel: 'beta', enabled: true, state: 'available', checkedAt: new Date(NOW).toISOString(),
  available: {
    version: '0.1.8-rc.1', publishedAt: new Date(NOW).toISOString(),
    notes: 'Faster boot.',
    notesUrl: 'https://docs.timon-ai.com/changelog',
    artifacts: [
      { key: 'linux-x64-deb', os: 'linux', arch: 'x64', format: 'deb', name: 'timon.deb', url: 'https://github.com/acme/r/releases/download/v0.1.8-rc.1/timon.deb', size: 1 },
      { key: 'linux-x64-appimage', os: 'linux', arch: 'x64', format: 'appimage', name: 'Timon.AppImage', url: 'https://github.com/acme/r/releases/download/v0.1.8-rc.1/Timon.AppImage', size: 1 },
      { key: 'win-x64-nsis', os: 'win', arch: 'x64', format: 'nsis', name: 'Timon.Setup.exe', url: 'https://github.com/acme/r/releases/download/v0.1.8-rc.1/Timon.Setup.exe', size: 1 },
    ],
  },
  host: { os: 'linux', arch: 'x64' },
  buildExpiresAt: new Date(NOW + 40 * DAY).toISOString(),
};
const CARD = '@timon/updates:update-0.1.8-rc.1';

/** The desktop shell's `window.timonDesktop.updates`, recorded. */
function fakeShell(initial: unknown = { phase: 'idle' }, { installs = [] as unknown[] } = {}) {
  const calls: unknown[][] = [];
  const installQueue = [...installs];
  let listener: ((state: unknown) => void) | null = null;
  let state = initial;
  const reply = (name: string) => (...args: unknown[]) => { calls.push([name, ...args]); return Promise.resolve(state); };
  return {
    calls,
    bridge: {
      state: reply('state'),
      start: reply('start'),
      cancel: reply('cancel'),
      open: (...args: unknown[]) => { calls.push(['open', ...args]); return Promise.resolve({ status: 'opened' }); },
      install: (...args: unknown[]) => { calls.push(['install', ...args]); return Promise.resolve(installQueue.shift() ?? { status: 'failed', message: null }); },
      onState: (fn: (state: unknown) => void) => { listener = fn; return () => { listener = null; }; },
    },
    push: (next: unknown) => { state = next; listener?.(next); },
  };
}

type MountOptions = {
  dismissed?: string[];
  shell?: ReturnType<typeof fakeShell> | null;
  buildExpiresAt?: string | null;
  withLicenseBanner?: boolean;
};

async function mount(status: UpdateStatus | null, { dismissed = [], shell = null, buildExpiresAt = OFFER_STATUS.buildExpiresAt, withLicenseBanner = false }: MountOptions = {}) {
  const { JSDOM } = await import('jsdom');
  // The desktop app on Linux; jsdom's typings omit `userAgent`, its constructor reads it.
  const options = { url: 'http://localhost/', pretendToBeVisual: true, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Timon/0.1.6' };
  const dom = new JSDOM('<html><body><div id="root"></div></body></html>', options as ConstructorParameters<typeof JSDOM>[1]);
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent',
    'MutationObserver', 'DocumentFragment', 'sessionStorage', 'localStorage'] as const) {
    const value = (dom.window as unknown as Record<string, unknown>)[key];
    if (value !== undefined) install(key, value);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('IS_REACT_ACT_ENVIRONMENT', true);
  if (shell) Object.assign(dom.window, { timonDesktop: { restartAfterSetup: async () => undefined, updates: shell.bridge } });
  const opened: string[] = [];
  dom.window.open = ((url: string) => { opened.push(url); return null; }) as typeof dom.window.open;
  const closed = new Set(dismissed);
  const posts: unknown[] = [];
  const requests: string[] = [];
  install('fetch', async (input: string, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    if (url === '/api/ui/updates') return status ? Response.json(status) : Response.json({ error: 'forbidden' }, { status: 403 });
    if (url === '/api/ui/license') {
      return Response.json({ status: 'valid', reason: null, lifetime: true, build: { channel: 'beta', expiresAt: buildExpiresAt } });
    }
    if (url === '/api/ui/prefs/dismissed-notices') {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { id: string };
        posts.push(body);
        closed.add(body.id);
      }
      return Response.json({ dismissed: [...closed] });
    }
    if (url === '/api/ui/capabilities') return Response.json({ beta: true, surfaces: { all: true } });
    return Response.json({}, { status: 404 });
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale, getLocale } = await import('@/lib/i18n');
  const previousLocale = getLocale();
  setLocale('en');
  const slots = await import('@/lib/plugin-host/slots');
  slots.resetSlotsForTests();
  const store = await import('@/lib/updates');
  store.resetUpdateStoreForTests();
  const notices = await import('@/lib/notices');
  notices.resetNoticesForTests();
  const dialog = await import('@/lib/update-open');
  dialog.resetUpdateDialogForTests();
  const { NoticesHost } = await import('@/components/notices/notices-host');
  const { UpdateNotice } = await import('./update-notice');
  const { LicenseBanner } = await import('@/components/license-banner');
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => {
    root.render(React.createElement(React.Fragment, null,
      React.createElement(NoticesHost),
      withLicenseBanner ? React.createElement(LicenseBanner) : null));
  });
  // As the client half of `@timon/updates` registers it.
  await React.act(async () => { slots.register({ slot: 'notices', key: 'update', pluginId: '@timon/updates' }, UpdateNotice); });
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const click = async (el: Element | null | undefined) => {
    assert.ok(el, 'element to click');
    await React.act(async () => { (el as HTMLElement).click(); });
  };
  const settle = async () => {
    await until(() => requests.includes('/api/ui/updates') && requests.includes('/api/ui/license'), 'the reads');
    await React.act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  };
  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    store.resetUpdateStoreForTests();
    notices.resetNoticesForTests();
    dialog.resetUpdateDialogForTests();
    slots.resetSlotsForTests();
    setLocale(previousLocale);
    dom.window.close();
    for (const [k, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  };
  return { React, slots, dialog, until, click, settle, unmount, requests, opened, posts };
}

const card = (key = CARD) => document.querySelector(`[data-notice="${key}"]`);
const text = (key = CARD) => card(key)?.textContent ?? '';
const action = (index: number, key = CARD) => card(key)?.querySelector(`[data-notice-action="${index}"]`) ?? null;
const labels = (key = CARD) => Array.from(card(key)?.querySelectorAll('[data-notice-action]') ?? [], (el) => el.textContent);

test('the deprecated updates.banner slot still loads a plugin, says so once, and paints nothing', async () => {
  const m = await mount(OFFER_STATUS);
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (message: string) => { warnings.push(String(message)); };
  try {
    assert.equal(m.slots.slotKind('updates.banner'), 'single');
    const Painted = () => m.React.createElement('div', { 'data-old-banner': '' });
    let dispose: () => void = () => {};
    await m.React.act(async () => { dispose = m.slots.register({ slot: 'updates.banner', pluginId: 'acme-banner' }, Painted); });
    await m.React.act(async () => { dispose(); dispose = m.slots.register({ slot: 'updates.banner', pluginId: 'acme-banner' }, Painted); });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /`acme-banner`: the `updates\.banner` slot is deprecated and no longer painted/);
    await m.until(() => card() !== null, 'the update card');
    assert.ok(!document.querySelector('[data-old-banner]'), 'nothing paints the old slot');
    await m.React.act(async () => { dispose(); });
  } finally {
    console.warn = warn;
    await m.unmount();
  }
});

test('no offer, or no right to read it: no update card', async () => {
  for (const status of [null, { ...OFFER_STATUS, state: 'up_to_date' as const, available: null }, { ...OFFER_STATUS, state: 'off' as const }]) {
    const m = await mount(status);
    try {
      await m.settle();
      assert.ok(!card(), JSON.stringify(status?.state ?? 'forbidden'));
      assert.equal(document.querySelectorAll('[data-notice]').length, 0);
    } finally {
      await m.unmount();
    }
  }
});

test('in a browser the card says the version, its one action opens the installer of this system', async () => {
  const m = await mount(OFFER_STATUS);
  try {
    await m.until(() => card() !== null, 'the update card');
    assert.equal(card()?.querySelector('[data-notice-card]')?.getAttribute('data-notice-card'), 'info');
    assert.match(text(), /^Timon 0\.1\.8-rc\.1 is available/);
    assert.deepEqual(labels(), ['Update']);
    await m.click(action(0));
    assert.deepEqual(m.opened, [OFFER_STATUS.available!.artifacts[1]!.url], 'the AppImage, through openUpdateDialog()');
    assert.ok(card(), 'the action leaves the card');
  } finally {
    await m.unmount();
  }
});

test('closing is later for that version, per account: the same version stays closed, a newer one comes back', async () => {
  const m = await mount(OFFER_STATUS);
  try {
    await m.until(() => card() !== null, 'the update card');
    await m.click(card()?.querySelector('[data-notice-dismiss]'));
    await m.until(() => card() === null, 'closed');
    assert.deepEqual(m.posts, [{ id: CARD }]);
  } finally {
    await m.unmount();
  }
  const same = await mount(OFFER_STATUS, { dismissed: [CARD] });
  try {
    await same.settle();
    assert.ok(!card());
  } finally {
    await same.unmount();
  }
  const newer = await mount({ ...OFFER_STATUS, available: { ...OFFER_STATUS.available!, version: '0.1.8-rc.2' } }, { dismissed: [CARD] });
  try {
    await newer.until(() => card('@timon/updates:update-0.1.8-rc.2') !== null, 'the newer version announced');
  } finally {
    await newer.unmount();
  }
});

test('a build about to stop makes the card a warning that says when; alone, it is a card of its own; the top banner no longer says it', async () => {
  const ending = new Date(NOW + 5 * DAY).toISOString();
  const m = await mount(OFFER_STATUS, { buildExpiresAt: ending, withLicenseBanner: true });
  try {
    await m.until(() => /This build stops running on/.test(text()), 'the end in the update card');
    assert.equal(card()?.querySelector('[data-notice-card]')?.getAttribute('data-notice-card'), 'warning');
    assert.equal(document.querySelectorAll('[data-notice]').length, 1, 'one card, not two');
    assert.doesNotMatch(document.body.textContent ?? '', /beta build stops running/, 'no top banner for the build');
  } finally {
    await m.unmount();
  }
  const day = ending.slice(0, 10);
  const alone = await mount({ ...OFFER_STATUS, state: 'up_to_date', available: null }, { buildExpiresAt: ending });
  try {
    await alone.until(() => card(`@timon/updates:build-ends-${day}`) !== null, 'the end of the build alone');
    assert.match(text(`@timon/updates:build-ends-${day}`), /This build stops running on/);
    assert.deepEqual(labels(`@timon/updates:build-ends-${day}`), []);
  } finally {
    await alone.unmount();
  }
  // Closed while it was weeks away, it comes back once the end is urgent.
  const soon = new Date(NOW + 2 * DAY).toISOString();
  const urgent = await mount({ ...OFFER_STATUS, state: 'up_to_date', available: null }, { buildExpiresAt: soon, dismissed: [`@timon/updates:build-ends-${soon.slice(0, 10)}`] });
  try {
    await urgent.until(() => card(`@timon/updates:build-ends-${soon.slice(0, 10)}-urgent`) !== null, 'the urgent stage');
  } finally {
    await urgent.unmount();
  }
  // The offer put off while the end was weeks away comes back, as a warning, once the end is urgent.
  const putOff = await mount(OFFER_STATUS, { buildExpiresAt: ending, dismissed: [CARD] });
  try {
    await putOff.settle();
    assert.ok(!card(), 'the offer stays put off while the end is not urgent');
  } finally {
    await putOff.unmount();
  }
  const back = await mount(OFFER_STATUS, { buildExpiresAt: soon, dismissed: [CARD] });
  try {
    await back.until(() => card(`${CARD}-urgent`) !== null, 'the offer back at the urgent stage');
    assert.equal(card(`${CARD}-urgent`)?.querySelector('[data-notice-card]')?.getAttribute('data-notice-card'), 'warning');
    const { formatDate } = await import('@/lib/intl');
    const date = formatDate(soon, { year: 'numeric', month: 'numeric', day: 'numeric' });
    assert.ok(text(`${CARD}-urgent`).includes(`This build stops running on ${date}.`), 'the date said');
    assert.deepEqual(labels(`${CARD}-urgent`), ['Update']);
  } finally {
    await back.unmount();
  }
});

test('in the desktop app Update starts the shell\'s download: progress, cancel, refusal, then Install', async () => {
  const shell = fakeShell();
  const m = await mount(OFFER_STATUS, { shell });
  try {
    await m.until(() => labels().join() === 'Update', 'the card');
    await m.click(action(0));
    assert.deepEqual(shell.calls.filter(([name]) => name === 'start'), [['start']], 'no URL, path or version crosses');
    assert.deepEqual(m.opened, [], 'the shell downloads, not the browser');

    const base = { version: '0.1.8-rc.1', name: 'Timon.AppImage', format: 'appimage' };
    await m.React.act(async () => { shell.push({ phase: 'downloading', ...base, received: 50_000_000, total: 200_000_000 }); });
    await m.until(() => /Downloading… 25%/.test(text()), 'the progress');
    assert.deepEqual(labels(), ['Cancel']);
    await m.click(action(0));
    assert.deepEqual(shell.calls.at(-1), ['cancel']);

    await m.React.act(async () => { shell.push({ phase: 'failed', ...base, code: 'insecure_redirect', resumable: false }); });
    await m.until(() => /unsafe address/.test(text()), 'the refusal said');
    assert.equal(card()?.querySelector('[data-notice-card]')?.getAttribute('data-notice-card'), 'warning');
    assert.deepEqual(labels(), ['Try again']);

    await m.React.act(async () => { shell.push({ phase: 'ready', ...base, total: 200_000_000 }); });
    await m.until(() => labels().join() === 'Install and restart', 'the verified AppImage');
    await m.React.act(async () => { shell.push({ phase: 'ready', version: '0.1.8-rc.1', name: 'timon.deb', format: 'deb', total: 1 }); });
    await m.until(() => labels().join() === 'Install', 'the verified .deb');

    // A file of an older offer is not this version's.
    await m.React.act(async () => { shell.push({ phase: 'ready', version: '0.1.7', name: 'old.deb', format: 'deb', total: 1 }); });
    await m.until(() => labels().join() === 'Update', 'back to Update');
  } finally {
    await m.unmount();
  }
});

test('Install: running missions are said first, Wait asks nothing, Install anyway confirms; each answer says what follows', async () => {
  const command = "sudo apt install '/home/user/.timon/updates/0.1.8-rc.1/timon.deb'";
  const shell = fakeShell({ phase: 'ready', version: '0.1.8-rc.1', name: 'timon.deb', format: 'deb', total: 1 }, {
    installs: [
      { status: 'missions', count: 2 },
      { status: 'missions', count: 2 },
      { status: 'guided', command, opened: true },
      { status: 'not_writable' },
      { status: 'failed', message: 'EBUSY' },
      { status: 'unsupported' },
    ],
  });
  const m = await mount(OFFER_STATUS, { shell });
  const installs = () => shell.calls.filter(([name]) => name === 'install');
  try {
    await m.until(() => labels().join() === 'Install', 'the install action');
    await m.click(action(0));
    await m.until(() => /2 missions are running\. Installing now stops them\./.test(text()), 'the running missions');
    assert.deepEqual(labels(), ['Install anyway', 'Wait']);
    assert.deepEqual(installs(), [['install', false]]);
    await m.click(action(1));
    await m.until(() => labels().join() === 'Install', 'back to Install');
    assert.equal(installs().length, 1);
    await m.click(action(0));
    await m.until(() => labels().join() === 'Install anyway,Wait', 'asked again');
    await m.click(action(0));
    await m.until(() => text().includes(command), 'the command of the .deb');
    assert.deepEqual(installs().at(-1), ['install', true]);
    assert.deepEqual(labels(), ['Copy']);

    // A new file starts over; the next answers come in order.
    await m.React.act(async () => { shell.push({ phase: 'ready', version: '0.1.8-rc.1', name: 'Timon.AppImage', format: 'appimage', total: 1 }); });
    await m.until(() => labels().join() === 'Install and restart', 'Install again');
    await m.click(action(0));
    await m.until(() => /cannot be written/.test(text()), 'the read-only folder');
    await m.click(action(0));
    assert.deepEqual(shell.calls.at(-1), ['open', 'folder']);

    await m.React.act(async () => { shell.push({ phase: 'ready', version: '0.1.8-rc.1', name: 'Timon.Setup.exe', format: 'nsis', total: 1 }); });
    await m.until(() => labels().join() === 'Install', 'Install again');
    await m.click(action(0));
    await m.until(() => /did not start\. Your current version is unchanged/.test(text()), 'the failure');
    assert.doesNotMatch(text(), /EBUSY/);
    // An older desktop cannot install: the installer opens as before.
    await m.click(action(0));
    await m.until(() => shell.calls.at(-1)?.[0] === 'open', 'the installer opened');
    assert.deepEqual(shell.calls.at(-1), ['open', 'installer']);
  } finally {
    await m.unmount();
  }
});

test('Install with no verified file left says so and downloads again', async () => {
  const shell = fakeShell({ phase: 'ready', version: '0.1.8-rc.1', name: 'Timon.Setup.exe', format: 'nsis', total: 1 }, { installs: [{ status: 'none' }] });
  const m = await mount(OFFER_STATUS, { shell });
  try {
    await m.until(() => labels().join() === 'Install', 'the install action');
    await m.click(action(0));
    await m.until(() => /no longer on this computer/.test(text()), 'the missing file said');
    assert.deepEqual(labels(), ['Download again']);
    await m.click(action(0));
    assert.deepEqual(shell.calls.at(-1), ['start'], 'no URL, path or version crosses');
  } finally {
    await m.unmount();
  }
});

test('Install: the system\'s password prompt shows Installing…; dismissing it goes back to Install, without an error', async () => {
  let answer: (outcome: unknown) => void = () => undefined;
  const pending = new Promise((resolve) => { answer = resolve; });
  const shell = fakeShell({ phase: 'ready', version: '0.1.8-rc.1', name: 'Timon-0.1.8-rc.1.pkg', format: 'pkg', total: 1 }, { installs: [pending] });
  const m = await mount(OFFER_STATUS, { shell });
  try {
    await m.until(() => labels().join() === 'Install', 'the install action');
    await m.click(action(0));
    await m.until(() => /Installing…/.test(text()), 'the installation under way');
    assert.deepEqual(labels(), [], 'nothing to click twice');
    await m.React.act(async () => { answer({ status: 'cancelled' }); await pending; });
    await m.until(() => labels().join() === 'Install', 'the prompt dismissed');
    assert.equal(card()?.querySelector('[data-notice-card]')?.getAttribute('data-notice-card'), 'info', 'nothing alarming');
  } finally {
    await m.unmount();
  }
});

test('openUpdateDialog() from elsewhere runs the card\'s flow; a window registered later takes over, and gives it back', async () => {
  const shell = fakeShell();
  const m = await mount(OFFER_STATUS, { shell });
  try {
    await m.until(() => card() !== null, 'the update card');
    assert.equal(m.dialog.openUpdateDialog(), true, 'the card provides the flow');
    assert.deepEqual(shell.calls.filter(([name]) => name === 'start'), [['start']]);
    const windowOpened: string[] = [];
    const dispose = m.dialog.provideUpdateDialog(() => { windowOpened.push('window'); });
    await m.click(action(0));
    assert.deepEqual(windowOpened, ['window'], 'the card\'s Update opens the newer flow');
    dispose();
    await m.click(action(0));
    assert.equal(shell.calls.filter(([name]) => name === 'start').length, 2);
  } finally {
    await m.unmount();
  }
});

test('the updates module registers the card source, and the banner is gone from the top bar', () => {
  const client = readFileSync(resolve(process.cwd(), 'src', 'plugins-client', 'updates.tsx'), 'utf8');
  assert.match(client, /ctx\.register\(\{ slot: NOTICES_SLOT, key: 'update' \}, UpdateNotice\)/);
  assert.doesNotMatch(client, /UPDATES_BANNER_SLOT/);
  const topbar = readFileSync(resolve(process.cwd(), 'src', 'components', 'topbar.tsx'), 'utf8');
  assert.doesNotMatch(topbar, /Update/);
  assert.equal(existsSync(resolve(process.cwd(), 'src', 'components', 'updates', 'update-banner.tsx')), false);
  const index = readFileSync(resolve(process.cwd(), 'src', 'plugins-client', 'index.ts'), 'utf8');
  assert.match(index, /updatesClient,/);
});
