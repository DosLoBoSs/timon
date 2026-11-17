/**
 * The row of Settings › System › Updates: every state of the daemon's update
 * status, with and without `settings:write`, and the links of its menu.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANGELOG_URL, INSTALL_PAGE_URL, installerLink, manualInstallerLink, noticesSettingValue, noticesSwitchView, releaseNotesUrl,
  settingLockedBy, updateRowView,
} from './update-settings';
import type { UpdateStatus } from './updates';

const CHECKED = '2026-11-16T10:00:00.000Z';
const BASE: UpdateStatus = {
  installed: '0.1.8', channel: 'beta', enabled: true, state: 'up_to_date', checkedAt: CHECKED,
  available: null, host: { os: 'linux', arch: 'x64' }, buildExpiresAt: null,
};
const OFFER: UpdateStatus = {
  ...BASE,
  state: 'available',
  available: {
    version: '0.1.9', publishedAt: CHECKED, notes: 'Faster.', notesUrl: 'https://docs.timon-ai.com/changelog#019',
    artifacts: [
      { key: 'linux-x64-deb', os: 'linux', arch: 'x64', format: 'deb', name: 'timon.deb', url: 'https://example.com/timon.deb', size: 1 },
      { key: 'linux-x64-appimage', os: 'linux', arch: 'x64', format: 'appimage', name: 'Timon.AppImage', url: 'https://example.com/Timon.AppImage', size: 1 },
      { key: 'win-x64-nsis', os: 'win', arch: 'x64', format: 'nsis', name: 'Timon.Setup.exe', url: 'https://example.com/Timon.Setup.exe', size: 1 },
    ],
  },
};
const view = (status: UpdateStatus | null, over: { checking?: boolean; checkFailed?: boolean; canWrite?: boolean } = {}) =>
  updateRowView({ status, checking: false, checkFailed: false, canWrite: true, ...over });

test('up to date: the installed version, when it was checked, and "Check"', () => {
  assert.deepEqual(view(BASE), { version: '0.1.8', available: false, status: { kind: 'upToDate', checkedAt: CHECKED }, action: 'check' });
});

test('a check under way, then its failure, then "Retry"', () => {
  assert.deepEqual(view(BASE, { checking: true }).status, { kind: 'checking' });
  assert.equal(view(BASE, { checking: true }).action, 'checking');
  assert.deepEqual(view({ ...BASE, state: 'failed' }), { version: '0.1.8', available: false, status: { kind: 'failed' }, action: 'retry' });
  // No answer at all (network, refusal): the same words, the same way out.
  assert.equal(view(BASE, { checkFailed: true }).action, 'retry');
  assert.equal(view(null, { checkFailed: true }).status.kind, 'failed');
});

test('a newer version: its number in the title, and "Update" for everyone', () => {
  const offered = view(OFFER);
  assert.equal(offered.version, '0.1.9');
  assert.equal(offered.available, true);
  assert.deepEqual(offered.status, { kind: 'available', installed: '0.1.8', checkedAt: CHECKED });
  assert.equal(offered.action, 'update');
  assert.equal(view(OFFER, { canWrite: false }).action, 'update');
});

test('without settings:write the state shows, never "Check" nor "Retry"', () => {
  for (const status of [BASE, { ...BASE, state: 'failed' as const }, { ...BASE, state: 'unchecked' as const }]) {
    const read = view(status, { canWrite: false });
    assert.equal(read.action, 'none', status.state);
    assert.equal(read.version, '0.1.8');
  }
  assert.equal(view(BASE, { canWrite: false, checkFailed: true }).action, 'none');
});

test('switched off and a source build: the state, no action', () => {
  assert.deepEqual(view({ ...BASE, state: 'off', enabled: false }), { version: '0.1.8', available: false, status: { kind: 'off' }, action: 'none' });
  assert.deepEqual(view({ ...BASE, state: 'dev', channel: 'dev' }), { version: '0.1.8', available: false, status: { kind: 'dev' }, action: 'none' });
  assert.deepEqual(view({ ...BASE, state: 'unchecked', checkedAt: null }).status, { kind: 'unchecked' });
});

test('no status yet: nothing to offer', () => {
  assert.deepEqual(view(null), { version: null, available: false, status: { kind: 'unknown' }, action: 'none' });
});

test('the menu links the offered notes and installer, else the changelog and the install page', () => {
  assert.equal(releaseNotesUrl(OFFER), 'https://docs.timon-ai.com/changelog#019');
  assert.equal(releaseNotesUrl(BASE), CHANGELOG_URL);
  assert.equal(releaseNotesUrl(null), CHANGELOG_URL);
  const linux = 'Mozilla/5.0 (X11; Linux x86_64)';
  const here = (url: string) => ({ href: url, forThisSystem: true });
  const page = { href: INSTALL_PAGE_URL, forThisSystem: false };
  assert.deepEqual(manualInstallerLink(OFFER, linux), here('https://example.com/Timon.AppImage'));
  assert.deepEqual(manualInstallerLink(OFFER, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), here('https://example.com/Timon.Setup.exe'));
  // A Mac with no published installer, a phone, no offer: the page that lists them all.
  assert.deepEqual(manualInstallerLink(OFFER, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)'), page);
  assert.deepEqual(manualInstallerLink(OFFER, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)'), page);
  assert.deepEqual(manualInstallerLink(BASE, linux), page);
});

test('the card, the window and the menu share one link: the installer of this system, never the release notes', () => {
  assert.deepEqual(installerLink([]), { href: INSTALL_PAGE_URL, forThisSystem: false });
  const appImage = OFFER.available?.artifacts.find((a) => a.url.endsWith('.AppImage'));
  assert.ok(appImage);
  assert.deepEqual(installerLink([appImage]), { href: appImage.url, forThisSystem: true });
});

test('a switch the environment or the config file decides is reported as such', () => {
  assert.equal(settingLockedBy({ ok: true, setting: { source: 'env' } }), 'env');
  assert.equal(settingLockedBy({ ok: true, setting: { source: 'config' } }), 'config');
  assert.equal(settingLockedBy({ ok: true, setting: { source: 'db' } }), null);
  assert.equal(settingLockedBy(null), null);
});

test('the announcements switch follows its setting, and the update check off turns it off and locks it', () => {
  assert.deepEqual(noticesSwitchView({ updatesEnabled: true, notices: true }), { on: true, disabled: false });
  assert.deepEqual(noticesSwitchView({ updatesEnabled: true, notices: false }), { on: false, disabled: false });
  assert.deepEqual(noticesSwitchView({ updatesEnabled: true, notices: null }), { on: true, disabled: false });
  assert.deepEqual(noticesSwitchView({ updatesEnabled: false, notices: true }), { on: false, disabled: true });
});

test('the announcements value is read from the settings list', () => {
  const body = { settings: [{ key: 'TIMON_UPDATES_CHECK', value: true }, { key: 'TIMON_NOTICES_CHECK', value: false }] };
  assert.equal(noticesSettingValue(body), false);
  assert.equal(noticesSettingValue({ settings: [{ key: 'TIMON_NOTICES_CHECK', value: 'yes' }] }), null);
  assert.equal(noticesSettingValue({ settings: [] }), null);
  assert.equal(noticesSettingValue(null), null);
});
