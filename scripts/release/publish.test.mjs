import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyIdFor, verifyInstallManifest, verifyReleaseManifest } from '../release-manifest.mjs';
import {
  ED25519_KEY_ENV, INSTALL_RELEASES_FILE, P256_KEY_ENV, RELEASES_FILE, ROOT, SUMMARY_FILE, artifactKey, decodeKeySecret, keysFromEnv,
  channelEntry, highlightsLine, main, notesFor, parseArgs, parseChecksums, readGithubConfig, readPinnedKeyIds, redactor, secretValues,
} from './publish.mjs';

const SCRIPT = fileURLToPath(new URL('./publish.mjs', import.meta.url));
const REPO = 'acme/timon';
const TOKEN = 'ghs_TESTtoken0123456789abcdefABCDEF';
const COMMIT = 'a'.repeat(40);
const now = new Date('2026-11-16T10:00:00.000Z');
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

// Throwaway pairs per run: no test ever reads a real release key.
function secrets() {
  const ed = generateKeyPairSync('ed25519');
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const edPem = ed.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const p256Pem = ec.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const edPublic = ed.publicKey.export({ type: 'spki', format: 'pem' });
  const p256Public = ec.publicKey.export({ type: 'spki', format: 'pem' });
  return {
    edPem, p256Pem, edPublic, p256Public,
    edKeyId: keyIdFor(edPublic), p256KeyId: keyIdFor(p256Public),
    // One as PEM text, one as base64 of the PEM: both encodings are accepted.
    env: { GITHUB_REPOSITORY: REPO, GH_TOKEN: TOKEN, [ED25519_KEY_ENV]: edPem, [P256_KEY_ENV]: Buffer.from(p256Pem).toString('base64') },
  };
}

const INSTALLERS = {
  linux: (v) => [`Timon-${v}.AppImage`, `timon-desktop_${v}_amd64.deb`],
  mac: (v) => [`Timon-${v}-arm64.dmg`, `Timon-${v}-arm64.pkg`],
  windows: (v) => [`Timon Setup ${v}.exe`],
};
const ARCH = { linux: 'x64', mac: 'arm64', windows: 'x64' };

function writeBuild(input, version, os, { summaryVersion = version, commit = COMMIT, names = INSTALLERS[os](version), checksums = true, extra = [] } = {}) {
  const dir = join(input, version, os);
  mkdirSync(dir, { recursive: true });
  const files = names.map((name) => {
    const bytes = randomBytes(256 + name.length);
    writeFileSync(join(dir, name), bytes);
    return { name, size: bytes.length, sha256: sha256(bytes) };
  });
  const blockmap = Buffer.from('not an installer');
  writeFileSync(join(dir, `${names[0]}.blockmap`), blockmap);
  files.push({ name: `${names[0]}.blockmap`, size: blockmap.length, sha256: sha256(blockmap) });
  for (const name of extra) writeFileSync(join(dir, name), randomBytes(64));
  writeFileSync(join(dir, SUMMARY_FILE), JSON.stringify({ version: summaryVersion, os, arch: ARCH[os], commit, channel: 'stable', files }, null, 2));
  if (checksums) writeFileSync(join(dir, 'SHA256SUMS'), files.map((f) => `${f.sha256}  ${f.name}\n`).join(''));
  return { dir, files };
}

function workspace(version = '0.1.9-rc.1', options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'timon-publish-'));
  const input = join(root, 'dist-release');
  const manifests = join(root, 'site');
  mkdirSync(manifests);
  for (const os of ['linux', 'mac', 'windows']) if (!options.skip?.includes(os)) writeBuild(input, version, os, options[os]);
  return { root, input, manifests, version, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const CHANGELOG = '# Changelog\n\n## [Unreleased]\n\n### Fixed\n- Next fix.\n\n## [0.1.9] — 2026-11-16\n\n### Added\n- Final feature.\n\n## [0.1.8] — 2026-11-10\n\n- Older.\n';

/** An in-memory GitHub REST API: releases, assets, tags. */
function fakeGithub({ releases = [], tags = {}, failWith = null } = {}) {
  const state = { releases, tags, calls: [], uploads: [], next: 100 };
  const reply = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status });
  const page = (list, url) => {
    const size = Number(url.searchParams.get('per_page'));
    const n = Number(url.searchParams.get('page'));
    return list.slice((n - 1) * size, n * size);
  };
  state.fetch = async (input, init) => {
    const url = new URL(input);
    const method = init.method;
    state.calls.push(`${method} ${url.host}${url.pathname}`);
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.ok(!String(input).includes(TOKEN), 'the token never goes in a URL');
    if (failWith) return reply(failWith.status, { message: failWith.message });
    const path = url.pathname.replace(`/repos/${REPO}`, '');
    let m;
    if (method === 'GET' && (m = path.match(/^\/git\/ref\/tags\/(.+)$/))) {
      const sha = state.tags[decodeURIComponent(m[1])];
      return sha ? reply(200, { ref: `refs/tags/${m[1]}`, object: { type: 'commit', sha } }) : reply(404, { message: 'Not Found' });
    }
    if (method === 'GET' && path === '/releases') return reply(200, page(state.releases.map(({ assets, ...r }) => r), url));
    if (method === 'POST' && path === '/releases') {
      const body = JSON.parse(init.body);
      const release = { id: state.next++, tag_name: body.tag_name, target_commitish: body.target_commitish, name: body.name, body: body.body, draft: body.draft, prerelease: body.prerelease, make_latest: body.make_latest, assets: [] };
      state.releases.push(release);
      return reply(201, release);
    }
    const release = (id) => state.releases.find((r) => r.id === Number(id));
    if (method === 'GET' && (m = path.match(/^\/releases\/(\d+)\/assets$/))) return reply(200, page(release(m[1]).assets, url));
    if (method === 'POST' && url.host === 'uploads.github.com' && (m = path.match(/^\/releases\/(\d+)\/assets$/))) {
      const bytes = Buffer.from(init.body);
      const name = url.searchParams.get('name');
      assert.equal(init.headers['Content-Type'], 'application/octet-stream');
      const asset = { id: state.next++, name, size: bytes.length, digest: `sha256:${sha256(bytes)}`, state: 'uploaded' };
      release(m[1]).assets.push(asset);
      state.uploads.push(name);
      return reply(201, asset);
    }
    if (method === 'DELETE' && (m = path.match(/^\/releases\/assets\/(\d+)$/))) {
      for (const r of state.releases) r.assets = r.assets.filter((a) => a.id !== Number(m[1]));
      return reply(204);
    }
    if (method === 'PATCH' && (m = path.match(/^\/releases\/(\d+)$/))) {
      const r = release(m[1]);
      Object.assign(r, JSON.parse(init.body));
      if (!r.draft) state.tags[r.tag_name] = r.target_commitish;
      const { assets, ...rest } = r;
      return reply(200, rest);
    }
    return reply(500, { message: `unexpected ${method} ${url.pathname}` });
  };
  return state;
}

async function run(w, args = [], { env, github = fakeGithub(), pins = null, mission = false } = {}) {
  const out = [];
  const result = await main(['--version', w.version, '--input', w.input, '--manifests-dir', w.manifests, ...args], {
    env: mission ? { ...env, TIMON_MISSION_ID: 'm-1' } : env, root: w.root, now, fetch: github.fetch, print: (line) => out.push(line),
    readChangelog: (_root, commit) => { assert.equal(commit, COMMIT); return CHANGELOG; }, pins,
  });
  return { result, out: out.join('\n'), github };
}

async function refused(w, pattern, options = {}) {
  const github = fakeGithub();
  await assert.rejects(run(w, [], { ...options, github }), pattern);
  assert.deepEqual(github.calls, [], 'no network call before the inputs are verified');
  assert.deepEqual(readdirSync(w.manifests), [], 'nothing written');
}

test('an OS missing, a wrong digest, or versions that differ stop the run before any write', async (t) => {
  const s = secrets();
  const cases = [
    ['an OS missing', () => workspace('0.1.9', { skip: ['mac'] }), /lacks mac/],
    ['a different version', () => workspace('0.1.9', { windows: { summaryVersion: '0.1.8' } }), /versions differ: expected 0\.1\.9, found windows 0\.1\.8/],
    ['another commit', () => workspace('0.1.9', { linux: { commit: 'b'.repeat(40) } }), /different commits/],
    ['an installer not in the summary', () => workspace('0.1.9', { linux: { extra: ['Timon-0.1.9-arm64.AppImage'] } }), /not listed in build-summary\.json/],
    ['no pkg for the macOS installer', () => workspace('0.1.9', { mac: { names: ['Timon-0.1.9-arm64.dmg'] } }), /mac: no pkg installer/],
  ];
  for (const [name, make, pattern] of cases) {
    await t.test(name, async () => {
      const w = make();
      try { await refused(w, pattern, { env: s.env }); } finally { w.cleanup(); }
    });
  }
  await t.test('an installer altered after the build', async () => {
    const w = workspace('0.1.9');
    try {
      const file = join(w.input, '0.1.9', 'windows', 'Timon Setup 0.1.9.exe');
      const bytes = readFileSync(file);
      bytes[0] ^= 1;
      writeFileSync(file, bytes);
      await refused(w, /windows\/Timon Setup 0\.1\.9\.exe: its sha256 does not match/, { env: s.env });
    } finally { w.cleanup(); }
  });
  await t.test('a checksum file that disagrees with the summary', async () => {
    const w = workspace('0.1.9');
    try {
      const file = join(w.input, '0.1.9', 'linux', 'SHA256SUMS');
      writeFileSync(file, readFileSync(file, 'utf8').replace(/^[a-f0-9]{64}/, 'f'.repeat(64)));
      await refused(w, /checksum file and build-summary\.json disagree/, { env: s.env });
    } finally { w.cleanup(); }
  });
  await t.test('a summary for the wrong OS', async () => {
    const w = workspace('0.1.9');
    try {
      const file = join(w.input, '0.1.9', 'mac', SUMMARY_FILE);
      writeFileSync(file, readFileSync(file, 'utf8').replace('"os": "mac"', '"os": "linux"'));
      await refused(w, /describes "linux", not mac/, { env: s.env });
    } finally { w.cleanup(); }
  });
  await t.test('keys the clients do not pin', async () => {
    const w = workspace('0.1.9');
    try { await refused(w, /clients pin release-0000/, { env: s.env, pins: { ed25519: 'release-0000000000000000', p256: null } }); } finally { w.cleanup(); }
  });
});

test('publishes an rc as a prerelease, then a final into both channels; the manifests verify end to end', async () => {
  const s = secrets();
  const w = workspace('0.1.9-rc.1');
  const github = fakeGithub();
  const keyring = [{ keyId: s.edKeyId, publicKey: s.edPublic }];
  const p256 = { keyId: s.p256KeyId, publicKey: s.p256Public };
  try {
    const pins = { ed25519: s.edKeyId, p256: s.p256KeyId };
    const { result, out } = await run(w, [], { env: s.env, github, pins });
    assert.equal(result.published, true);
    const release = github.releases[0];
    assert.equal(release.tag_name, 'v0.1.9-rc.1');
    assert.equal(release.target_commitish, COMMIT);
    assert.equal(release.prerelease, true);
    assert.equal(release.draft, false, 'created as a draft, published once complete');
    assert.equal(release.make_latest, 'false', 'an rc never becomes the latest release');
    assert.equal(github.tags['v0.1.9-rc.1'], COMMIT);
    assert.ok(github.calls.indexOf(`POST api.github.com/repos/${REPO}/releases`) < github.calls.findIndex((c) => c.startsWith('PATCH')));
    assert.deepEqual(github.uploads.sort(), ['Timon-0.1.9-rc.1-arm64.dmg', 'Timon-0.1.9-rc.1-arm64.pkg', 'Timon-0.1.9-rc.1.AppImage', 'Timon.Setup.0.1.9-rc.1.exe', 'timon-desktop_0.1.9-rc.1_amd64.deb']);
    assert.match(out, /created v0\.1\.9-rc\.1 as a draft/);

    const text = readFileSync(join(w.manifests, RELEASES_FILE), 'utf8');
    assert.deepEqual(Object.keys(JSON.parse(text)), ['keyId', 'payload', 'sig'], 'the daemons accept exactly these fields');
    assert.ok(text.endsWith('}\n'));
    const payload = verifyReleaseManifest(text, keyring, { now });
    assert.deepEqual(Object.keys(payload.channels), ['beta']);
    assert.equal(payload.expiresAt, '2027-01-15T10:00:00.000Z', '60 days, as before');
    const beta = payload.channels.beta;
    assert.equal(beta.notes, '### Fixed\n- Next fix.', 'an rc carries the Unreleased section of its commit');
    assert.equal(beta.notesUrl, 'https://docs.timon-ai.com/changelog');
    assert.deepEqual(Object.keys(beta.artifacts).sort(), ['linux-x64-appimage', 'linux-x64-deb', 'mac-arm64-dmg', 'mac-arm64-pkg', 'win-x64-nsis']);
    const exe = readFileSync(join(w.input, '0.1.9-rc.1', 'windows', 'Timon Setup 0.1.9-rc.1.exe'));
    assert.deepEqual(beta.artifacts['win-x64-nsis'], {
      name: 'Timon.Setup.0.1.9-rc.1.exe', url: `https://github.com/${REPO}/releases/download/v0.1.9-rc.1/Timon.Setup.0.1.9-rc.1.exe`, size: exe.length, sha256: sha256(exe),
    });
    const install = readFileSync(join(w.manifests, INSTALL_RELEASES_FILE), 'utf8');
    assert.deepEqual(Object.keys(JSON.parse(install)), ['keyId', 'payload', 'sig', 'p256']);
    assert.deepEqual(verifyInstallManifest(install, keyring, p256, { now }), payload);
    assert.equal(JSON.parse(install).payload, JSON.parse(text).payload, 'both files carry the same signed bytes');

    // The final: both channels, from the manifest just written.
    const final = workspace('0.1.9');
    const { result: second } = await run({ ...final, manifests: w.manifests }, [], { env: s.env, github, pins });
    final.cleanup();
    const next = verifyReleaseManifest(readFileSync(join(w.manifests, RELEASES_FILE)), keyring, { now });
    assert.deepEqual(second.changed, ['beta', 'stable']);
    assert.equal(next.channels.stable.version, '0.1.9');
    assert.equal(next.channels.stable.notes, '### Added\n- Final feature.');
    const finalRelease = github.releases.find((r) => r.tag_name === 'v0.1.9');
    assert.equal(finalRelease.prerelease, false);
    assert.equal(finalRelease.make_latest, 'true');
  } finally { w.cleanup(); }
});

test('--draft uploads and keeps the release a draft without a manifest; the next run publishes it without uploading again', async () => {
  const s = secrets();
  const w = workspace('0.1.9');
  const github = fakeGithub();
  try {
    const { result, out } = await run(w, ['--draft'], { env: s.env, github });
    assert.equal(result.published, false);
    assert.equal(github.releases[0].draft, true);
    assert.equal(github.uploads.length, 5);
    assert.deepEqual(readdirSync(w.manifests), []);
    assert.match(out, /stays a draft: no manifest written/);
    const { result: second, out: again } = await run(w, [], { env: s.env, github });
    assert.equal(second.published, true);
    assert.equal(github.uploads.length, 5, 'nothing uploaded twice');
    assert.equal(github.releases[0].draft, false);
    assert.match(again, /already uploaded/);
    assert.deepEqual(readdirSync(w.manifests).sort(), [INSTALL_RELEASES_FILE, RELEASES_FILE]);
  } finally { w.cleanup(); }
});

test('--draft goes without the manifest keys; a published release still needs them', async () => {
  const s = secrets();
  const w = workspace('0.1.9');
  const keyless = { GITHUB_REPOSITORY: REPO, GH_TOKEN: TOKEN };
  try {
    const github = fakeGithub();
    const { result, out } = await run(w, ['--draft'], { env: keyless, github });
    assert.equal(result.published, false);
    assert.equal(github.releases[0].draft, true);
    assert.equal(github.uploads.length, 5);
    assert.deepEqual(readdirSync(w.manifests), []);
    assert.match(out, /a draft run signs no manifest/);
    assert.doesNotMatch(out, /\[dry-run\]/);
    // Without --draft, the keys are required before anything is sent.
    await refused(w, /both signing keys are required/, { env: keyless });
    // The approved run publishes the keyless draft without uploading again.
    const { result: second } = await run(w, [], { env: s.env, github });
    assert.equal(second.published, true);
    assert.equal(github.uploads.length, 5);

    const published = fakeGithub({ releases: [{ id: 7, tag_name: 'v0.1.9', draft: false, prerelease: false, assets: [] }], tags: { 'v0.1.9': COMMIT } });
    await assert.rejects(run(w, ['--draft'], { env: keyless, github: published }), /already published: its manifests need/);
    assert.deepEqual(published.uploads, [], 'nothing uploaded to a published release by a keyless run');
    assert.deepEqual(readdirSync(w.manifests).sort(), [INSTALL_RELEASES_FILE, RELEASES_FILE], 'only the approved run wrote manifests');
  } finally { w.cleanup(); }
});

test('a published asset with other bytes, or a tag on another commit, stops the run without a manifest', async () => {
  const s = secrets();
  const w = workspace('0.1.9');
  try {
    const github = fakeGithub({ releases: [{ id: 7, tag_name: 'v0.1.9', draft: false, prerelease: false, assets: [{ id: 8, name: 'Timon-0.1.9.AppImage', size: 1, digest: `sha256:${'0'.repeat(64)}`, state: 'uploaded' }] }], tags: { 'v0.1.9': COMMIT } });
    await assert.rejects(run(w, [], { env: s.env, github }), /already holds a different Timon-0\.1\.9\.AppImage/);
    assert.deepEqual(readdirSync(w.manifests), []);
    const moved = fakeGithub({ tags: { 'v0.1.9': 'c'.repeat(40) } });
    await assert.rejects(run(w, [], { env: s.env, github: moved }), /tag v0\.1\.9 already points to c{40}/);
    assert.ok(!moved.calls.some((call) => call.startsWith('POST')));
    // A draft's different copy (an earlier run's build) is replaced: nobody has it.
    const draft = fakeGithub({ releases: [{ id: 7, tag_name: 'v0.1.9', draft: true, prerelease: false, assets: [{ id: 8, name: 'Timon-0.1.9.AppImage', size: 1, digest: `sha256:${'0'.repeat(64)}`, state: 'uploaded' }] }] });
    const { out } = await run(w, [], { env: s.env, github: draft });
    assert.match(out, /replaced the draft's different copy/);
    assert.ok(draft.calls.includes(`DELETE api.github.com/repos/${REPO}/releases/assets/8`));
  } finally { w.cleanup(); }
});

test('--dry-run shows everything that would be published, without network and without writing', async () => {
  const s = secrets();
  const w = workspace('0.1.9');
  const github = fakeGithub();
  try {
    const { result, out } = await run(w, ['--dry-run'], { env: s.env, github, mission: true });
    assert.deepEqual(github.calls, []);
    assert.deepEqual(readdirSync(w.manifests), []);
    assert.equal(result.published, false);
    assert.ok(result.envelope && result.installEnvelope, 'signed and verified in memory');
    for (const expected of [/acme\/timon, release v0\.1\.9 at a{40}, channel\(s\) beta \+ stable/, /win-x64-nsis: Timon\.Setup\.0\.1\.9\.exe/, /mac-arm64-pkg/, /releases\.json: keyId release-[a-f0-9]{16}, changes beta \+ stable, valid until 2027-01-15/, /releases-install\.json: P-256 keyId/, /no network used, nothing written/]) assert.match(out, expected);
    assert.doesNotMatch(out, /blockmap/, 'only installers are published');
    // Without keys nor token, a dry run still shows the plan.
    const bare = await run(w, ['--dry-run'], { env: { GITHUB_REPOSITORY: REPO }, github });
    assert.match(bare.out, /TIMON_RELEASE_ED25519_KEY not set: the manifests would not be signed/);
    assert.deepEqual(github.calls, []);
  } finally { w.cleanup(); }
});

test('a real run needs the repository, the token and both keys, and is refused inside a mission', async () => {
  const s = secrets();
  const w = workspace('0.1.9');
  try {
    await refused(w, /Refused inside a Timon mission/, { env: s.env, mission: true });
    await refused(w, /GITHUB_REPOSITORY is not set/, { env: { ...s.env, GITHUB_REPOSITORY: '' } });
    await refused(w, /no GitHub token/, { env: { ...s.env, GH_TOKEN: '' } });
    await refused(w, /both signing keys are required/, { env: { ...s.env, [P256_KEY_ENV]: '' } });
    await refused(w, /TIMON_RELEASE_P256_KEY must be an ECDSA P-256 private key/, { env: { ...s.env, [P256_KEY_ENV]: s.edPem } });
    assert.equal(readGithubConfig({ GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: TOKEN }).repo, REPO);
    assert.ok(!JSON.stringify(readGithubConfig({ GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: TOKEN })).includes(TOKEN));
    assert.throws(() => readGithubConfig({ GITHUB_REPOSITORY: 'acme/timon.git', GH_TOKEN: TOKEN }), /owner/);
  } finally { w.cleanup(); }
});

test('no secret reaches the output, an error, or the disk', async () => {
  const s = secrets();
  const forms = secretValues(s.env);
  const leaks = (text) => forms.filter((secret) => text.includes(secret));
  assert.ok(forms.includes(TOKEN) && forms.some((v) => s.edPem.includes(v)) && forms.includes(s.env[P256_KEY_ENV]));
  const w = workspace('0.1.9');
  try {
    const texts = [];
    texts.push((await run(w, ['--dry-run'], { env: s.env })).out);
    // GitHub echoing a secret back in its error message.
    const echo = fakeGithub({ failWith: { status: 401, message: `Bad credentials ${TOKEN} ${s.edPem.split('\n')[1]}` } });
    const error = await run(w, [], { env: s.env, github: echo }).catch((e) => e);
    assert.match(error.message, /answered 401: Bad credentials \*\*\*/);
    texts.push(error.message, error.stack);
    // A malformed key is reported by name, never by value.
    const bad = { ...s.env, [ED25519_KEY_ENV]: `-----BEGIN PRIVATE KEY-----\n${'Z'.repeat(40)}\n-----END PRIVATE KEY-----` };
    const malformed = await run(w, [], { env: bad }).catch((e) => e);
    assert.match(malformed.message, /TIMON_RELEASE_ED25519_KEY is not a readable private key/);
    assert.ok(!malformed.message.includes('Z'.repeat(40)));
    texts.push((await run(w, [], { env: s.env })).out);
    for (const text of texts) assert.deepEqual(leaks(text), []);
    // The written tree: manifests and inputs, never a key.
    const walk = (dir) => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));
    for (const file of walk(w.root)) assert.deepEqual(leaks(readFileSync(file, 'latin1')), [], file);
  } finally { w.cleanup(); }
});

test('the command line: stdout and stderr stay free of secrets, and the keys must be those the clients pin', () => {
  const s = secrets();
  const w = workspace('0.1.9', Object.fromEntries(['linux', 'mac', 'windows'].map((os) => [os, { commit: headCommit() }])));
  try {
    const args = [SCRIPT, '--version', '0.1.9', '--input', w.input, '--manifests-dir', w.manifests, '--dry-run'];
    // The bare minimum to find node and git, on every OS.
    const env = Object.fromEntries(Object.entries({ PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot, TIMON_MISSION_ID: 'm-1' }).filter(([, v]) => v !== undefined));
    const pinned = spawnSync(process.execPath, args, { env: { ...env, ...s.env }, encoding: 'utf8', timeout: 60_000 });
    assert.equal(pinned.status, 1);
    assert.match(pinned.stderr, /is the key release-[a-f0-9]{16}, but the clients pin release-/, 'this checkout pins the real keys, not the test ones');
    const plain = spawnSync(process.execPath, args, { env: { ...env, GITHUB_REPOSITORY: REPO, GH_TOKEN: TOKEN }, encoding: 'utf8', timeout: 60_000 });
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(plain.stdout, /no network used, nothing written/);
    for (const output of [pinned.stdout, pinned.stderr, plain.stdout, plain.stderr]) for (const secret of secretValues(s.env)) assert.ok(!output.includes(secret));
    assert.deepEqual(readdirSync(w.manifests), []);
  } finally { w.cleanup(); }
});

function headCommit() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('key secrets: PEM, escaped PEM or base64; both public halves derive from the private ones', () => {
  const s = secrets();
  const oneLine = s.edPem.trim().replace(/\n/g, '\\n');
  assert.equal(decodeKeySecret(oneLine, 'X'), s.edPem.trim());
  assert.equal(decodeKeySecret(Buffer.from(s.edPem).toString('base64'), 'X'), s.edPem.trim());
  assert.throws(() => decodeKeySecret('not a key at all!', 'X'), /^Error: X must hold a PKCS#8 PEM private key/);
  assert.throws(() => decodeKeySecret('', 'X'), /X is not set/);
  const { keys, p256 } = keysFromEnv(s.env);
  assert.equal(keys.keyId, s.edKeyId);
  assert.equal(p256.keyId, s.p256KeyId);
  assert.throws(() => keysFromEnv({ [ED25519_KEY_ENV]: s.p256Pem }), /must be an Ed25519 private key/);
  assert.equal(redactor(secretValues(s.env))(`x ${TOKEN} y`), 'x *** y');
});

test('names, architectures and arguments', () => {
  assert.equal(artifactKey('linux', 'timon-desktop_0.1.9_amd64.deb', 'x64'), 'linux-x64-deb');
  assert.equal(artifactKey('mac', 'Timon-0.1.9.pkg', 'arm64'), 'mac-arm64-pkg', 'an unmarked name takes the summary architecture');
  assert.equal(artifactKey('linux', 'Timon-0.1.9.AppImage'), 'linux-x64-appimage');
  assert.throws(() => artifactKey('mac', 'Timon-0.1.9-arm64.dmg', 'x64'), /the name says arm64, the build summary x64/);
  assert.throws(() => artifactKey('windows', 'latest.yml'), /not an installer/);
  assert.deepEqual([...parseChecksums(`${'a'.repeat(64)} *x.exe\n\n${'B'.repeat(64)}  ./y.deb\n`, 'f')], [['x.exe', 'a'.repeat(64)], ['y.deb', 'b'.repeat(64)]]);
  assert.throws(() => parseChecksums('nonsense\n', 'f'), /line 1/);
  const opts = parseArgs(['--version', '0.1.9-rc.2', '--manifests-dir', 'site'], ROOT);
  assert.equal(opts.validDays, 60);
  assert.equal(opts.previous, join(opts.manifestsDir, RELEASES_FILE));
  assert.equal(opts.input, join(ROOT, 'dist-release'));
  assert.throws(() => parseArgs(['--version', '0.1'], ROOT), /x\.y\.z/);
  assert.throws(() => parseArgs(['--version', '0.1.9', '--valid-days', '400'], ROOT), /1 to 365/);
  assert.throws(() => parseArgs(['--version', '0.1.9', '--allow-partial'], ROOT), /Unexpected argument/);
  const pins = readPinnedKeyIds(ROOT);
  assert.match(pins.ed25519, /^release-[a-f0-9]{16}$/);
  assert.match(pins.p256, /^release-[a-f0-9]{16}$/);
});

test('the highlights pass into the manifest notes unchanged, and the run counts them', () => {
  const changelog = '# Changelog\n\n## [0.1.9] — 2026-11-20\n\n### Highlights\n- One\n- Two\n- Three\n\n### Added\n- More.\n';
  const notes = notesFor(changelog, '0.1.9');
  assert.match(notes, /^### Highlights\n- One\n- Two\n- Three\n\n### Added/);
  assert.equal(channelEntry({ version: '0.1.9', assets: [], notes, publishedAt: '2026-11-20T00:00:00.000Z' }).notes, notes);
  assert.equal(highlightsLine(3), '3');
  assert.match(highlightsLine(0), /none under ### Highlights/);
  assert.match(highlightsLine(7), /shows the first 5/);
});
