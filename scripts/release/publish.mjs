#!/usr/bin/env node
/**
 * Publishes the installers built for the three OS: the GitHub release `v<version>`
 * and the signed update manifests the clients read.
 *
 *   node scripts/release/publish.mjs --version <x.y.z[-rc.N]> [--input <dir>] [--manifests-dir <dir>]
 *                                    [--previous <file>] [--valid-days N] [--draft] [--dry-run]
 *
 *  1. reads `<input>/<version>/{linux,mac,windows}/`, the folders the per-OS
 *     build wrote (scripts/release/build-package.mjs): `build-summary.json`,
 *     the optional `SHA256SUMS`, and the installers. All three OS must be
 *     there, with the same version and the same commit, and every installer is
 *     hashed again. Any doubt stops the run before anything public is written;
 *  2. signs, in memory, the next `releases.json` (Ed25519 envelope) and
 *     `releases-install.json` (the same plus `p256`), and verifies both, with
 *     the keys pinned by the clients when the checkout pins them;
 *  3. creates the release as a draft (or finds it, draft or published),
 *     uploads the installers it lacks, checks them back, then publishes it
 *     unless `--draft` is given. A draft is completed and published by a
 *     later run without `--draft`;
 *  4. once the release is public, writes the two manifests into
 *     `--manifests-dir` (the checkout root by default, where the site reads
 *     them on `main`). A draft gets none: its download URLs answer 404.
 *
 * Environment, nothing else:
 *  - GITHUB_REPOSITORY (owner/name) and GH_TOKEN or GITHUB_TOKEN, a token
 *    allowed to write releases there;
 *  - TIMON_RELEASE_ED25519_KEY and TIMON_RELEASE_P256_KEY, the private halves
 *    of the release pair and of the installers' pair: the PKCS#8 PEM text of
 *    the key files, or its base64 on one line. The public halves derive from
 *    them. A `--draft` run writes no manifest and may go without them, so the
 *    job that prepares a draft never holds the keys that sign for every user.
 * Secrets never reach the disk, an argument, a log line or an error: the
 * token goes in an Authorization header only, the keys stay KeyObjects, and
 * every line printed or thrown is redacted against all of them.
 *
 * Same channel rules, validity and notes as the maintainers' former
 * publish-release.mjs: an rc goes to `beta` as a prerelease, a final version
 * to `beta` and `stable`, the manifest expires after 60 days, the notes are
 * the changelog section of the built commit. The release is a draft first
 * (unlike the former `gh release create`) so that nobody sees it half-filled.
 *
 * A real run is refused inside a Timon mission: it reaches every user.
 * `--dry-run` is allowed anywhere, uses no network and writes nothing.
 */
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, lstatSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CHANGELOG_URL, createReleaseNotes } from '../../desktop/scripts/release-notes.mjs';
import { readFragmentsAt, withUnreleased } from '../changelog-fragments.mjs';
import {
  DEFAULT_VALID_DAYS, INSTALL_RELEASES_URL, RELEASES_URL, addInstallSignature, boundNotes, channelsFor, composeReleasesPayload,
  isPrerelease, isVersion, p256KeyPair, releaseKeyPair, serializeEnvelope, signReleasesPayload, verifyInstallManifest, verifyReleaseManifest,
} from '../release-manifest.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RELEASES_FILE = 'releases.json';
export const INSTALL_RELEASES_FILE = 'releases-install.json';
export const SUMMARY_FILE = 'build-summary.json';
export const CHECKSUM_FILES = ['SHA256SUMS', 'SHA256SUMS.txt'];
export const REQUIRED_OS = ['linux', 'mac', 'windows'];
export const ED25519_KEY_ENV = 'TIMON_RELEASE_ED25519_KEY';
export const P256_KEY_ENV = 'TIMON_RELEASE_P256_KEY';
export const REPO_ENV = 'GITHUB_REPOSITORY';
export const TOKEN_ENVS = ['GH_TOKEN', 'GITHUB_TOKEN'];
// The clients fetch these keys by name: install.sh takes the deb, the AppImage
// or the pkg, install.ps1 the NSIS installer. A release without one of them
// would break that installer for everyone, so it is refused up front.
export const REQUIRED_FORMATS = { linux: ['appimage', 'deb'], mac: ['pkg'], windows: ['nsis'] };
// Pinned endpoints: an enterprise host set on the runner never sees the token.
export const API_URL = 'https://api.github.com';
export const UPLOADS_URL = 'https://uploads.github.com';

const PREFIX = 'release: ';
const USAGE = 'Usage: node scripts/release/publish.mjs --version <x.y.z[-rc.N]> [--input <dir>] [--manifests-dir <dir>] [--previous <file>] [--valid-days N] [--draft] [--dry-run]';
const OS_PREFIX = { linux: 'linux', mac: 'mac', windows: 'win' };
const FORMATS = { linux: [['.appimage', 'appimage'], ['.deb', 'deb']], mac: [['.pkg', 'pkg'], ['.dmg', 'dmg']], windows: [['.exe', 'nsis']] };
const ARCHS = { x64: 'x64', amd64: 'x64', x86_64: 'x64', arm64: 'arm64', aarch64: 'arm64', universal: 'universal' };
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._+-]*$/;
const PAGE = 100;
const MAX_PAGES = 50;

export function parseArgs(args, root = ROOT) {
  const opts = { version: '', input: join(root, 'dist-release'), manifestsDir: root, previous: null, validDays: DEFAULT_VALID_DAYS, draft: false, dryRun: false };
  const paths = { '--input': 'input', '--manifests-dir': 'manifestsDir', '--previous': 'previous' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--draft') opts.draft = true;
    else if (arg === '--version' || arg === '--valid-days' || Object.hasOwn(paths, arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value\n${USAGE}`);
      if (arg === '--version') opts.version = value;
      else if (arg === '--valid-days') {
        if (!/^[1-9]\d{0,2}$/.test(value) || Number(value) > 365) throw new Error('--valid-days must be 1 to 365');
        opts.validDays = Number(value);
      } else opts[paths[arg]] = resolve(value);
    } else throw new Error(`Unexpected argument: ${arg}\n${USAGE}`);
  }
  if (!isVersion(opts.version)) throw new Error(`--version must be x.y.z or x.y.z-rc.N\n${USAGE}`);
  opts.previous ??= join(opts.manifestsDir, RELEASES_FILE);
  return opts;
}

export const inMission = (env = process.env) => Boolean(env.TIMON_MISSION_ID);
export const releaseTag = (version) => `v${version}`;

/**
 * GitHub rewrites special characters of an uploaded file name (a space becomes
 * a dot). The asset is uploaded under this name, so the URL written in the
 * signed manifest is the one GitHub serves, not a guess.
 */
export const assetName = (name) => name.replace(/[^A-Za-z0-9._-]+/g, '.').replace(/^[^A-Za-z0-9]+/, '');
export const assetUrl = (repo, tag, asset) => `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`;

const formatOf = (os, name) => FORMATS[os]?.find(([extension]) => name.toLowerCase().endsWith(extension))?.[1] ?? null;
export const isInstaller = (os, name) => formatOf(os, name) !== null;

export function normalizeArch(value) {
  if (value === undefined || value === null || value === '') return null;
  const arch = ARCHS[String(value).toLowerCase()];
  if (!arch) throw new Error(`unknown architecture ${JSON.stringify(String(value)).slice(0, 40)}`);
  return arch;
}

/**
 * The manifest key the updater looks up for its own OS, architecture and
 * format. The architecture comes from the file name as electron-builder writes
 * it, else from the build summary, else x64 (electron-builder's unmarked
 * default); a name and a summary that disagree are refused.
 */
export function artifactKey(os, name, arch = null) {
  const lower = name.toLowerCase();
  const format = formatOf(os, name);
  if (!format) throw new Error(`${os}/${name}: not an installer the updater knows`);
  const marked = /arm64|aarch64/.test(lower) ? 'arm64' : /universal/.test(lower) ? 'universal' : /x64|x86_64|amd64/.test(lower) ? 'x64' : null;
  if (marked && arch && marked !== arch) throw new Error(`${os}/${name}: the name says ${marked}, the build summary ${arch}`);
  return `${OS_PREFIX[os]}-${marked ?? arch ?? 'x64'}-${format}`;
}

export async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** `<sha256>  <name>` per line, as sha256sum writes it (`*` marks binary mode). */
export function parseChecksums(text, where) {
  const sums = new Map();
  for (const [index, raw] of text.replace(/\r\n?/g, '\n').split('\n').entries()) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(/^([A-Fa-f0-9]{64}) [ *](.+)$/);
    if (!match) throw new Error(`${where}, line ${index + 1}: not "<sha256>  <file>"`);
    const name = match[2].replace(/^\.\//, '');
    if (sums.has(name)) throw new Error(`${where}: ${name} is listed twice`);
    sums.set(name, match[1].toLowerCase());
  }
  return sums;
}

/** The build summary of one OS folder, shape-checked. */
export function readSummary(dir, os) {
  const file = join(dir, SUMMARY_FILE);
  if (!existsSync(file)) throw new Error(`${os}: ${SUMMARY_FILE} not found in ${dir}`);
  let summary;
  try { summary = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error(`${os}: ${SUMMARY_FILE} is not JSON`); }
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) throw new Error(`${os}: ${SUMMARY_FILE} is not an object`);
  const summaryOs = summary.os ?? summary.platform;
  if (summaryOs !== os) throw new Error(`${os}: ${SUMMARY_FILE} describes ${JSON.stringify(summaryOs)}, not ${os}`);
  if (!isVersion(summary.version)) throw new Error(`${os}: ${SUMMARY_FILE} has no valid version`);
  if (typeof summary.commit !== 'string' || !COMMIT.test(summary.commit)) throw new Error(`${os}: ${SUMMARY_FILE} has no full commit sha`);
  const files = summary.files ?? summary.artifacts;
  if (!Array.isArray(files) || !files.length) throw new Error(`${os}: ${SUMMARY_FILE} lists no file`);
  const names = new Set();
  const listed = files.map((entry) => {
    const { name, size, sha256 } = entry ?? {};
    if (typeof name !== 'string' || !FILE_NAME.test(name) || name.includes('..')) throw new Error(`${os}: ${SUMMARY_FILE} lists an invalid file name`);
    if (names.has(name)) throw new Error(`${os}: ${name} is listed twice`);
    names.add(name);
    if (!Number.isSafeInteger(size) || size < 1) throw new Error(`${os}/${name}: invalid size in ${SUMMARY_FILE}`);
    if (typeof sha256 !== 'string' || !SHA256.test(sha256)) throw new Error(`${os}/${name}: invalid sha256 in ${SUMMARY_FILE}`);
    return { name, size, sha256 };
  });
  return { os, version: summary.version, commit: summary.commit, arch: normalizeArch(summary.arch ?? summary.architecture), files: listed };
}

/**
 * One OS folder: every file the summary lists is a regular file of that size
 * and digest, SHA256SUMS (when present) agrees with both, and no installer
 * lies there unlisted (a summary older than its folder).
 */
export async function verifyOsFolder(dir, os) {
  const summary = readSummary(dir, os);
  for (const file of summary.files) {
    const path = join(dir, file.name);
    let stat;
    try { stat = lstatSync(path); } catch { throw new Error(`${os}/${file.name}: listed in ${SUMMARY_FILE} but missing`); }
    if (!stat.isFile()) throw new Error(`${os}/${file.name}: not a regular file`);
    if (stat.size !== file.size) throw new Error(`${os}/${file.name}: ${stat.size} bytes on disk, ${file.size} in ${SUMMARY_FILE}`);
    if (await sha256File(path) !== file.sha256) throw new Error(`${os}/${file.name}: its sha256 does not match ${SUMMARY_FILE}`);
  }
  const checksumName = CHECKSUM_FILES.find((name) => existsSync(join(dir, name)));
  if (checksumName) {
    const sums = parseChecksums(readFileSync(join(dir, checksumName), 'utf8'), `${os}: ${checksumName}`);
    const byName = new Map(summary.files.map((file) => [file.name, file]));
    for (const [name, sha256] of sums) {
      if (!byName.has(name)) throw new Error(`${os}: ${name} is in the checksum file but not in ${SUMMARY_FILE}`);
      if (byName.get(name).sha256 !== sha256) throw new Error(`${os}/${name}: the checksum file and ${SUMMARY_FILE} disagree`);
    }
    for (const file of summary.files) if (isInstaller(os, file.name) && !sums.has(file.name)) throw new Error(`${os}/${file.name}: missing from the checksum file`);
  }
  const listed = new Set(summary.files.map((file) => file.name));
  for (const name of readdirSync(dir)) if (isInstaller(os, name) && !listed.has(name)) throw new Error(`${os}: the installer ${name} is not listed in ${SUMMARY_FILE}`);
  return { ...summary, dir };
}

/** The three OS folders of `<input>/<version>`, checked against each other. */
export async function verifyBuilds(input, version) {
  const base = join(input, version);
  if (!existsSync(base)) throw new Error(`${base} not found: download the build of every OS there first`);
  const missing = REQUIRED_OS.filter((os) => !existsSync(join(base, os, SUMMARY_FILE)));
  if (missing.length) throw new Error(`the release lacks ${missing.join(', ')} (no ${SUMMARY_FILE} in ${missing.map((os) => join(base, os)).join(', ')}): a channel names one version for every OS, so publishing it would withdraw the offer from those users`);
  const builds = [];
  for (const os of REQUIRED_OS) builds.push(await verifyOsFolder(join(base, os), os));
  const versions = builds.filter((build) => build.version !== version);
  if (versions.length) throw new Error(`versions differ: expected ${version}, found ${versions.map((build) => `${build.os} ${build.version}`).join(', ')}`);
  // The tag, the notes and the manifests name one commit.
  const commits = new Set(builds.map((build) => build.commit));
  if (commits.size > 1) throw new Error(`the builds come from different commits: ${builds.map((build) => `${build.os} ${build.commit.slice(0, 12)}`).join(', ')}`);
  return builds;
}

export function planAssets(builds, { repo, tag }) {
  const assets = [];
  const keys = new Set();
  const names = new Set();
  for (const build of builds) {
    for (const file of build.files) {
      if (!isInstaller(build.os, file.name)) continue;
      const key = artifactKey(build.os, file.name, build.arch);
      const asset = assetName(file.name);
      if (keys.has(key)) throw new Error(`two installers for ${key}; the updater could not choose`);
      if (names.has(asset)) throw new Error(`two installers would share the asset name ${asset}`);
      keys.add(key);
      names.add(asset);
      assets.push({ key, os: build.os, name: file.name, asset, size: file.size, sha256: file.sha256, file: join(build.dir, file.name), url: assetUrl(repo, tag, asset) });
    }
  }
  for (const [os, formats] of Object.entries(REQUIRED_FORMATS)) {
    for (const format of formats) {
      if (!assets.some((asset) => asset.os === os && asset.key.endsWith(`-${format}`))) throw new Error(`${os}: no ${format} installer; the one-line installers need it`);
    }
  }
  return assets;
}

/** The changelog section of this version (for an rc: the `Unreleased` fragments of its commit), as text. */
export function notesFor(changelog, version) {
  return createReleaseNotes(changelog, version).entries.find((entry) => entry.version === version)?.content ?? '';
}

export function channelEntry({ version, assets, notes, publishedAt }) {
  return {
    version,
    publishedAt,
    notesUrl: CHANGELOG_URL,
    notes: boundNotes(notes),
    artifacts: Object.fromEntries(assets.map((a) => [a.key, { name: a.asset, url: a.url, size: a.size, sha256: a.sha256 }])),
  };
}

/** Environment without the release secrets, for any child process. */
export function withoutSecrets(env) {
  const clean = { ...env };
  for (const name of [ED25519_KEY_ENV, P256_KEY_ENV, ...TOKEN_ENVS]) delete clean[name];
  return clean;
}

/**
 * CHANGELOG.md at the built commit, with that commit's changelog fragments
 * (`changes/`) rendered as its `Unreleased` section.
 */
export function changelogAt(root, commit, env = process.env) {
  const result = spawnSync('git', ['show', `${commit}:CHANGELOG.md`], { cwd: root, env: withoutSecrets(env), encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`cannot read CHANGELOG.md at ${commit}: ${result.error?.message ?? result.stderr.trim()}`);
  return withUnreleased(result.stdout, readFragmentsAt(root, commit));
}

/**
 * The last manifest published, verified with the current key before any of
 * it is carried into the next one: an unverifiable file would otherwise be
 * re-signed as ours.
 */
export function readPrevious(file, keyring) {
  if (!existsSync(file)) return null;
  try { return verifyReleaseManifest(readFileSync(file), keyring, { allowExpired: true }); }
  catch (error) { throw new Error(`cannot verify the last manifest ${file} (${error.message}); restore the published one, or move it aside to start the channels afresh`); }
}

/** The keyIds install.sh pins, or null where it pins none. */
export function readPinnedKeyIds(root = ROOT) {
  const file = join(root, 'scripts', 'install.sh');
  if (!existsSync(file)) return { ed25519: null, p256: null };
  const text = readFileSync(file, 'utf8');
  const pin = (name) => text.match(new RegExp(`^${name}='([^']*)'$`, 'm'))?.[1] || null;
  return { ed25519: pin('RELEASE_KEY_ID'), p256: pin('RELEASE_P256_KEY_ID') };
}

/** The PEM text of a key secret: the PEM itself (real or `\n`-escaped newlines), or its base64. */
export function decodeKeySecret(value, name) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${name} is not set`);
  if (text.startsWith('-----BEGIN ')) return text.replace(/\\n/g, '\n');
  if (/^[A-Za-z0-9+/=\s]+$/.test(text)) {
    const decoded = Buffer.from(text.replace(/\s+/g, ''), 'base64').toString('utf8').trim();
    if (decoded.startsWith('-----BEGIN ')) return decoded;
  }
  throw new Error(`${name} must hold a PKCS#8 PEM private key, or the base64 of that PEM`);
}

function keyFromSecret(value, name, pairOf, kind) {
  const pem = decodeKeySecret(value, name);
  let privateKey;
  // The parser's own message is dropped: it is not meant to quote the key,
  // but nothing here relies on that.
  try { privateKey = createPrivateKey(pem); } catch { throw new Error(`${name} is not a readable private key`); }
  const publicPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  try { return pairOf(pem, publicPem); } catch { throw new Error(`${name} must be an ${kind} private key`); }
}

/** `{ keys, p256 }` from the environment; a missing secret is null, a malformed one throws. */
export function keysFromEnv(env = process.env) {
  return {
    keys: env[ED25519_KEY_ENV]?.trim() ? keyFromSecret(env[ED25519_KEY_ENV], ED25519_KEY_ENV, releaseKeyPair, 'Ed25519') : null,
    p256: env[P256_KEY_ENV]?.trim() ? keyFromSecret(env[P256_KEY_ENV], P256_KEY_ENV, p256KeyPair, 'ECDSA P-256') : null,
  };
}

/**
 * Every form a secret of `env` could take in a message: the raw values, the
 * decoded PEM, each base64 line of it.
 */
export function secretValues(env = process.env) {
  const values = new Set();
  for (const name of TOKEN_ENVS) if (env[name]) values.add(env[name]);
  for (const name of [ED25519_KEY_ENV, P256_KEY_ENV]) {
    const raw = env[name]?.trim();
    if (!raw) continue;
    values.add(raw);
    for (const line of raw.split(/\r?\n|\\n/)) if (line.trim().length >= 16) values.add(line.trim());
    try {
      const pem = decodeKeySecret(raw, name);
      values.add(pem);
      for (const line of pem.split('\n')) if (line.trim().length >= 16 && !line.startsWith('-----')) values.add(line.trim());
    } catch { /* malformed: the raw value is already covered */ }
  }
  return [...values].filter((value) => value.length >= 8).sort((a, b) => b.length - a.length);
}

export function redactor(secrets) {
  return (text) => secrets.reduce((out, secret) => out.split(secret).join('***'), String(text));
}

/** null when the repository is not set; the token is non-enumerable, so printing the config never shows it. */
export function readGithubConfig(env = process.env, { requireToken = true } = {}) {
  const repo = env[REPO_ENV]?.trim();
  if (!repo) return null;
  if (!REPO.test(repo) || repo.endsWith('.git')) throw new Error(`${REPO_ENV} must be <owner>/<name>`);
  const token = TOKEN_ENVS.map((name) => env[name]).find(Boolean);
  if (!token && requireToken) throw new Error(`no GitHub token: set ${TOKEN_ENVS.join(' or ')} to a token allowed to write the releases of ${repo}`);
  const config = { repo };
  Object.defineProperty(config, 'token', { value: token ?? null, enumerable: false });
  return config;
}

/** The release REST calls this script needs, through `fetch`. */
export function githubClient({ repo, token, fetch: fetchImpl = globalThis.fetch, redact = (text) => text }) {
  const base = `${API_URL}/repos/${repo}`;
  async function call(method, url, { body, contentType = 'application/json', ok = [200], allow404 = false } = {}) {
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'timon-release-publish', Authorization: `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = contentType;
    const where = `${method} ${new URL(url).pathname}`;
    let response;
    try { response = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : contentType === 'application/json' ? JSON.stringify(body) : body }); }
    catch (error) { throw new Error(`GitHub ${where}: ${redact(error?.message ?? error)}`); }
    if (allow404 && response.status === 404) return null;
    const text = await response.text();
    if (!ok.includes(response.status)) {
      let message = text;
      try { message = JSON.parse(text).message ?? text; } catch { /* not JSON: the raw text */ }
      throw new Error(`GitHub ${where} answered ${response.status}: ${redact(String(message).slice(0, 300))}`);
    }
    if (!text) return null;
    try { return JSON.parse(text); } catch { throw new Error(`GitHub ${where}: the answer is not JSON`); }
  }
  async function pages(url) {
    const all = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = await call('GET', `${url}${url.includes('?') ? '&' : '?'}per_page=${PAGE}&page=${page}`);
      if (!Array.isArray(batch)) throw new Error(`GitHub GET ${new URL(url).pathname}: expected a list`);
      all.push(...batch);
      if (batch.length < PAGE) return all;
    }
    throw new Error(`GitHub GET ${new URL(url).pathname}: more than ${MAX_PAGES} pages`);
  }
  return {
    /** The release of `tag`, drafts included (the by-tag endpoint hides drafts). */
    async findRelease(tag) {
      return (await pages(`${base}/releases`)).find((release) => release.tag_name === tag) ?? null;
    },
    /** The commit a tag points to, or null when the tag does not exist yet. */
    async tagCommit(tag) {
      let ref = await call('GET', `${base}/git/ref/tags/${encodeURIComponent(tag)}`, { allow404: true });
      if (!ref) return null;
      let object = ref.object;
      for (let depth = 0; object?.type === 'tag' && depth < 5; depth++) object = (await call('GET', `${base}/git/tags/${object.sha}`)).object;
      return object?.type === 'commit' ? object.sha : null;
    },
    createDraft({ tag, commit, name, body, prerelease }) {
      return call('POST', `${base}/releases`, { body: { tag_name: tag, target_commitish: commit, name, body, draft: true, prerelease, make_latest: prerelease ? 'false' : 'true' }, ok: [201] });
    },
    listAssets(id) {
      return pages(`${base}/releases/${id}/assets`);
    },
    deleteAsset(id) {
      return call('DELETE', `${base}/releases/assets/${id}`, { ok: [204] });
    },
    // The installer is read whole: fetch then sends its exact length, which the
    // upload endpoint requires, and the runner has the memory for it.
    uploadAsset(id, asset, file) {
      return call('POST', `${UPLOADS_URL}/repos/${repo}/releases/${id}/assets?name=${encodeURIComponent(asset)}`, { body: readFileSync(file), contentType: 'application/octet-stream', ok: [201] });
    },
    // The tag is created here, on the built commit: a draft made by an
    // earlier run may name another one.
    publish(id, { commit, prerelease }) {
      return call('PATCH', `${base}/releases/${id}`, { body: { draft: false, target_commitish: commit, prerelease, make_latest: prerelease ? 'false' : 'true' } });
    },
  };
}

// GitHub reports an asset digest as `sha256:<hex>` on recent releases; older
// assets have none, and then the size is all that can be compared here — the
// updater still checks the signed sha256 of what it downloads.
function sameAsset(remote, asset) {
  if (remote.state && remote.state !== 'uploaded') return false;
  if (remote.size !== asset.size) return false;
  return !remote.digest || remote.digest === `sha256:${asset.sha256}`;
}

function writeAtomic(file, text) {
  const temp = `${file}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, file);
}

/**
 * Signs and verifies both manifests in memory. `keys` may be null in a dry
 * run only; `p256` too.
 */
export function signManifests({ entry, previousFile, keys, p256, pins, now, validDays }) {
  if (pins?.ed25519 && keys && keys.keyId !== pins.ed25519) throw new Error(`${ED25519_KEY_ENV} is the key ${keys.keyId}, but the clients pin ${pins.ed25519}: no installed Timon would accept this manifest`);
  if (pins?.p256 && p256 && p256.keyId !== pins.p256) throw new Error(`${P256_KEY_ENV} is the key ${p256.keyId}, but the installers pin ${pins.p256}`);
  if (!keys) return { payload: null, envelope: null, installEnvelope: null, changed: [] };
  const keyring = [{ keyId: keys.keyId, publicKey: keys.publicKey }];
  const previous = readPrevious(previousFile, keyring);
  const { payload, changed } = composeReleasesPayload({ previous, entry, now, validDays });
  const envelope = signReleasesPayload(payload, keys);
  verifyReleaseManifest(envelope, keyring, { now });
  let installEnvelope = null;
  if (p256) {
    installEnvelope = addInstallSignature(envelope, p256);
    verifyInstallManifest(installEnvelope, keyring, { keyId: p256.keyId, publicKey: p256.publicKey }, { now });
  }
  return { payload, envelope, installEnvelope, changed };
}

/**
 * Everything after the inputs are verified: sign, then (unless dry-run)
 * create or complete the release, publish it, and write the manifests.
 */
export async function publish({ version, builds, config, keys, p256, pins = null, changelog, manifestsDir, previousFile, draft = false, dryRun = false, validDays = DEFAULT_VALID_DAYS, now = new Date() }, { fetch = globalThis.fetch, print = console.log, redact = (text) => text } = {}) {
  const say = (text) => print(PREFIX + text);
  const tag = releaseTag(version);
  const prerelease = isPrerelease(version);
  const commit = builds[0].commit;
  const assets = planAssets(builds, { repo: config.repo, tag });
  const notes = notesFor(changelog, version);
  const entry = channelEntry({ version, assets, notes, publishedAt: now.toISOString() });
  if (!dryRun && !draft && (!keys || !p256)) throw new Error(`both signing keys are required to publish: set ${ED25519_KEY_ENV} and ${P256_KEY_ENV}`);
  const signed = signManifests({ entry, previousFile, keys, p256, pins, now, validDays });
  const target = join(manifestsDir, RELEASES_FILE);
  const installTarget = join(manifestsDir, INSTALL_RELEASES_FILE);

  say(`${config.repo}, release ${tag}${prerelease ? ' (prerelease)' : ''} at ${commit}, channel(s) ${channelsFor(version).join(' + ')}${draft ? ', kept as a draft' : ''}`);
  for (const asset of assets) say(`  ${asset.key}: ${asset.asset} (${asset.size} bytes, sha256 ${asset.sha256})`);
  say(`notes: ${entry.notes ? `${entry.notes.split('\n').length} line(s) from the changelog` : 'none found in the changelog'}`);
  if (signed.envelope) {
    say(`${RELEASES_FILE}: keyId ${keys.keyId}, changes ${signed.changed.join(' + ')}, valid until ${signed.payload.expiresAt}`);
    for (const [name, channel] of Object.entries(signed.payload.channels)) say(`  ${name}: ${channel.version}`);
  } else say(dryRun ? `[dry-run] ${ED25519_KEY_ENV} not set: the manifests would not be signed` : `${ED25519_KEY_ENV} not set: a draft run signs no manifest`);
  if (signed.installEnvelope) say(`${INSTALL_RELEASES_FILE}: P-256 keyId ${p256.keyId}`);
  else if (signed.envelope) say(`[dry-run] ${P256_KEY_ENV} not set: ${INSTALL_RELEASES_FILE} would not be signed`);

  if (dryRun) {
    say(`[dry-run] would create or complete ${tag}, upload ${assets.length} installer(s)${draft ? ', keep it a draft and write no manifest' : `, publish it, and write ${target} and ${installTarget}`}`);
    say('[dry-run] no network used, nothing written');
    return { published: false, assets, ...signed };
  }

  const github = githubClient({ repo: config.repo, token: config.token, fetch, redact });
  const tagged = await github.tagCommit(tag);
  if (tagged && tagged !== commit) throw new Error(`the tag ${tag} already points to ${tagged}, not to the built commit ${commit}`);
  let release = await github.findRelease(tag);
  if (!release) {
    release = await github.createDraft({ tag, commit, name: `Timon ${version}`, body: entry.notes || `Timon ${version}`, prerelease });
    say(`created ${tag} as a draft`);
  } else say(`completing ${tag} (${release.draft ? 'draft' : 'published'})`);
  // A published release gets its manifests in this run, which a keyless
  // draft run cannot sign: stop before touching its assets.
  if (!release.draft && !signed.installEnvelope) throw new Error(`${tag} is already published: its manifests need ${ED25519_KEY_ENV} and ${P256_KEY_ENV}, run without --draft`);
  const present = new Map((await github.listAssets(release.id)).map((asset) => [asset.name, asset]));
  for (const asset of assets) {
    const remote = present.get(asset.asset);
    if (remote && sameAsset(remote, asset)) { say(`  ${asset.asset}: already uploaded`); continue; }
    if (remote) {
      // A published asset never changes: someone may have it already. A
      // draft's, or an upload cut short, nobody has.
      if (!release.draft && remote.state === 'uploaded') throw new Error(`${tag} already holds a different ${asset.asset}; a published asset never changes, use a new version`);
      await github.deleteAsset(remote.id);
      say(`  ${asset.asset}: replaced the ${remote.state === 'uploaded' ? 'draft\'s different' : 'incomplete'} copy`);
    }
    say(`  uploading ${asset.asset} (${asset.size} bytes)`);
    await github.uploadAsset(release.id, asset.asset, asset.file);
  }
  const after = new Map((await github.listAssets(release.id)).map((asset) => [asset.name, asset]));
  for (const asset of assets) if (!after.has(asset.asset) || !sameAsset(after.get(asset.asset), asset)) throw new Error(`${asset.asset} is not on ${tag} as uploaded; nothing published`);

  if (release.draft && !draft) {
    release = await github.publish(release.id, { commit, prerelease });
    say(`published ${tag}`);
  }
  if (release.draft) {
    say(`${tag} stays a draft: no manifest written (its download URLs are not public yet). Run again without --draft to publish it`);
    return { published: false, release, assets, ...signed };
  }
  writeAtomic(installTarget, serializeEnvelope(signed.installEnvelope));
  say(`wrote ${installTarget}`);
  writeAtomic(target, serializeEnvelope(signed.envelope));
  say(`wrote ${target}`);
  say(`the site serves them from main at ${RELEASES_URL} and ${INSTALL_RELEASES_URL}`);
  return { published: true, release, assets, target, installTarget, ...signed };
}

export async function main(args = process.argv.slice(2), { env = process.env, root = ROOT, now = new Date(), fetch = globalThis.fetch, print = console.log, readChangelog = changelogAt, pins = undefined } = {}) {
  const redact = redactor(secretValues(env));
  const safePrint = (text) => print(redact(text));
  try {
    const opts = parseArgs(args, root);
    if (inMission(env) && !opts.dryRun) throw new Error('Refused inside a Timon mission: publishing reaches every user; run it from the release workflow (--dry-run is allowed)');
    const config = readGithubConfig(env, { requireToken: !opts.dryRun });
    if (!config) throw new Error(`${REPO_ENV} is not set: it names the repository that receives the release (<owner>/<name>)`);
    const builds = await verifyBuilds(opts.input, opts.version);
    const keyPairs = keysFromEnv(env);
    if (!opts.dryRun && !opts.draft && (!keyPairs.keys || !keyPairs.p256)) throw new Error(`both signing keys are required to publish: set ${ED25519_KEY_ENV} and ${P256_KEY_ENV}`);
    const changelog = readChangelog(root, builds[0].commit, env);
    return await publish({
      version: opts.version, builds, config, ...keyPairs, pins: pins === undefined ? readPinnedKeyIds(root) : pins, changelog,
      manifestsDir: opts.manifestsDir, previousFile: opts.previous, draft: opts.draft, dryRun: opts.dryRun, validDays: opts.validDays, now,
    }, { fetch, print: safePrint, redact });
  } catch (error) {
    throw new Error(redact(error?.message ?? error));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // main reads its own copy; git, spawned for the notes, inherits none of the secrets.
  const env = { ...process.env };
  for (const name of [ED25519_KEY_ENV, P256_KEY_ENV, ...TOKEN_ENVS]) delete process.env[name];
  main(process.argv.slice(2), { env }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
