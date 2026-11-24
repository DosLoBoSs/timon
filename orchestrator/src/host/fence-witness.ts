/**
 * Asks the kernel, not the policy, whether a fenced mission may reach paths:
 * the host's fence launcher runs a shell that opens each one, under the very
 * policy a mission would get. `fenceAccess` is what every renderer must
 * reproduce; this is what the renderer actually did on this machine.
 *
 * Each path is OPENED, never only tested: Landlock leaves `access(2)` alone, so
 * `test -r` would answer yes for a file the fence refuses to open. One launch
 * checks every path of a policy: rendering a Landlock policy lists folders, and
 * doing it once per path would cost a diagnostic seconds.
 */
import { existsSync } from 'node:fs';
import { runFenceWitness } from './fence.js';
import type { FencePolicy } from './isolation.js';
import type { HostFence } from './types.js';

/** The POSIX shell. Only run where a fence exists: Linux and macOS. */
const SHELL = '/bin/sh'; // portability: POSIX system shell, used only under the Linux and macOS fences

/**
 * Opens each `r:<path>` for reading and appends nothing to each `w:<path>`, then
 * says on stderr what it could do, one marked line per path. `true` is a regular
 * built-in: a redirection it cannot make fails it, without ending the shell as a
 * special built-in (`:`) would. Its own complaint goes to `/dev/null`, which the
 * fence keeps writable, so stderr only holds the markers and the launcher's words.
 */
const OPEN_SCRIPT = [
  'i=0',
  'for spec do',
  '  i=$((i+1)); p=${spec#?:}',
  '  case $spec in',
  '    r:*) true 2>/dev/null < "$p" && r=allowed || r=refused ;;',
  '    *) true 2>/dev/null >> "$p" && r=allowed || r=refused ;;',
  '  esac',
  '  printf "timon-witness %s %s\\n" "$i" "$r" >&2',
  'done',
].join('\n');

export type FenceWitnessCheck = { readonly path: string; readonly access: 'read' | 'write' };

export type FenceAccessWitness =
  | { readonly state: 'allowed' | 'refused' }
  /** The launcher could not apply the policy, or did not answer: nothing is known of the path. */
  | { readonly state: 'error'; readonly reason: string };

/**
 * Opens every checked path through the fence launcher, with `policy` written to
 * `policyFile` (a path no mission reaches). Each path must exist, and a `write`
 * must name a file: appending to a missing one would create it.
 */
export async function witnessFenceAccess(
  fence: HostFence,
  policy: FencePolicy,
  checks: readonly FenceWitnessCheck[],
  policyFile: string,
  options: { run?: typeof runFenceWitness; exists?: (path: string) => boolean } = {},
): Promise<FenceAccessWitness[]> {
  const fail = (reason: string): FenceAccessWitness[] => checks.map(() => ({ state: 'error', reason }));
  if (checks.length === 0) return [];
  if (!(options.exists ?? existsSync)(SHELL)) return fail(`no ${SHELL} on this machine`);
  let launch: { cmd: string; args: string[] };
  try {
    const specs = checks.map((check) => `${check.access === 'read' ? 'r' : 'w'}:${check.path}`);
    launch = fence.wrap(policy, SHELL, ['-c', OPEN_SCRIPT, 'timon-witness', ...specs], policyFile);
  } catch (err) {
    return fail(`the policy cannot be applied (${(err as Error).message})`);
  }
  const result = await (options.run ?? runFenceWitness)(launch.cmd, launch.args);
  if (!result.ran) return fail(result.reason);
  const said = new Map<number, 'allowed' | 'refused'>();
  for (const line of result.stderr.split('\n')) {
    const match = /^timon-witness (\d+) (allowed|refused)$/.exec(line.trim());
    if (match) said.set(Number(match[1]), match[2] as 'allowed' | 'refused');
  }
  const words = result.stderr.split('\n').find((line) => line.trim() && !line.startsWith('timon-witness '))?.trim();
  const unanswered = words ? `${words} (exit ${result.status})` : `the launcher exited with ${result.status} without an answer`;
  return checks.map((_, i) => {
    const state = said.get(i + 1);
    return state ? { state } : { state: 'error', reason: unanswered };
  });
}
