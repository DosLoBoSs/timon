#!/usr/bin/env node
/**
 * Writes a fresh Ed25519 key pair for ONE package build and points the build
 * at it, for a build that must not hold the release keys (rc.yml).
 *
 *   node scripts/release/throwaway-keys.mjs <parent dir>
 *
 * The package build signs the daemon inventory and embeds the public half as
 * `release-public-key.pem`, which the packaged shell checks at every start
 * (desktop/scripts/prepare-daemon-release.mjs): a pair made on the runner gives
 * a package that starts and checks itself, without any secret. What it cannot
 * give is a package Timon would publish: the update manifest is signed with the
 * pinned release key (orchestrator/src/plugins-bundled/updates/keyring.ts),
 * which a throwaway pair is not. That is the point of a release candidate.
 *
 * The pair goes to a new owner-only folder under <parent dir>, which must lie
 * outside the checkout (build-package.mjs refuses a key inside it). With
 * GITHUB_ENV set, the two file variables are appended to it for the next
 * steps; otherwise they are printed. The private key is never printed.
 */
import { generateKeyPairSync } from 'node:crypto';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { KEY_FILES, KEY_FILE_ENV } from './build-package.mjs';

/** Creates `<parent>/timon-throwaway-keys-XXXXXX/` with the pair; returns the two paths. */
export function writeThrowawayKeys(parent) {
  if (!parent || !isAbsolute(parent)) throw new Error('the parent folder must be an absolute path');
  const dir = mkdtempSync(join(parent, 'timon-throwaway-keys-'));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const files = { privateKey: join(dir, KEY_FILES.privateKey), publicKey: join(dir, KEY_FILES.publicKey) };
  writeFileSync(files.privateKey, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(files.publicKey, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
  return { dir, ...files };
}

/** `NAME=value` lines for GITHUB_ENV; a path with a newline would inject a variable. */
export function envLines(files) {
  for (const file of [files.privateKey, files.publicKey]) if (/[\r\n]/.test(file)) throw new Error('a key path contains a line break');
  return `${KEY_FILE_ENV.privateKey}=${files.privateKey}\n${KEY_FILE_ENV.publicKey}=${files.publicKey}\n`;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.length !== 1) throw new Error('Usage: node scripts/release/throwaway-keys.mjs <parent dir>');
  const files = writeThrowawayKeys(resolve(argv[0]));
  const lines = envLines(files);
  if (env.GITHUB_ENV) appendFileSync(env.GITHUB_ENV, lines);
  else process.stdout.write(lines);
  console.error(`throwaway Ed25519 pair in ${files.dir}`);
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
