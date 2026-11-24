/**
 * `timon doctor`'s fence coverage: for each active profile, the policy a
 * mission of that profile would get, and whether the kernel honours it on this
 * machine.
 *
 * WHY. A hole in the fence's allow-list shows as a mission dying in 112 ms on
 * `Operation not permitted`, on one machine and not another (a kernel ABI, a
 * Seatbelt rendering, a Timon home behind a link). The static matrix
 * (`fence-provider-coverage.test.ts`) proves the policy right for the official
 * providers; it cannot prove what this kernel does with it. Here the launcher
 * opens each path under the real policy, the way a mission would.
 *
 * Each profile gets a mission id of its own, and the folders the fence grants a
 * mission from that id are made for the check, as a launch makes them, then
 * removed: a grant on a folder that does not exist is dropped, which would
 * prove nothing. Nothing else is created but a probe file in each folder a
 * mission writes, removed with it. No CLI runs, no credential is read.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { config } from './config/load.js';
import type { TimonConfig } from './config/schema.js';
import { activeProfiles, backendOwnerPlugin } from './backends/registry.js';
import { splitBackendInstance } from './backends/instance-id.js';
import { credentialAccountOf } from './backends/host-sign-in.js';
import { getHost } from './host/index.js';
import { fenceAccess, missionTmpDir, resolveFence, type FencePolicy, type FenceTarget } from './host/isolation.js';
import { nodeRuntime } from './host/node-runtime.js';
import type { HostFence } from './host/types.js';
import { witnessFenceAccess, type FenceAccessWitness } from './host/fence-witness.js';
import { daemonRuntimePaths } from './mission-fence-target.js';
import { fencePolicyFile, hostFenceStatus } from './resources.js';
import { realPathOf } from './fence-refusal.js';
import { DAEMON_TOKEN_FILE, SECRET_KEY_FILE, TIMON_HOME } from './paths.js';
import type { FenceCoverageCheck, FenceCoverageProfile, FenceCoverageReport } from './fence-coverage-report.js';

type Planned = Omit<FenceCoverageCheck, 'policy' | 'kernel' | 'reason'> & { path: string };

/** `child` is `parent` or beneath it. */
function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function displayOf(path: string, home: string): string {
  return within(home, path) ? join('~', relative(home, path)) : path;
}

/** The private files of the Timon home a mission must never open: the ones that exist here. */
function privateFiles(timonHome: string): string[] {
  const candidates = timonHome === TIMON_HOME
    ? [DAEMON_TOKEN_FILE, SECRET_KEY_FILE, join(TIMON_HOME, 'timon.db')]
    : ['daemon-token', 'secret-key', 'timon.db'].map((name) => join(timonHome, name));
  return candidates.filter((path) => existsSync(path));
}

const isDir = (path: string): boolean => {
  try { return statSync(path).isDirectory(); } catch { return false; }
};

export type FenceCoverageDeps = {
  cfg?: TimonConfig;
  fence?: HostFence | undefined;
  timonHome?: string;
  home?: string;
  /** The profiles to check; the active process profiles by default. */
  profiles?: string[];
  witness?: typeof witnessFenceAccess;
};

/** The active profiles that start a process on this machine: a remote one has no fence. */
function processProfiles(): string[] {
  return activeProfiles().filter((entry) => 'buildSpawn' in entry.dialect).map((entry) => entry.profile.id);
}

export async function fenceCoverage(deps: FenceCoverageDeps = {}): Promise<FenceCoverageReport> {
  const cfg = deps.cfg ?? config();
  const fence = 'fence' in deps ? deps.fence : getHost().fence;
  const timonHome = deps.timonHome ?? TIMON_HOME;
  const home = deps.home ?? homedir();
  const mode = cfg.host.isolation.filesystem;
  const status = mode === 'off' ? null : hostFenceStatus(fence);
  if (!status || status.state !== 'ready' || !fence) {
    return {
      state: 'unfenced', mechanism: fence?.mechanism ?? null, witness: false,
      reason: !status ? 'turned off by host.isolation.filesystem' : status.state === 'ready' ? 'no mission fence on this OS' : status.reason,
      profiles: [], exceptions: [],
    };
  }
  const witness = deps.witness ?? witnessFenceAccess;
  const runtime = daemonRuntimePaths(nodeRuntime(cfg));
  const profiles: FenceCoverageProfile[] = [];
  let exceptions: FenceCoverageReport['exceptions'] = [];
  for (const profile of deps.profiles ?? processProfiles()) {
    const result = await profileCoverage(profile, { cfg, fence, timonHome, home, runtime, witness });
    profiles.push(result.coverage);
    if (exceptions.length === 0) exceptions = result.exceptions;
  }
  return { state: 'checked', mechanism: fence.mechanism, witness: true, reason: null, profiles, exceptions };
}

async function profileCoverage(profile: string, ctx: {
  cfg: TimonConfig; fence: HostFence; timonHome: string; home: string; runtime: string[]; witness: typeof witnessFenceAccess;
}): Promise<{ coverage: FenceCoverageProfile; exceptions: FenceCoverageReport['exceptions'] }> {
  const { timonHome, home } = ctx;
  const missionId = randomUUID();
  const made: string[] = [];
  const probes: string[] = [];
  const policyFile = fencePolicyFile(timonHome, `doctor-${missionId.slice(0, 8)}`);
  const plugin = backendOwnerPlugin(profile);
  const account = credentialAccountOf(profile) ?? undefined;
  const instance = splitBackendInstance(profile);
  const providerProfile = plugin && !account && !instance.accountId ? instance.backend : undefined;
  const makeDir = (dir: string): void => {
    if (existsSync(dir)) return;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    made.push(dir);
  };
  /** A file to append to in a folder a mission writes: the write witness needs one. */
  const probeIn = (dir: string): string => {
    const probe = join(dir, `.timon-doctor-${missionId.slice(0, 8)}`);
    writeFileSync(probe, '', { mode: 0o600 });
    probes.push(probe);
    return probe;
  };
  try {
    const own = [
      { dir: missionTmpDir(timonHome, missionId), why: 'the mission\'s TMPDIR' },
      ...(plugin ? [{ dir: join(timonHome, 'provider-runs', plugin, missionId), why: `the CLI's per-mission home (${plugin})` }] : []),
    ];
    for (const { dir } of own) makeDir(dir);
    const target: FenceTarget = {
      timonHome, home, missionId, backend: profile, runtime: ctx.runtime,
      ...(account ? { account } : {}), ...(plugin ? { providerPlugin: plugin } : {}), ...(providerProfile ? { providerProfile } : {}),
    };
    const policy: FencePolicy = resolveFence(
      { ...ctx.cfg, host: { ...ctx.cfg.host, isolation: { ...ctx.cfg.host.isolation, filesystem: 'auto' } } },
      target,
    );
    const planned: Planned[] = [];
    const plan = (path: string, access: 'read' | 'write', expect: 'allowed' | 'refused', why: string): void => {
      planned.push({ path, display: displayOf(path, home), access, expect, why });
    };
    for (const { dir, why } of own) {
      plan(dir, 'read', 'allowed', why);
      plan(probeIn(dir), 'write', 'allowed', why);
    }
    // Shared by the plugin's missions, or the profile's: checked where they exist.
    const shared = [
      ...(plugin ? [{ dir: join(timonHome, 'provider-cache', plugin), why: `the shared cache of ${plugin}` }] : []),
      ...(plugin && providerProfile ? [{ dir: join(timonHome, 'provider-cache', plugin, 'profiles', providerProfile), why: 'the profile\'s own folder' }] : []),
      ...(account ? [{ dir: join(timonHome, 'backend-accounts', account), why: 'the account\'s sign-in folder' }] : []),
    ];
    for (const { dir, why } of shared) {
      if (!isDir(dir)) continue;
      plan(dir, 'read', 'allowed', why);
      plan(probeIn(dir), 'write', 'allowed', why);
    }
    // The daemon's own release, from which the mission's Timon MCP servers run.
    for (const path of ctx.runtime) {
      if (within(timonHome, path) && existsSync(path)) plan(path, 'read', 'allowed', 'the daemon release the Timon MCP servers run from');
    }
    for (const path of privateFiles(timonHome)) plan(path, 'read', 'refused', 'a private file of Timon');
    const policyOf = (path: string, access: 'read' | 'write'): 'allowed' | 'refused' => {
      const granted = fenceAccess(policy, realPathOf(path));
      return (access === 'read' ? granted.read : granted.write) ? 'allowed' : 'refused';
    };
    mkdirSync(dirname(policyFile), { recursive: true, mode: 0o700 });
    const kernel: FenceAccessWitness[] = await ctx.witness(ctx.fence, policy, planned.map(({ path, access }) => ({ path, access })), policyFile);
    const checks: FenceCoverageCheck[] = planned.map(({ path: _path, ...check }, i) => {
      const seen = kernel[i] ?? { state: 'error' as const, reason: 'no answer' };
      return {
        ...check,
        policy: policyOf(_path, check.access),
        kernel: seen.state,
        ...(seen.state === 'error' ? { reason: seen.reason } : {}),
      };
    });
    const ok = checks.every((check) => check.policy === check.expect && check.kernel === check.expect);
    const exceptions = policy.ignored.filter((entry) => entry.config).map(({ path, reason }) => ({ path: displayOf(path, home), reason }));
    return { coverage: { profile, ok, checks }, exceptions };
  } catch (err) {
    return { coverage: { profile, ok: false, checks: [], error: (err as Error).message }, exceptions: [] };
  } finally {
    for (const probe of probes) rmSync(probe, { force: true });
    for (const dir of made.reverse()) rmSync(dir, { recursive: true, force: true });
    rmSync(policyFile, { force: true });
  }
}
