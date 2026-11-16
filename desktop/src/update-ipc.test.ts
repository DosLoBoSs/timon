/**
 * The desktop's update channels (docs/AUTO-UPDATE.md §7 P2): the renderer
 * names nothing, the offer comes from the local daemon with its token, and
 * the verified file opens only as itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UpdateDownloader, type FetchLike } from './update-download.js';
import { UPDATE_CHANNELS, UpdateController, readDaemonUpdateStatus, registerUpdateIpc, type UpdateControllerDeps } from './update-ipc.js';
import type { SilentInput, SilentOutcome } from './update-installer.js';

const BODY = Buffer.from('a verified installer');
const SHA = createHash('sha256').update(BODY).digest('hex');
const URL_OK = 'https://github.com/acme/timon-releases/releases/download/v0.1.8/Timon.Setup.0.1.8.exe';

const STATUS = {
  installed: '0.1.7', channel: 'beta', enabled: true, state: 'available', checkedAt: null, host: { os: 'win', arch: 'x64' }, buildExpiresAt: null,
  available: {
    version: '0.1.8', publishedAt: '2026-11-04T00:00:00Z', notes: '', notesUrl: 'https://docs.timon-ai.com/changelog',
    artifacts: [
      { key: 'win-x64-nsis', os: 'win', arch: 'x64', format: 'nsis', name: 'Timon.Setup.0.1.8.exe', url: URL_OK, size: BODY.length, sha256: SHA },
      { key: 'linux-x64-appimage', os: 'linux', arch: 'x64', format: 'appimage', name: 'Timon-0.1.8.AppImage', url: URL_OK, size: BODY.length, sha256: SHA },
    ],
  },
};

function setup(overrides: Partial<UpdateControllerDeps> = {}, machine = { platform: 'win32' as NodeJS.Platform, arch: 'x64', appImage: false }) {
  const requested: string[] = [];
  const fetch: FetchLike = async (url) => { requested.push(url); return new Response(BODY, { status: 200 }); };
  const downloader = new UpdateDownloader({ root: join(mkdtempSync(join(tmpdir(), 'timon update ')), 'updates'), fetch, freeBytes: async () => null });
  const opened: string[] = [];
  const shown: string[] = [];
  const controller = new UpdateController({
    downloader,
    readStatus: async () => STATUS,
    installed: '0.1.7',
    machine,
    showItemInFolder: (path) => { shown.push(path); },
    openPath: async (path) => { opened.push(path); return ''; },
    ...overrides,
  });
  const handlers = new Map<string, (sender: { isWindow: boolean; isMainFrame: boolean; url: string }, input: unknown) => unknown>();
  let trusted = true;
  registerUpdateIpc({ handle: (channel, listener) => { handlers.set(channel, listener); } }, () => trusted, () => controller);
  const sender = { isWindow: true, isMainFrame: true, url: 'http://127.0.0.1:3101/' };
  const call = (channel: string, input?: unknown) => Promise.resolve().then(() => handlers.get(channel)!(sender, input));
  return { controller, downloader, requested, opened, shown, call, distrust: () => { trusted = false; } };
}

test('a page that tries to name an installer is refused, and nothing is fetched', async () => {
  const s = setup();
  await assert.rejects(s.call(UPDATE_CHANNELS.start, { url: 'https://evil.example/Timon.exe' }), /takes no argument/);
  await assert.rejects(s.call(UPDATE_CHANNELS.start, 'https://evil.example/Timon.exe'), /takes no argument/);
  await assert.rejects(s.call(UPDATE_CHANNELS.cancel, { force: true }), /takes no argument/);
  await assert.rejects(s.call(UPDATE_CHANNELS.state, {}), /takes no argument/);
  await assert.rejects(s.call(UPDATE_CHANNELS.open, { target: 'installer', path: 'C:\\evil.exe' }));
  await assert.rejects(s.call(UPDATE_CHANNELS.open, { target: 'C:\\evil.exe' }));
  assert.deepEqual(s.requested, []);
  assert.deepEqual(s.opened, []);
});

test('a frame, another window or another origin cannot use the channels', async () => {
  const s = setup();
  s.distrust();
  for (const channel of [UPDATE_CHANNELS.state, UPDATE_CHANNELS.start, UPDATE_CHANNELS.cancel]) {
    await assert.rejects(s.call(channel), /only downloaded from the Timon window/);
  }
  await assert.rejects(s.call(UPDATE_CHANNELS.open, { target: 'folder' }), /only downloaded from the Timon window/);
  assert.deepEqual(s.requested, []);
});

test('start downloads the daemon\'s installer for this machine, then opens the folder or the installer', async () => {
  const s = setup();
  assert.equal((await s.call(UPDATE_CHANNELS.open, { target: 'folder' }) as { status: string }).status, 'none');
  const state = await s.call(UPDATE_CHANNELS.start) as { phase: string; version: string };
  assert.equal(state.phase, 'ready');
  assert.equal(state.version, '0.1.8');
  assert.deepEqual(s.requested, [URL_OK]);
  assert.deepEqual(await s.call(UPDATE_CHANNELS.open, { target: 'folder' }), { status: 'opened' });
  assert.match(s.shown[0]!, /Timon\.Setup\.0\.1\.8\.exe$/);
  assert.deepEqual(await s.call(UPDATE_CHANNELS.open, { target: 'installer' }), { status: 'opened' });
  assert.equal(s.opened[0], s.shown[0]);
});

test('an installer that changed after its verification is not opened', async () => {
  const s = setup();
  await s.call(UPDATE_CHANNELS.start);
  writeFileSync(s.downloader.ready()!.path, 'tampered');
  const outcome = await s.call(UPDATE_CHANNELS.open, { target: 'installer' }) as { status: string; message: string };
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.message, /changed after it was verified/);
  assert.deepEqual(s.opened, []);
});

test('an AppImage is shown in its folder, not opened (its replacement is P3)', async () => {
  const s = setup({}, { platform: 'linux', arch: 'x64', appImage: true });
  assert.equal((await s.call(UPDATE_CHANNELS.start) as { phase: string }).phase, 'ready');
  assert.deepEqual(await s.call(UPDATE_CHANNELS.open, { target: 'installer' }), { status: 'unsupported' });
  assert.deepEqual(await s.call(UPDATE_CHANNELS.open, { target: 'folder' }), { status: 'opened' });
});

test('no offer for this machine, an older one, or no daemon: a failure that fetched nothing', async () => {
  const mac = setup({}, { platform: 'darwin', arch: 'arm64', appImage: false });
  assert.deepEqual(await mac.call(UPDATE_CHANNELS.start), { phase: 'failed', version: null, name: null, code: 'no_offer', resumable: false });
  const newer = setup({ installed: '0.1.8' });
  assert.equal((await newer.call(UPDATE_CHANNELS.start) as { code: string }).code, 'no_offer');
  const down = setup({ readStatus: async () => { throw new TypeError('fetch failed'); } });
  assert.equal((await down.call(UPDATE_CHANNELS.start) as { code: string }).code, 'daemon');
  assert.deepEqual([...mac.requested, ...newer.requested, ...down.requested], []);
});

test('the daemon is asked on the loopback only, with its token, and nothing else', async () => {
  const home = mkdtempSync(join(tmpdir(), 'timon home '));
  writeFileSync(join(home, 'daemon-token'), 'secret\n');
  const seen: { url: string; init?: RequestInit }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), init });
    return Response.json(STATUS);
  }) as typeof fetch;
  assert.deepEqual(await readDaemonUpdateStatus('http://127.0.0.1:3001', home, fetcher), STATUS);
  assert.equal(seen[0]!.url, 'http://127.0.0.1:3001/api/updates');
  assert.equal(seen[0]!.init?.redirect, 'error');
  assert.deepEqual(seen[0]!.init?.headers, { Authorization: 'Bearer secret', accept: 'application/json' });
  await assert.rejects(readDaemonUpdateStatus('http://192.168.1.5:3001', home, fetcher), /not a local daemon/);
  await assert.rejects(readDaemonUpdateStatus('https://127.0.0.1:3001', home, fetcher), /not a local daemon/);
  assert.equal(seen.length, 1);
  const refused = (async () => Response.json({ error: 'forbidden' }, { status: 403 })) as typeof fetch;
  await assert.rejects(readDaemonUpdateStatus('http://127.0.0.1:3001', home, refused), /403/);
});

test('the preload exposes these channels and passes no page value but the gesture', () => {
  // preload.cts is CommonJS and cannot import this module: its copy of the names is held here.
  const preload = readFileSync(new URL('./preload.cts', import.meta.url), 'utf8');
  for (const channel of [UPDATE_CHANNELS.state, UPDATE_CHANNELS.start, UPDATE_CHANNELS.cancel]) {
    assert.ok(preload.includes(`ipcRenderer.invoke('${channel}')`), channel);
  }
  assert.ok(preload.includes(`ipcRenderer.invoke('${UPDATE_CHANNELS.open}', { target })`));
  assert.ok(preload.includes(`ipcRenderer.on('${UPDATE_CHANNELS.event}', forward)`));
});

function installSetup(machine: { platform: NodeJS.Platform; arch: string; appImage: boolean }, overrides: Partial<UpdateControllerDeps> = {}) {
  const events: string[] = [];
  const s = setup({
    readMissions: async () => ({ live: 4, working: 2 }),
    appImage: machine.appImage ? '/opt/Timon.AppImage' : null,
    replaceAppImage: async ({ appImage }) => {
      events.push(`replace ${appImage}`);
      return { status: 'replaced', restore: async () => { events.push('restore'); } };
    },
    relaunchAppImage: async (appImage) => { events.push(`relaunch ${appImage}`); return () => undefined; },
    quit: () => { events.push('quit'); },
    ...overrides,
  }, machine);
  return { ...s, events };
}

const WIN = { platform: 'win32' as NodeJS.Platform, arch: 'x64', appImage: false };
const APPIMAGE = { platform: 'linux' as NodeJS.Platform, arch: 'x64', appImage: true };

test('install: running missions stop it until the person confirms; the Windows installer opens, then the shell quits', async () => {
  const s = installSetup(WIN);
  assert.deepEqual(await s.call(UPDATE_CHANNELS.install, { confirmed: false }), { status: 'none' });
  await s.call(UPDATE_CHANNELS.start);
  assert.deepEqual(await s.call(UPDATE_CHANNELS.install, { confirmed: false }), { status: 'missions', count: 2 });
  assert.deepEqual(s.opened, []);
  assert.deepEqual(s.events, []);
  assert.deepEqual(await s.call(UPDATE_CHANNELS.install, { confirmed: true }), { status: 'closing' });
  assert.match(s.opened[0]!, /Timon\.Setup\.0\.1\.8\.exe$/);
  assert.deepEqual(s.events, ['quit']);
});

test('install: no mission, or a daemon that cannot tell, goes straight on', async () => {
  for (const readMissions of [async () => ({ live: 3, working: 0 }), async () => null, async () => { throw new Error('down'); }]) {
    const s = installSetup(WIN, { readMissions });
    await s.call(UPDATE_CHANNELS.start);
    assert.deepEqual(await s.call(UPDATE_CHANNELS.install, { confirmed: false }), { status: 'closing' });
  }
});

test('install takes a strict confirmation and nothing that names a file', async () => {
  const s = installSetup(WIN);
  await s.call(UPDATE_CHANNELS.start);
  await assert.rejects(s.call(UPDATE_CHANNELS.install));
  await assert.rejects(s.call(UPDATE_CHANNELS.install, { confirmed: true, path: 'C:\\evil.exe' }));
  await assert.rejects(s.call(UPDATE_CHANNELS.install, { confirmed: 'yes' }));
  s.distrust();
  await assert.rejects(s.call(UPDATE_CHANNELS.install, { confirmed: true }), /only downloaded from the Timon window/);
  assert.deepEqual(s.opened, []);
  assert.deepEqual(s.events, []);
});

test('install: an installer changed after its verification is not opened', async () => {
  const s = installSetup(WIN);
  await s.call(UPDATE_CHANNELS.start);
  writeFileSync(s.downloader.ready()!.path, 'tampered');
  const outcome = await s.call(UPDATE_CHANNELS.install, { confirmed: true }) as { status: string };
  assert.equal(outcome.status, 'failed');
  assert.deepEqual(s.opened, []);
  assert.deepEqual(s.events, []);
});

test('install: an AppImage is replaced, its relaunch queued, then the shell quits', async () => {
  const s = installSetup(APPIMAGE);
  await s.call(UPDATE_CHANNELS.start);
  assert.deepEqual(await s.call(UPDATE_CHANNELS.install, { confirmed: true }), { status: 'restarting' });
  assert.deepEqual(s.events, ['replace /opt/Timon.AppImage', 'relaunch /opt/Timon.AppImage', 'quit']);
  assert.deepEqual(s.opened, []);
});

test('install: a relaunch that cannot be queued puts the previous AppImage back, and the shell stays', async () => {
  const s = installSetup(APPIMAGE, { relaunchAppImage: async () => { throw new Error('no fusermount'); } });
  await s.call(UPDATE_CHANNELS.start);
  const outcome = await s.call(UPDATE_CHANNELS.install, { confirmed: true }) as { status: string; message: string };
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.message, /no fusermount/);
  assert.deepEqual(s.events, ['replace /opt/Timon.AppImage', 'restore']);
});

test('install: a replacement that failed, or a folder that cannot be written, neither relaunches nor quits', async () => {
  const failed = installSetup(APPIMAGE, { replaceAppImage: async () => { throw new Error('EBUSY'); } });
  await failed.call(UPDATE_CHANNELS.start);
  assert.equal((await failed.call(UPDATE_CHANNELS.install, { confirmed: true }) as { status: string }).status, 'failed');
  assert.deepEqual(failed.events, []);
  const readOnly = installSetup(APPIMAGE, { replaceAppImage: async () => ({ status: 'not_writable' }) });
  await readOnly.call(UPDATE_CHANNELS.start);
  assert.deepEqual(await readOnly.call(UPDATE_CHANNELS.install, { confirmed: true }), { status: 'not_writable' });
  assert.deepEqual(readOnly.events, []);
});

test('install: a .deb is handed to the system with the command to type; nothing is elevated', async () => {
  const deb = { key: 'linux-x64-deb', os: 'linux', arch: 'x64', format: 'deb', name: 'timon_0.1.8_amd64.deb', url: URL_OK, size: BODY.length, sha256: SHA };
  const s = installSetup({ platform: 'linux', arch: 'x64', appImage: false }, {
    readStatus: async () => ({ ...STATUS, available: { ...STATUS.available, artifacts: [deb] } }),
  });
  await s.call(UPDATE_CHANNELS.start);
  const outcome = await s.call(UPDATE_CHANNELS.install, { confirmed: true }) as { status: string; command: string; opened: boolean };
  assert.equal(outcome.status, 'guided');
  assert.equal(outcome.opened, true);
  assert.match(outcome.command, /^sudo apt install '.*timon_0\.1\.8_amd64\.deb'$/);
  assert.deepEqual(s.events, []);
});

test('install: the macOS .pkg opens in Installer.app and the shell stays open', async () => {
  const pkg = { key: 'mac-arm64-pkg', os: 'mac', arch: 'arm64', format: 'pkg', name: 'Timon-0.1.8-arm64.pkg', url: URL_OK, size: BODY.length, sha256: SHA };
  const s = installSetup({ platform: 'darwin', arch: 'arm64', appImage: false }, {
    readStatus: async () => ({ ...STATUS, available: { ...STATUS.available, artifacts: [pkg] } }),
  });
  await s.call(UPDATE_CHANNELS.start);
  assert.deepEqual(await s.call(UPDATE_CHANNELS.install, { confirmed: true }), { status: 'opened' });
  assert.match(s.opened[0]!, /Timon-0\.1\.8-arm64\.pkg$/);
  assert.deepEqual(s.events, []);
});

test('the preload passes the confirmation of install as a boolean, nothing else', () => {
  const preload = readFileSync(new URL('./preload.cts', import.meta.url), 'utf8');
  assert.ok(preload.includes(`ipcRenderer.invoke('${UPDATE_CHANNELS.install}', { confirmed: confirmed === true })`));
});

const PKG = { key: 'mac-arm64-pkg', os: 'mac', arch: 'arm64', format: 'pkg', name: 'Timon-0.1.8-arm64.pkg', url: URL_OK, size: BODY.length, sha256: SHA };
const DEB = { key: 'linux-x64-deb', os: 'linux', arch: 'x64', format: 'deb', name: 'timon_0.1.8_amd64.deb', url: URL_OK, size: BODY.length, sha256: SHA };
const MAC = { platform: 'darwin' as NodeJS.Platform, arch: 'arm64', appImage: false };
const LINUX_DEB = { platform: 'linux' as NodeJS.Platform, arch: 'x64', appImage: false };

function silentSetup(machine: { platform: NodeJS.Platform; arch: string; appImage: boolean }, artifact: object | null, outcome: SilentOutcome | (() => Promise<SilentOutcome>)) {
  const inputs: SilentInput[] = [];
  const s = installSetup(machine, {
    ...(artifact ? { readStatus: async () => ({ ...STATUS, available: { ...STATUS.available, artifacts: [artifact] } }) } : {}),
    readMissions: async () => null,
    silentInstall: async (input) => { inputs.push(input); s.events.push(`silent ${input.format}`); return typeof outcome === 'function' ? outcome() : outcome; },
    adminPrompt: (version) => `password for ${version}`,
    relaunch: () => { s.events.push('relaunch'); },
  });
  return { ...s, inputs };
}

test('install, Windows: the silent installer is handed the verified file, then the shell quits; it starts Timon again', async () => {
  const s = silentSetup(WIN, null, { status: 'handed_over' });
  await s.call(UPDATE_CHANNELS.start);
  assert.deepEqual(await s.call(UPDATE_CHANNELS.install, { confirmed: true }), { status: 'restarting' });
  assert.deepEqual(s.events, ['silent nsis', 'quit'], 'no relaunch from here: the installer does it');
  assert.match(s.inputs[0]!.path, /Timon\.Setup\.0\.1\.8\.exe$/);
  assert.equal(s.inputs[0]!.sha256, SHA);
  assert.deepEqual(s.opened, []);
});

test('install, Windows: no silent path falls back to the visible installer, then quits', async () => {
  const s = silentSetup(WIN, null, { status: 'unavailable', reason: 'PowerShell is not available.' });
  await s.call(UPDATE_CHANNELS.start);
  assert.deepEqual(await s.call(UPDATE_CHANNELS.install, { confirmed: true }), { status: 'closing' });
  assert.deepEqual(s.events, ['silent nsis', 'quit']);
  assert.match(s.opened[0]!, /Timon\.Setup\.0\.1\.8\.exe$/);
});

test('install, macOS: installed behind the administrator prompt, then the shell restarts into it', async () => {
  const s = silentSetup(MAC, PKG, { status: 'installed' });
  await s.call(UPDATE_CHANNELS.start);
  assert.deepEqual(await s.call(UPDATE_CHANNELS.install, { confirmed: true }), { status: 'restarting' });
  assert.deepEqual(s.events, ['silent pkg', 'relaunch', 'quit']);
  assert.equal(s.inputs[0]!.prompt, 'password for 0.1.8');
  assert.deepEqual(s.opened, []);
});

test('install, macOS: a dismissed prompt changes nothing and alarms no one; the file stays ready', async () => {
  const s = silentSetup(MAC, PKG, { status: 'cancelled' });
  await s.call(UPDATE_CHANNELS.start);
  assert.deepEqual(await s.call(UPDATE_CHANNELS.install, { confirmed: true }), { status: 'cancelled' });
  assert.deepEqual(s.events, ['silent pkg']);
  assert.deepEqual(s.opened, []);
  assert.equal(s.controller.state().phase, 'ready');
});

test('install, macOS: a failed silent install opens Installer.app, as before', async () => {
  const s = silentSetup(MAC, PKG, { status: 'failed', reason: 'installer: Error' });
  await s.call(UPDATE_CHANNELS.start);
  assert.deepEqual(await s.call(UPDATE_CHANNELS.install, { confirmed: true }), { status: 'opened' });
  assert.deepEqual(s.events, ['silent pkg']);
  assert.match(s.opened[0]!, /Timon-0\.1\.8-arm64\.pkg$/);
});

test('install, Linux .deb: pkexec installs then the shell restarts; a refusal falls back to the guided command', async () => {
  const done = silentSetup(LINUX_DEB, DEB, { status: 'installed' });
  await done.call(UPDATE_CHANNELS.start);
  assert.deepEqual(await done.call(UPDATE_CHANNELS.install, { confirmed: true }), { status: 'restarting' });
  assert.deepEqual(done.events, ['silent deb', 'relaunch', 'quit']);
  const refused = silentSetup(LINUX_DEB, DEB, { status: 'unavailable', reason: 'No authentication agent found.' });
  await refused.call(UPDATE_CHANNELS.start);
  const outcome = await refused.call(UPDATE_CHANNELS.install, { confirmed: true }) as { status: string; command: string };
  assert.equal(outcome.status, 'guided');
  assert.match(outcome.command, /^sudo apt install '.*timon_0\.1\.8_amd64\.deb'$/);
  assert.deepEqual(refused.events, ['silent deb']);
  const dismissed = silentSetup(LINUX_DEB, DEB, { status: 'cancelled' });
  await dismissed.call(UPDATE_CHANNELS.start);
  assert.deepEqual(await dismissed.call(UPDATE_CHANNELS.install, { confirmed: true }), { status: 'cancelled' });
  assert.deepEqual(dismissed.opened, []);
});

test('install: a silent install that throws, or bytes changed meanwhile, never end in opening a changed file', async () => {
  const thrown = silentSetup(MAC, PKG, async () => { throw new Error('boom'); });
  await thrown.call(UPDATE_CHANNELS.start);
  assert.deepEqual(await thrown.call(UPDATE_CHANNELS.install, { confirmed: true }), { status: 'opened' });
  let s: ReturnType<typeof silentSetup> | null = null;
  s = silentSetup(MAC, PKG, async () => { writeFileSync(s!.downloader.ready()!.path, 'swapped'); return { status: 'failed', reason: 'The installer changed before it was installed.' }; });
  await s.call(UPDATE_CHANNELS.start);
  assert.equal((await s.call(UPDATE_CHANNELS.install, { confirmed: true }) as { status: string }).status, 'failed');
  assert.deepEqual(s.opened, []);
});

test('install: an installer changed after its verification is never handed to the silent path', async () => {
  const s = silentSetup(WIN, null, { status: 'handed_over' });
  await s.call(UPDATE_CHANNELS.start);
  writeFileSync(s.downloader.ready()!.path, 'tampered');
  assert.equal((await s.call(UPDATE_CHANNELS.install, { confirmed: true }) as { status: string }).status, 'failed');
  assert.deepEqual(s.inputs, []);
  assert.deepEqual(s.events, []);
});

test('install: a second gesture while the password prompt is open gets the first one\'s answer, not a second prompt', async () => {
  let answer: (outcome: SilentOutcome) => void = () => undefined;
  const s = silentSetup(MAC, PKG, () => new Promise<SilentOutcome>((resolve) => { answer = resolve; }));
  await s.call(UPDATE_CHANNELS.start);
  const first = s.call(UPDATE_CHANNELS.install, { confirmed: true });
  const second = s.call(UPDATE_CHANNELS.install, { confirmed: true });
  await new Promise((resolve) => setTimeout(resolve, 50));
  answer({ status: 'cancelled' });
  assert.deepEqual(await first, { status: 'cancelled' });
  assert.deepEqual(await second, { status: 'cancelled' });
  assert.equal(s.inputs.length, 1);
});
