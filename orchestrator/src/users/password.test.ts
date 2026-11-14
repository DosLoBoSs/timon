import { randomBytes, scryptSync } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, needsRehash, verifyPassword } from './password.js';

/** A hash as the daemon wrote it before the cost was raised (N=2^14). */
function legacyHash(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

test('new hashes use the OWASP cost (N=2^17, r=8, p=1) and verify', () => {
  const encoded = hashPassword('correct horse');
  assert.match(encoded, /^scrypt\$131072\$8\$1\$/);
  assert.equal(verifyPassword('correct horse', encoded), true);
  assert.equal(verifyPassword('wrong horse', encoded), false);
  assert.equal(needsRehash(encoded), false);
});

test('a hash written with the old cost still verifies and asks for a rehash', () => {
  const old = legacyHash('correct horse');
  assert.equal(verifyPassword('correct horse', old), true);
  assert.equal(verifyPassword('wrong horse', old), false);
  assert.equal(needsRehash(old), true);
});

test('a malformed hash never verifies and asks for a rehash', () => {
  assert.equal(verifyPassword('x', 'bcrypt$whatever'), false);
  assert.equal(needsRehash('bcrypt$whatever'), true);
});

test('a stored cost above the memory cap is refused, not allocated', () => {
  const salt = randomBytes(16).toString('base64url');
  const key = randomBytes(32).toString('base64url');
  assert.equal(verifyPassword('x', `scrypt$1048576$8$1$${salt}$${key}`), false);
});
