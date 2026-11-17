import { createHash, verify as verifyCrypto } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { z } from 'zod';
import { PLUGIN_PUBLIC_KEYS, type PluginPublicKey } from './pubkey.js';

export const PluginSignatureSchema = z.object({
  alg: z.literal('ed25519'),
  keyId: z.string().min(1),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  sig: z.string().min(1),
});
export type PluginSignature = z.infer<typeof PluginSignatureSchema>;

function filesBelow(root: string, dir = root): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(root, path));
    else if (entry.isFile() && !(dir === root && entry.name === 'SIGNATURE')) files.push(path);
    else if (entry.isSymbolicLink()) throw new Error(`symbolic link forbidden in a signed plugin: ${relative(root, path)}`);
  }
  return files;
}

/** The path is part of the digest: renaming a file alters the package. */
export function hashPluginDirectory(root: string): string {
  return hashPluginFiles(root, filesBelow(root).map((file) => relative(root, file).split(sep).join('/')));
}

/**
 * The digest of the given files of `root` (relative, `/`-separated), the very
 * one `hashPluginDirectory` computes when the list is the whole folder. The
 * signer gives the list `npm pack` ships, so a package signed in its working
 * folder verifies once installed from its archive. Sorting `/` paths orders
 * them as the native ones: no character sorts between `/` and `\`.
 */
export function hashPluginFiles(root: string, files: readonly string[]): string {
  const hash = createHash('sha256');
  for (const name of [...files].sort((a, b) => a.localeCompare(b))) {
    // A list from outside the folder must not reach a file beside it.
    if (!name || name.split('/').some((part) => part === '' || part === '.' || part === '..')) {
      throw new Error(`invalid path in the package list: ${name}`);
    }
    const path = join(root, ...name.split('/'));
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) throw new Error(`file missing from the package: ${name}`);
    if (stat.isSymbolicLink()) throw new Error(`symbolic link forbidden in a signed plugin: ${name}`);
    if (!stat.isFile()) throw new Error(`not a regular file: ${name}`);
    hash.update(name, 'utf8');
    hash.update('\0');
    hash.update(readFileSync(path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export type SignatureResult =
  | { ok: true; signature: PluginSignature }
  | { ok: false; code: 'unsigned' | 'tampered'; message: string };

/**
 * `files` restricts the digest to a list (relative, `/`-separated, without
 * `SIGNATURE`): the check of a working folder passes what `npm pack` ships,
 * since its tests and `node_modules` never reach the recipient. Without it,
 * every file of the folder counts, as on an installed package.
 */
export function verifyPluginDirectory(
  root: string,
  keys: readonly PluginPublicKey[] = PLUGIN_PUBLIC_KEYS,
  now = new Date(),
  files?: readonly string[],
): SignatureResult {
  const file = join(root, 'SIGNATURE');
  if (!existsSync(file)) return { ok: false, code: 'unsigned', message: 'SIGNATURE absent' };
  let signature: PluginSignature;
  try {
    signature = PluginSignatureSchema.parse(JSON.parse(readFileSync(file, 'utf8')) as unknown);
  } catch (err) {
    return { ok: false, code: 'unsigned', message: `invalid SIGNATURE: ${(err as Error).message}` };
  }
  const key = keys.find((candidate) => candidate.keyId === signature.keyId);
  if (!key) return { ok: false, code: 'unsigned', message: `unknown signing key: ${signature.keyId}` };
  if (key.expiresAt) {
    const expiry = Date.parse(key.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= now.getTime()) {
      return { ok: false, code: 'unsigned', message: `expired signing key: ${signature.keyId}` };
    }
  }
  let actual: string;
  try { actual = files ? hashPluginFiles(root, files) : hashPluginDirectory(root); }
  catch (err) { return { ok: false, code: 'tampered', message: `package cannot be verified: ${(err as Error).message}` }; }
  if (actual !== signature.hash) {
    return { ok: false, code: 'tampered', message: `package hash differs (expected ${signature.hash}, got ${actual})` };
  }
  try {
    const valid = verifyCrypto(null, Buffer.from(signature.hash, 'hex'), key.publicKey, Buffer.from(signature.sig, 'base64'));
    return valid
      ? { ok: true, signature }
      : { ok: false, code: 'tampered', message: `invalid Ed25519 signature for key ${signature.keyId}` };
  } catch (err) {
    return { ok: false, code: 'tampered', message: `signature cannot be checked: ${(err as Error).message}` };
  }
}
