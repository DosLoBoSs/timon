/**
 * timon-fence, the Linux mission launcher (`native/timon-fence/`): where the
 * daemon finds it, how it hands it a policy, and what its exit codes mean.
 *
 * The launcher applies Landlock, no_new_privs and a seccomp filter, then
 * exec()s the mission CLI. Which paths a mission may reach is decided by the
 * isolation policy; this module only speaks the launcher's wire format, so
 * that the C reader and the TypeScript writer change together.
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Exit codes of the launcher before the command runs (sysexits values). */
export const FENCE_EXIT = Object.freeze({
  usage: 64,
  /** No fence on this kernel: in `auto` the daemon launches unfenced and says so. */
  unavailable: 69,
  /** The kernel refused a step it advertises. */
  osError: 71,
  invalidPolicy: 78,
  execFailed: 127,
});

export const FENCE_POLICY_HEADER = 'timon-fence/1';

export interface FencePolicy {
  /** Read and execute beneath each path. */
  readonly readOnly: readonly string[];
  /** Every right beneath each path (create, write, rename, remove). */
  readonly readWrite: readonly string[];
  /** `deny` refuses socket(AF_UNIX): D-Bus, systemd --user, ssh-agent, Docker. */
  readonly unixSockets: 'deny' | 'allow';
}

/**
 * The policy file (Linux paths, hence `posix`): NUL-terminated strings, so a
 * path is written as the kernel knows it, whatever characters it holds. A
 * path the launcher cannot read
 * back unambiguously (relative, or holding a NUL) is refused here rather than
 * silently granting something else.
 */
export function encodeFencePolicy(policy: FencePolicy): Buffer {
  const fields: string[] = [FENCE_POLICY_HEADER, 'unix-sockets', policy.unixSockets];
  for (const [directive, paths] of [['ro', policy.readOnly], ['rw', policy.readWrite]] as const) {
    for (const path of paths) {
      if (!posix.isAbsolute(path)) throw new Error(`Fence policy paths must be absolute: ${path}`);
      if (path.includes('\0')) throw new Error('Fence policy paths cannot contain a NUL character');
      fields.push(directive, path);
    }
  }
  return Buffer.from(fields.map((field) => `${field}\0`).join(''), 'utf8');
}

/** The orchestrator folder: `src/host/` in a checkout, `dist/host/` once built. */
const ORCHESTRATOR_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Where the launcher may sit, best first: inside the daemon release of a
 * package (`resources/orchestrator/native/`, covered by the signed release
 * manifest), then the build folder of a source checkout.
 */
export function fenceBinaryCandidates(orchestratorRoot = ORCHESTRATOR_ROOT, arch: string = process.arch): string[] {
  return [
    join(orchestratorRoot, 'native', 'timon-fence'),
    join(orchestratorRoot, '..', 'native', 'timon-fence', 'build', `linux-${arch}`, 'timon-fence'),
  ];
}

function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The launcher to use, or null: none is shipped off Linux, nor built for this CPU. */
export function findFenceBinary(options: { platform?: NodeJS.Platform; orchestratorRoot?: string; arch?: string } = {}): string | null {
  if ((options.platform ?? process.platform) !== 'linux') return null;
  return fenceBinaryCandidates(options.orchestratorRoot, options.arch).find(isExecutableFile) ?? null;
}

export interface FenceProbe {
  /** True when a mission can be fenced on this kernel. */
  readonly available: boolean;
  /** Landlock ABI, 0 when absent or disabled. */
  readonly abi: number;
  readonly seccomp: boolean;
  /** Why it is unavailable, in English, for doctor and the logs. */
  readonly reason?: string;
}

/** Parses `timon-fence --probe`: `landlock-abi=N seccomp=yes|no`. */
export function parseFenceProbe(stdout: string, status: number | null): FenceProbe {
  const match = /landlock-abi=(\d+) seccomp=(yes|no)/.exec(stdout);
  if (!match) return { available: false, abi: 0, seccomp: false, reason: 'the fence launcher did not answer its probe' };
  const abi = Number(match[1]);
  const seccomp = match[2] === 'yes';
  if (status === 0) return { available: true, abi, seccomp };
  const reason = abi < 2
    ? (abi === 0 ? 'kernel without Landlock' : `kernel with Landlock ABI ${abi}, 2 or later is required`)
    : 'kernel without seccomp filters';
  return { available: false, abi, seccomp, reason };
}

/** Asks the launcher what this kernel supports. */
export function probeFence(binary: string): FenceProbe {
  const result = spawnSync(binary, ['--probe'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  if (result.error) return { available: false, abi: 0, seccomp: false, reason: `the fence launcher cannot run (${result.error.message})` };
  return parseFenceProbe(result.stdout, result.status);
}
