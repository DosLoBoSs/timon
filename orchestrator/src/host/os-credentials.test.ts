import assert from 'node:assert/strict';
import test from 'node:test';
import { readOsCredential, readOsCredentialNow, removeOsCredential, resetOsCredentialMisses } from './os-credentials.js';
const entry = { service: 'provider-entry' };
const readCredential = (host: Pick<Host, 'platform' | 'exec'>, now?: number) => readOsCredential(host, entry, now);
import type { ExecResult, Host } from './types.js';

function fakeHost(platform: Host['platform'], result: ExecResult, calls: string[][] = []): Pick<Host, 'platform' | 'exec'> {
  return { platform, exec: (name, args) => { calls.push([name, ...args]); return result; } };
}

test('reads the CLI entry on darwin only', () => {
  resetOsCredentialMisses();
  const calls: string[][] = [];
  assert.equal(readCredential(fakeHost('darwin', { code: 0, stdout: '{"a":1}\n', stderr: '' }, calls)), '{"a":1}');
  assert.deepEqual(calls[0], ['security', 'find-generic-password', '-s', 'provider-entry', '-w']);
  assert.equal(readCredential(fakeHost('linux', { code: 0, stdout: 'x', stderr: '' }, calls)), null);
  assert.equal(calls.length, 1, 'no command is run off macOS');
});

test('a miss is remembered for a minute, then asked again', () => {
  resetOsCredentialMisses();
  const calls: string[][] = [];
  const miss = fakeHost('darwin', { code: 44, stdout: '', stderr: 'could not be found' }, calls);
  assert.equal(readCredential(miss, 1_000), null);
  assert.equal(readCredential(miss, 30_000), null);
  assert.equal(calls.length, 1);
  assert.equal(readCredential(miss, 62_000), null);
  assert.equal(calls.length, 2);
  resetOsCredentialMisses();
  assert.equal(readCredential(miss, 62_500), null);
  assert.equal(calls.length, 3);
});

test('an account entry is read now, without the remembered miss of the gauges', () => {
  resetOsCredentialMisses();
  const calls: string[][] = [];
  const miss = fakeHost('darwin', { code: 44, stdout: '', stderr: '' }, calls);
  assert.equal(readCredential(miss, 1_000), null);
  assert.equal(readOsCredentialNow(fakeHost('darwin', { code: 0, stdout: 'secret\n', stderr: '' }, calls), entry), 'secret');
  assert.equal(readOsCredentialNow(fakeHost('linux', { code: 0, stdout: 'x', stderr: '' }, calls), entry), null);
  assert.equal(calls.length, 2, 'no command off macOS');
});

test('removal deletes every copy until none is left, with names only on the command line', () => {
  const calls: string[][] = [];
  const codes = [0, 0, 44];
  const host: Pick<Host, 'platform' | 'exec'> = {
    platform: 'darwin',
    exec: (name, args) => { calls.push([name, ...args]); return { code: codes.shift() ?? 44, stdout: '', stderr: '' }; },
  };
  assert.equal(removeOsCredential(host, { service: 'svc-0123abcd' }), true);
  assert.deepEqual(calls, Array.from({ length: 3 }, () => ['security', 'delete-generic-password', '-s', 'svc-0123abcd']));
  assert.ok(calls.every((call) => !call.includes('-w') && !call.includes('-X')), 'never a secret in argv');
});

test('a refused removal (locked keychain, Seatbelt) answers false; off macOS there is nothing to remove', () => {
  const calls: string[][] = [];
  assert.equal(removeOsCredential(fakeHost('darwin', { code: 161, stdout: '', stderr: 'UNIX[Operation not permitted]' }, calls), entry), false);
  assert.equal(removeOsCredential(fakeHost('darwin', { code: 0, stdout: '', stderr: '' }, calls), entry), false, 'bounded, never an endless loop');
  const throwing: Pick<Host, 'platform' | 'exec'> = { platform: 'darwin', exec: () => { throw new Error('timeout'); } };
  assert.equal(removeOsCredential(throwing, entry), false);
  const before = calls.length;
  assert.equal(removeOsCredential(fakeHost('linux', { code: 0, stdout: '', stderr: '' }, calls), entry), true);
  assert.equal(calls.length, before);
});
