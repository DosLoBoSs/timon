/**
 * Password hashing for user accounts (Phase M.1).
 *
 * argon2id would be the usual choice, but it is not on the allowed
 * dependency list (`CLAUDE.md` rule 7). `scrypt` from `node:crypto` needs
 * nothing installed and is the recipe's fallback (`docs/MULTI-USER.md` §11).
 *
 * Encoding: `scrypt$N$r$p$<salt-b64url>$<key-b64url>`. The parameters travel
 * with the hash so a later cost bump does not invalidate existing rows.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEYLEN = 32;
const SALTLEN = 16;
/**
 * OWASP's current floor for scrypt (N=2^17, r=8, p=1): 128 MiB of memory and
 * about 200 ms per hash — paid once per sign-in, not on a hot path. Hashes
 * written with an older, lower cost keep verifying and are rewritten at the
 * next successful sign-in (`needsRehash`).
 */
const N = 131_072;
const R = 8;
const P = 1;
/**
 * scrypt needs 128 * N * r bytes, exactly 128 MiB here, and OpenSSL refuses a
 * limit equal to the need. 256 MiB leaves room for the current cost and caps
 * what a stored hash can make the daemon allocate.
 */
const MAXMEM = 256 * 1024 * 1024;

export class PasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasswordError';
  }
}

export function hashPassword(password: string): string {
  if (password.length === 0) throw new PasswordError('password must not be empty');
  const salt = randomBytes(SALTLEN);
  const key = scryptSync(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** One-shot password for a superadmin reset. Shown once, communicated out of band. */
export function generateTemporaryPassword(): string {
  return randomBytes(18).toString('base64url');
}

/**
 * True when `encoded` was written with a cost other than the current one (or
 * is not a scrypt hash this module wrote). Call it only after `verifyPassword`
 * succeeded, with the plain password at hand, to store a fresh hash.
 */
export function needsRehash(encoded: string): boolean {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  return Number(parts[1]) !== N || Number(parts[2]) !== R || Number(parts[3]) !== P;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (n < 2 || r < 1 || p < 1) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] ?? '', 'base64url');
    expected = Buffer.from(parts[5] ?? '', 'base64url');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  let key: Buffer;
  try {
    key = scryptSync(password, salt, expected.length, { N: n, r, p, maxmem: MAXMEM });
  } catch {
    return false;
  }
  if (key.length !== expected.length) return false;
  return timingSafeEqual(key, expected);
}
