#!/usr/bin/env node
/**
 * Composes and signs the notice feed the apps read, `timon-notices.json`
 * (scripts/notices-feed.mjs), to announce something without a release.
 *
 *   node scripts/release/sign-notices.mjs --source <file> [--output <file>] [--valid-days N] [--key-file <pem>] [--dry-run]
 *
 *  1. reads `--source`, `{ "notices": [ ... ] }`: the notices as they will be
 *     shown, nothing else (no dates of the feed, no key);
 *  2. reads the feed last written at `--output` (the checkout root's
 *     `timon-notices.json` by default), verified with the signing key before it
 *     is trusted: the new feed must be issued after it, or the apps that read it
 *     would refuse the new one as a replay. An unverifiable file stops the run;
 *  3. signs the next feed with the release key (the one `releases.json` is
 *     signed with, under a domain of its own), verifies it as the apps will,
 *     and writes it to `--output`. Publishing it means having the site serve
 *     that file byte for byte at NOTICES_URL.
 *
 * The key: TIMON_RELEASE_ED25519_KEY (the release workflow's secret: the PKCS#8
 * PEM text, or its base64 on one line), or `--key-file`, a PEM file kept
 * outside any checkout. Its keyId must be the one the clients pin
 * (scripts/install.sh, the daemon keyring), or no installed Timon would read
 * the feed. The key never reaches a log line or an error.
 *
 * A real run is refused inside a Timon mission: a signed feed reaches every
 * user once it is served. `--dry-run` checks the source and prints the plan,
 * with no key and nothing written.
 */
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { releaseKeyPair } from '../release-manifest.mjs';
import {
  DEFAULT_NOTICES_VALID_DAYS, NOTICES_URL, composeNoticesPayload, signNoticesPayload, verifyNoticesFeed,
} from '../notices-feed.mjs';
import { ED25519_KEY_ENV, ROOT, decodeKeySecret, inMission, readPinnedKeyIds, redactor, secretValues } from './publish.mjs';
export const NOTICES_FILE = 'timon-notices.json';
const USAGE = 'Usage: node scripts/release/sign-notices.mjs --source <file> [--output <file>] [--valid-days N] [--key-file <pem>] [--dry-run]';

export function parseArgs(args, root = ROOT) {
  const opts = { source: null, output: join(root, NOTICES_FILE), keyFile: null, validDays: DEFAULT_NOTICES_VALID_DAYS, dryRun: false };
  const paths = { '--source': 'source', '--output': 'output', '--key-file': 'keyFile' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--valid-days' || Object.hasOwn(paths, arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value\n${USAGE}`);
      if (arg === '--valid-days') {
        if (!/^[1-9]\d{0,2}$/.test(value) || Number(value) > 365) throw new Error('--valid-days must be 1 to 365');
        opts.validDays = Number(value);
      } else opts[paths[arg]] = resolve(value);
    } else throw new Error(`Unexpected argument: ${arg}\n${USAGE}`);
  }
  if (!opts.source) throw new Error(`--source is required\n${USAGE}`);
  return opts;
}

/** The notices of the source file; any other field is refused, so nobody believes they set the dates there. */
export function readSource(file) {
  let source;
  try { source = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { throw new Error(`cannot read the source ${file}: ${error.message}`); }
  if (source === null || typeof source !== 'object' || Array.isArray(source)) throw new Error(`${file} must be an object { "notices": [ ... ] }`);
  const extra = Object.keys(source).filter((key) => key !== 'notices');
  if (extra.length) throw new Error(`${file}: unexpected field ${extra[0]} (the feed's dates come from --valid-days)`);
  if (!Array.isArray(source.notices)) throw new Error(`${file} must list its notices under "notices"`);
  return source.notices;
}

const inside = (child, parent) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** The release pair from the environment, else from `--key-file`; `null` when neither is given. */
export function signingKey({ env = process.env, keyFile = null, root = ROOT }) {
  let pem;
  if (env[ED25519_KEY_ENV]?.trim()) pem = decodeKeySecret(env[ED25519_KEY_ENV], ED25519_KEY_ENV);
  else if (keyFile) {
    // A key under the checkout is one `git add -A` away from being published.
    if (inside(keyFile, root)) throw new Error(`--key-file ${keyFile} lies inside the checkout; keep the release key outside any repository`);
    try { pem = readFileSync(keyFile, 'utf8'); } catch { throw new Error(`cannot read --key-file ${keyFile}`); }
  } else return null;
  let privateKey;
  // The parser's own message is dropped: it is not meant to quote the key, but nothing here relies on that.
  try { privateKey = createPrivateKey(pem); } catch { throw new Error('the release key is not a readable private key'); }
  const publicPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  try { return releaseKeyPair(pem, publicPem); } catch { throw new Error('the release key must be an Ed25519 private key'); }
}

/** The last feed written, verified with the signing key; `null` when there is none. */
export function readPrevious(file, keyring) {
  if (!existsSync(file)) return null;
  try { return verifyNoticesFeed(readFileSync(file), keyring, { allowExpired: true }); }
  catch (error) { throw new Error(`cannot verify the last feed ${file} (${error.message}); restore the published one, or move it aside to start afresh`); }
}

export function signFeed({ notices, keys, pins = null, previousFile, now = new Date(), validDays = DEFAULT_NOTICES_VALID_DAYS }) {
  if (pins?.ed25519 && keys.keyId !== pins.ed25519) throw new Error(`the release key is ${keys.keyId}, but the clients pin ${pins.ed25519}: no installed Timon would accept this feed`);
  const keyring = [{ keyId: keys.keyId, publicKey: keys.publicKey }];
  const previous = readPrevious(previousFile, keyring);
  const payload = composeNoticesPayload({ notices, previous, now, validDays });
  const envelope = signNoticesPayload(payload, keys);
  const text = JSON.stringify(envelope, null, 2) + '\n';
  // Read back exactly as an app would, against the feed it replaces.
  verifyNoticesFeed(text, keyring, { now, minIssuedAt: previous?.issuedAt ?? null });
  return { payload, text };
}

export function main(args = process.argv.slice(2), { env = process.env, root = ROOT, now = new Date(), print = console.log, pins = undefined } = {}) {
  const redact = redactor(secretValues(env));
  try {
    const opts = parseArgs(args, root);
    if (inMission(env) && !opts.dryRun) throw new Error('Refused inside a Timon mission: a signed feed reaches every user once served (--dry-run is allowed)');
    const notices = readSource(opts.source);
    if (opts.dryRun) {
      const payload = composeNoticesPayload({ notices, now, validDays: opts.validDays });
      print(`dry run: ${payload.notices.length} notice(s), valid until ${payload.expiresAt}; nothing signed nor written`);
      for (const notice of payload.notices) print(`  ${notice.id} (${notice.tone}): ${notice.title}`);
      return { written: false, payload };
    }
    const keys = signingKey({ env, keyFile: opts.keyFile, root });
    if (!keys) throw new Error(`no release key: set ${ED25519_KEY_ENV}, or pass --key-file`);
    const { payload, text } = signFeed({
      notices, keys, pins: pins === undefined ? readPinnedKeyIds(root) : pins, previousFile: opts.output, now, validDays: opts.validDays,
    });
    const tmp = join(dirname(opts.output), `.${NOTICES_FILE}.tmp`);
    writeFileSync(tmp, text);
    renameSync(tmp, opts.output);
    print(`wrote ${opts.output}: ${payload.notices.length} notice(s), signed by ${keys.keyId}, valid until ${payload.expiresAt}`);
    print(`serve it byte for byte at ${NOTICES_URL}`);
    return { written: true, payload };
  } catch (error) {
    throw new Error(redact(error?.message ?? error));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
