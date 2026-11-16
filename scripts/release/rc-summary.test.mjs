import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSummary } from './build-package.mjs';
import { collect, findSummaries, main, parseArgs, renderMarkdown } from './rc-summary.mjs';

const VERSION = '0.2.0-rc.1';
const COMMIT = 'b'.repeat(40);
const info = { channel: 'beta', builtAt: '2026-11-16T10:00:00.000Z', expiresAt: '2027-02-14T10:00:00.000Z' };
const FILES = {
  linux: [{ name: 'Timon-0.2.0-rc.1.AppImage', format: 'appimage', size: 150 * 1024 * 1024, sha256: 'a'.repeat(64) }, { name: 'timon-desktop_0.2.0-rc.1_amd64.deb', format: 'deb', size: 20, sha256: 'c'.repeat(64) }],
  mac: [{ name: 'Timon-0.2.0-rc.1-arm64.dmg', format: 'dmg', size: 30, sha256: 'd'.repeat(64) }, { name: 'Timon-0.2.0-rc.1-arm64.pkg', format: 'pkg', size: 31, sha256: 'e'.repeat(64) }],
  windows: [{ name: 'Timon Setup 0.2.0-rc.1.exe', format: 'nsis', size: 40, sha256: 'f'.repeat(64) }],
};
const summaryFor = (os, extra = {}) => buildSummary({
  version: VERSION, kind: 'rc', buildInfo: info, os, arch: os === 'mac' ? 'arm64' : 'x64', commit: COMMIT, node: 'v22.23.4',
  signing: { mode: 'none', ...(os === 'mac' ? { mac: 'adhoc' } : {}) }, files: FILES[os], ...extra,
});
const opts = { version: VERSION, commit: COMMIT, os: ['linux', 'mac', 'windows'] };

/** Lays the summaries out as download-artifact does: one folder per artifact. */
function artifacts(summaries) {
  const dir = mkdtempSync(join(tmpdir(), 'rc-summary-'));
  for (const [name, summary] of Object.entries(summaries)) {
    mkdirSync(join(dir, `rc-summary-${name}`), { recursive: true });
    writeFileSync(join(dir, `rc-summary-${name}`, 'build-summary.json'), typeof summary === 'string' ? summary : JSON.stringify(summary));
  }
  return dir;
}

test('parseArgs: a directory, the version and the commit; the three systems by default', () => {
  assert.deepEqual(parseArgs(['out', '--version', VERSION, '--commit', COMMIT]), { dir: 'out', ...opts });
  assert.deepEqual(parseArgs(['out', '--version', VERSION, '--commit', COMMIT, '--os', 'linux']).os, ['linux']);
  assert.throws(() => parseArgs(['out', '--version', VERSION]), /Usage/);
  assert.throws(() => parseArgs(['out', '--version', VERSION, '--commit', COMMIT, '--os', 'linux,bsd']), /--os takes/);
  assert.throws(() => parseArgs(['a', 'b', '--version', VERSION, '--commit', COMMIT]), /unexpected argument b/);
});

test('three matching summaries: no problem, one table per system', () => {
  const dir = artifacts({ linux: summaryFor('linux'), mac: summaryFor('mac'), windows: summaryFor('windows') });
  assert.equal(findSummaries(dir).length, 3);
  const result = collect(findSummaries(dir), opts);
  assert.deepEqual(result.problems, []);
  const markdown = renderMarkdown(result, opts);
  assert.match(markdown, /## Release candidate 0\.2\.0-rc\.1/);
  assert.match(markdown, new RegExp(`Commit: \`${COMMIT}\``));
  assert.match(markdown, /Expires: 2027-02-14T10:00:00\.000Z/);
  assert.match(markdown, /### mac \(arm64\)/);
  assert.match(markdown, /signing: no OS identity \(adhoc\)/);
  assert.match(markdown, /\| Timon-0\.2\.0-rc\.1\.AppImage \| appimage \| 150\.0 MiB \| `a{64}` \|/);
  assert.match(markdown, /\| Timon Setup 0\.2\.0-rc\.1\.exe \| nsis \| 40 B \|/);
  assert.doesNotMatch(markdown, /### Problems/);
});

test('a missing system, another commit or an invalid file are problems, and the rest still shows', () => {
  const dir = artifacts({ linux: summaryFor('linux'), mac: summaryFor('mac', { commit: 'c'.repeat(40) }), windows: '{"schema":1}' });
  const result = collect(findSummaries(dir), opts);
  assert.equal(result.byOs.size, 1);
  assert.ok(result.problems.some((p) => /^mac: built commit c{40}, expected b{40}$/.test(p)), result.problems.join('\n'));
  assert.ok(result.problems.some((p) => /build-summary\.json: build-summary\.json: invalid version/.test(p)), result.problems.join('\n'));
  assert.ok(result.problems.some((p) => p === 'windows: no build summary (the job failed or did not run)'));
  const markdown = renderMarkdown(result, opts);
  assert.match(markdown, /### Problems/);
  assert.match(markdown, /### linux/);
  assert.doesNotMatch(markdown, /### mac/);
});

test('another version, a final build, duplicates and diverging expiries are refused', () => {
  const final = buildSummary({ version: '0.2.0', kind: 'final', buildInfo: info, os: 'linux', arch: 'x64', commit: COMMIT, files: FILES.linux, signing: { mode: 'none' } });
  const wrong = collect([], opts, () => '');
  assert.equal(wrong.problems.length, 3);
  const read = (map) => (file) => JSON.stringify(map[file]);
  assert.match(collect(['a'], { ...opts, os: ['linux'] }, read({ a: final })).problems[0], /built 0\.2\.0, expected 0\.2\.0-rc\.1/);
  assert.match(collect(['a', 'b'], { ...opts, os: ['linux'] }, read({ a: summaryFor('linux'), b: summaryFor('linux') })).problems[0], /more than one/);
  const later = summaryFor('mac', { buildInfo: { ...info, expiresAt: '2027-02-15T10:00:00.000Z' } });
  assert.ok(collect(['a', 'b'], { ...opts, os: ['linux', 'mac'] }, read({ a: summaryFor('linux'), b: later })).problems.some((p) => /disagree on the expiry/.test(p)));
});

test('main appends the recap to GITHUB_STEP_SUMMARY and fails when a system is missing', () => {
  const dir = artifacts({ linux: summaryFor('linux') });
  const stepSummary = join(mkdtempSync(join(tmpdir(), 'rc-step-')), 'summary.md');
  const log = console.log;
  console.log = () => {};
  const exitCode = process.exitCode;
  try {
    main([dir, '--version', VERSION, '--commit', COMMIT], { GITHUB_STEP_SUMMARY: stepSummary });
    assert.equal(process.exitCode, 1);
    process.exitCode = exitCode;
    main([dir, '--version', VERSION, '--commit', COMMIT, '--os', 'linux'], { GITHUB_STEP_SUMMARY: stepSummary });
    assert.equal(process.exitCode, exitCode);
  } finally {
    console.log = log;
    process.exitCode = exitCode;
  }
  const written = readFileSync(stepSummary, 'utf8');
  assert.equal(written.match(/## Release candidate/g).length, 2);
  assert.match(written, /mac: no build summary/);
});
