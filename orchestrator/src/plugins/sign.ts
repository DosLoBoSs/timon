/**
 * `timon plugin sign <dir>` (TODO #922): writes `SIGNATURE` over the files
 * `npm pack` ships, the ones `timon plugin add` installs from the archive.
 * Hashing the whole folder broke on a working folder: its `node_modules/.bin`
 * links stopped the signer, and once past them the signature covered tests
 * and dependencies the recipient never gets, so the installed package read as
 * altered. An already packed folder (an extracted archive) ships all of its
 * files, so its signature is the one the whole-folder hash gave.
 *
 * The list comes from the lister of `timon plugin check` (`npmPackLister`),
 * which never runs a script of the plugin. Without npm the signer stops:
 * hashing the folder instead would produce a signature that fails once the
 * package is installed.
 */
import { sign } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { npmPackLister, type PackLister } from './preship-check.js';
import { hashPluginFiles } from './signature.js';

/** The key id a signature carries when none is given: the production key. */
export const DEFAULT_PLUGIN_SIGNING_KEY_ID = 'timon-plugins-2026-11';

/** Outside every repository on purpose; mode 0600. */
export function pluginSigningKeyFile(home = homedir()): string {
  return join(home, '.timon-signing', 'plugins.key');
}

/** A refusal meant for the person signing: its message is the whole answer. */
export class PluginSignError extends Error {
  override name = 'PluginSignError';
}

export type SignOptions = {
  /** PEM of the Ed25519 private key. */
  privateKey: string;
  keyId?: string;
  pack?: PackLister;
};

export type SignOutcome = {
  keyId: string;
  hash: string;
  /** What the signature covers: relative, `/`-separated, sorted. */
  files: string[];
  /**
   * Whether `npm pack` ships `SIGNATURE` itself. It does not when `files` leaves
   * it out: an archive packed from this folder then reaches the recipient
   * unsigned, while the folder installed as it stands is still signed.
   */
  signatureShips: boolean;
};

export async function signPluginFolder(dir: string, opts: SignOptions): Promise<SignOutcome> {
  if (!existsSync(join(dir, 'package.json'))) {
    throw new PluginSignError(`no package.json in ${dir}: sign the folder of an npm package`);
  }
  const pack = opts.pack ?? npmPackLister;
  const keyId = opts.keyId || DEFAULT_PLUGIN_SIGNING_KEY_ID;
  const files = shippedFiles(await pack(dir)).filter((f) => f !== 'SIGNATURE');

  let hash: string;
  try { hash = hashPluginFiles(dir, files); }
  catch (err) { throw new PluginSignError(`cannot sign this package: ${(err as Error).message}`); }
  let sig: string;
  try { sig = sign(null, Buffer.from(hash, 'hex'), opts.privateKey).toString('base64'); }
  catch (err) { throw new PluginSignError(`the private key cannot sign: ${(err as Error).message}`); }
  writeFileSync(join(dir, 'SIGNATURE'), `${JSON.stringify({ alg: 'ed25519', keyId, hash, sig }, null, 2)}\n`, { mode: 0o644 });

  // npm lists only files that exist: whether SIGNATURE ships is known once written.
  const after = await pack(dir);
  const signatureShips = Boolean(after && 'files' in after && after.files.some((f) => toSlash(f) === 'SIGNATURE'));
  return { keyId, hash, files, signatureShips };
}

function shippedFiles(listed: Awaited<ReturnType<PackLister>>): string[] {
  if (listed === null) {
    throw new PluginSignError('npm could not be run: the signature covers the files `npm pack` ships, and only npm can list them. Install Node.js with npm (or put npm on the PATH), then sign again.');
  }
  if ('error' in listed) throw new PluginSignError(`npm pack refused this package: ${listed.error}`);
  if (!listed.files.length) throw new PluginSignError('npm pack lists no file for this package');
  return listed.files.map(toSlash).sort((a, b) => a.localeCompare(b));
}

function toSlash(path: string): string {
  return path.split('\\').join('/');
}
