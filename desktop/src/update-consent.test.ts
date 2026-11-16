/**
 * The consent "Restart and install" leaves for the new version
 * (docs/AUTO-UPDATE.md §10): one transition, one day, one use.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  UPDATE_CONSENT_TTL_MS, consentApproves, grantUpdateConsent, revokeUpdateConsent, takeUpdateConsent, updateConsentFile,
} from './update-consent.js';

function home(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-consent-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const NOW = Date.UTC(2026, 10, 16, 20, 0, 0);
const OFFER = { from: '0.1.7', to: '0.1.8' };

test('a valid consent approves exactly its transition, once', (t) => {
  const dir = home(t);
  grantUpdateConsent(dir, OFFER, NOW);
  const consent = takeUpdateConsent(dir);
  assert.ok(consent);
  assert.equal(consentApproves(consent, OFFER, NOW + 60_000), true);
  assert.equal(existsSync(updateConsentFile(dir)), false, 'removed before anything acts on it');
  assert.deepEqual(readdirSync(dir), [], 'nothing left behind');
  assert.equal(takeUpdateConsent(dir), null, 'a replay finds nothing');
});

test('written atomically, owner-only, with its transition and its expiry', { skip: process.platform === 'win32' && 'POSIX modes' }, (t) => {
  const dir = home(t);
  const consent = grantUpdateConsent(dir, OFFER, NOW);
  assert.equal(statSync(updateConsentFile(dir)).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), ['update-consent.json']);
  const stored = JSON.parse(readFileSync(updateConsentFile(dir), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(stored, { ...consent });
  assert.equal(stored.expiresAt, NOW + UPDATE_CONSENT_TTL_MS);
  assert.match(String(stored.id), /^[0-9a-f-]{36}$/);
});

test('an expired consent approves nothing', (t) => {
  const dir = home(t);
  grantUpdateConsent(dir, OFFER, NOW);
  const consent = takeUpdateConsent(dir);
  assert.equal(consentApproves(consent, OFFER, NOW + UPDATE_CONSENT_TTL_MS), false);
  assert.equal(consentApproves(consent, OFFER, NOW + UPDATE_CONSENT_TTL_MS - 1), true);
  // A clock far behind the grant is not a fresh consent either.
  assert.equal(consentApproves(consent, OFFER, NOW - 60 * 60 * 1000), false);
  // Neither is one that claims a longer life than the shell ever writes.
  assert.equal(consentApproves(consent && { ...consent, expiresAt: NOW + 30 * UPDATE_CONSENT_TTL_MS }, OFFER, NOW + 2 * UPDATE_CONSENT_TTL_MS), false);
});

test('a consent for another transition approves nothing', (t) => {
  const dir = home(t);
  grantUpdateConsent(dir, OFFER, NOW);
  const consent = takeUpdateConsent(dir);
  for (const offer of [{ from: '0.1.6', to: '0.1.8' }, { from: '0.1.7', to: '0.1.9' }, { from: '0.1.0', to: '0.1.8' }, { from: '0.1.8', to: '0.1.7' }]) {
    assert.equal(consentApproves(consent, offer, NOW), false, `${offer.from} -> ${offer.to}`);
  }
});

test('no consent, a broken one or a forged shape approves nothing, and is removed all the same', (t) => {
  const dir = home(t);
  assert.equal(takeUpdateConsent(dir), null);
  assert.equal(consentApproves(null, OFFER, NOW), false);
  for (const content of ['{', '{}', JSON.stringify({ ...OFFER, grantedAt: NOW, expiresAt: NOW + 1 }),
    JSON.stringify({ id: crypto.randomUUID(), ...OFFER, grantedAt: NOW, expiresAt: NOW + 1, approve: true })]) {
    writeFileSync(updateConsentFile(dir), content);
    assert.equal(takeUpdateConsent(dir), null, content);
    assert.deepEqual(readdirSync(dir), []);
  }
});

test('revoking removes the consent, and is quiet when there is none', (t) => {
  const dir = home(t);
  revokeUpdateConsent(dir);
  grantUpdateConsent(dir, OFFER, NOW);
  revokeUpdateConsent(dir);
  assert.equal(takeUpdateConsent(dir), null);
});
