import { lstatSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

export function linkDirectory(target: string, destination: string): void {
  // Junctions do not require Windows symlink privileges or Developer Mode.
  symlinkSync(resolve(target), destination, process.platform === 'win32' ? 'junction' : 'dir');
}

/** Whether `path` is a folder link (a symbolic link, or a junction: Node reports both as links), dangling ones included. */
export function isDirectoryLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

/** Seams for the tests: the file system calls, the platform and the pause between attempts. */
export type LinkRemovalOps = {
  unlink?: (path: string) => void;
  rmdir?: (path: string) => void;
  platform?: NodeJS.Platform;
  attempts?: number;
  wait?: (ms: number) => void;
};

const LOCKED = new Set(['EBUSY', 'EPERM', 'EACCES']);

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? '';
}

/**
 * Removes the link at `path` and never what it points to. A recursive `rm` is
 * not trusted with this: whether it follows a junction has varied across
 * runtimes, and the target can be a folder other missions share.
 *
 * On Windows, Defender, the indexer or a process still exiting can hold the
 * entry for a moment (EBUSY, EPERM): the removal is retried a few times, then
 * fails with a message that says so. The whole wait stays under a second,
 * because the callers run synchronously in the daemon.
 */
export function removeDirectoryLink(path: string, ops: LinkRemovalOps = {}): void {
  const unlink = ops.unlink ?? unlinkSync;
  const rmdir = ops.rmdir ?? rmdirSync;
  const windows = (ops.platform ?? process.platform) === 'win32';
  const attempts = ops.attempts ?? 6;
  const wait = ops.wait ?? pause;
  for (let attempt = 0; ; attempt++) {
    try {
      try {
        unlink(path);
      } catch (error) {
        const code = errorCode(error);
        // Windows may refuse to unlink a junction, a folder entry: rmdir removes the entry, not its target.
        if (!windows || (code !== 'EPERM' && code !== 'EISDIR')) throw error;
        rmdir(path);
      }
      return;
    } catch (error) {
      const code = errorCode(error);
      // A previous attempt was refused but has since taken effect: the link is gone, which is what was asked.
      if (attempt > 0 && code === 'ENOENT') return;
      // A lock is a Windows behaviour; elsewhere these codes are a real refusal that waiting will not lift.
      if (!windows || !LOCKED.has(code)) throw error;
      if (attempt >= attempts - 1) {
        throw new Error(`could not remove the folder link ${path}: still in use after ${attempts} attempts (${code})`, { cause: error });
      }
      wait(25 * 2 ** attempt);
    }
  }
}
