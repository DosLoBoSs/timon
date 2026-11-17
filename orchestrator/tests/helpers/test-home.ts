/**
 * Test-only: remove a throwaway TIMON_HOME once the test file is done.
 *
 * Windows refuses to delete a file that still has an open handle, and a test
 * that loaded the db module still holds `timon.db` when its `exit` listener
 * runs: the plain `rmSync` threw EBUSY there and failed a file whose subtests
 * had all passed (#947, group C). So the database is closed first when the file
 * loaded it, and on win32 a removal still refused (a plugin database, a virus
 * scanner) is reported and left to the system's temp cleanup instead of failing
 * the run. Elsewhere a failed removal still throws: it would point at a leak.
 */
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

type Closable = { readonly open: boolean; close(): unknown };

/** What Windows answers while a handle is open somewhere under the folder. */
const HELD_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY']);

export function removeHomeOnExit(home: string): void {
  let database: Closable | null = null;
  let looked = false;
  // The db module opens timon.db as it loads, and the code under test loads it
  // lazily: the file is the sign it is in memory, and importing it again then
  // costs nothing (the module is cached). An `exit` listener cannot await, so
  // the handle is fetched once the event loop drains. Not an `after` hook: one
  // registered before a file's top-level awaits ends the root test too early.
  process.on('beforeExit', () => {
    if (looked) return;
    looked = true;
    if (!existsSync(join(home, 'timon.db'))) return;
    void import('../../src/db.js').then(({ db }) => { database = db; }, () => { /* never loaded: nothing to close */ });
  });
  process.on('exit', () => {
    // Only at exit: a test's own `after` hooks may still write to the base.
    if (database?.open) {
      try { database.close(); } catch { /* still busy: the removal reports it */ }
    }
    removeHome(home);
  });
}

export function removeHome(home: string): void {
  if (process.platform !== 'win32') {
    rmSync(home, { recursive: true, force: true });
    return;
  }
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === undefined || !HELD_CODES.has(code)) throw err;
    process.stderr.write(`[test-home] left ${home} behind: ${code}, a handle is still open\n`);
  }
}
