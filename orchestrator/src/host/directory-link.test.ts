import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDirectoryLink, linkDirectory, removeDirectoryLink } from './directory-link.js';

const fsError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

test('removing a folder link leaves the folder it points to untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'timon-dirlink-'));
  const target = join(root, 'shared');
  mkdirSync(target);
  writeFileSync(join(target, 'kept.txt'), 'kept');
  const link = join(root, 'link');
  linkDirectory(target, link);
  assert.equal(isDirectoryLink(link), true);
  removeDirectoryLink(link);
  assert.equal(existsSync(link), false);
  assert.equal(readFileSync(join(target, 'kept.txt'), 'utf8'), 'kept');
});

test('a junction Windows holds for a moment is removed on a later attempt', () => {
  const waits: number[] = [];
  let rmdirCalls = 0;
  removeDirectoryLink('C:\\runs\\m1\\cache', {
    platform: 'win32',
    unlink: () => { throw fsError('EPERM'); },
    rmdir: () => { if (++rmdirCalls < 3) throw fsError('EBUSY'); },
    wait: (ms) => waits.push(ms),
  });
  assert.equal(rmdirCalls, 3);
  assert.deepEqual(waits, [25, 50]);
});

test('a lock that outlasts the attempts fails with a readable error that keeps the cause', () => {
  const waits: number[] = [];
  const cause = fsError('EBUSY');
  assert.throws(
    () => removeDirectoryLink('C:\\runs\\m1\\cache', {
      platform: 'win32',
      attempts: 4,
      unlink: () => { throw cause; },
      wait: (ms) => waits.push(ms),
    }),
    (error: Error) => {
      assert.match(error.message, /could not remove the folder link C:\\runs\\m1\\cache: still in use after 4 attempts \(EBUSY\)/);
      assert.equal(error.cause, cause);
      return true;
    },
  );
  assert.deepEqual(waits, [25, 50, 100]);
  // The default budget stays under a second: the callers block the daemon while they wait.
  const defaults: number[] = [];
  assert.throws(() => removeDirectoryLink('x', { platform: 'win32', unlink: () => { throw fsError('EBUSY'); }, wait: (ms) => defaults.push(ms) }));
  assert.ok(defaults.reduce((sum, ms) => sum + ms, 0) < 1000);
});

test('an entry that disappears after a refused attempt counts as removed', () => {
  let calls = 0;
  removeDirectoryLink('C:\\runs\\m1\\cache', {
    platform: 'win32',
    unlink: () => { throw fsError(++calls === 1 ? 'EBUSY' : 'ENOENT'); },
    wait: () => {},
  });
  assert.equal(calls, 2);
});

test('a refusal that is not a lock, or any refusal outside Windows, fails at once', () => {
  const waits: number[] = [];
  const missing = fsError('ENOENT');
  assert.throws(() => removeDirectoryLink('C:\\gone', { platform: 'win32', unlink: () => { throw missing; }, wait: (ms) => waits.push(ms) }), (error) => error === missing);
  const denied = fsError('EACCES');
  assert.throws(() => removeDirectoryLink('/runs/m1/cache', { platform: 'linux', unlink: () => { throw denied; }, wait: (ms) => waits.push(ms) }), (error) => error === denied);
  const notEmpty = fsError('ENOTEMPTY');
  assert.throws(() => removeDirectoryLink('C:\\runs\\m1\\cache', {
    platform: 'win32',
    unlink: () => { throw fsError('EPERM'); },
    rmdir: () => { throw notEmpty; },
    wait: (ms) => waits.push(ms),
  }), (error) => error === notEmpty);
  assert.deepEqual(waits, []);
});
