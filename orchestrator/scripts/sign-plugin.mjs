#!/usr/bin/env node
/**
 * `timon plugin sign <dir>`: signs the files `npm pack` ships with the key of
 * ~/.timon-signing/plugins.key. The work is in dist/plugins/sign.js, which
 * shares its file lister with `timon plugin check`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function fail(message, code = 1) {
  process.stderr.write(`timon plugin sign: ${message}\n`);
  process.exit(code);
}

if (!process.argv[2]) fail('usage: timon plugin sign <plugin-dir>', 64);
const dir = resolve(process.argv[2]);
const keyFile = join(homedir(), '.timon-signing', 'plugins.key');
if (!existsSync(keyFile)) {
  fail(`private key missing: ${keyFile} — create an Ed25519 key outside the repository (chmod 0600)`);
}

const moduleUrl = new URL('../dist/plugins/sign.js', import.meta.url);
let mod;
try {
  mod = await import(moduleUrl.href);
} catch (e) {
  if (e?.code === 'ERR_MODULE_NOT_FOUND' && String(e.message).includes(fileURLToPath(moduleUrl))) {
    fail('dist/plugins/sign.js not found — run `npm run build` in orchestrator/.');
  }
  throw e;
}

try {
  const out = await mod.signPluginFolder(dir, {
    privateKey: readFileSync(keyFile, 'utf8'),
    keyId: process.env.TIMON_PLUGIN_SIGNING_KEY_ID || undefined,
  });
  process.stdout.write(`SIGNATURE written (${out.keyId}, ${out.hash}): ${out.files.length} file(s), the ones npm pack ships\n`);
  if (!out.signatureShips) {
    process.stderr.write(
      'warning: npm pack does not ship SIGNATURE: an archive packed from this folder reaches the recipient unsigned.\n'
      + 'Add "SIGNATURE" to `files` in package.json, then sign again.\n',
    );
  }
} catch (e) {
  if (e?.name === 'PluginSignError') fail(e.message);
  throw e;
}
