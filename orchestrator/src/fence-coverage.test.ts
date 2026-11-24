/**
 * `timon doctor`'s fence coverage: each active profile's policy, checked by the
 * kernel, with nothing left behind in the Timon home.
 */
import './test-home.js';
import '../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { mountOfficialProviders } = await import('../tests/helpers/official-providers.js');
await mountOfficialProviders();
const { config } = await import('./config/load.js');
const { TIMON_HOME } = await import('./paths.js');
const { fenceAccess } = await import('./host/isolation.js');
const { fenceCoverage } = await import('./fence-coverage.js');
const { failedCheck, formatFenceCoverage } = await import('./fence-coverage-report.js');
type HostFence = import('./host/types.js').HostFence;
type Witness = typeof import('./host/fence-witness.js').witnessFenceAccess;

writeFileSync(join(TIMON_HOME, 'daemon-token'), 'secret');
const AUTO = { ...config(), host: { ...config().host, isolation: { ...config().host.isolation, filesystem: 'auto' as const } } };
const FENCE: HostFence = {
  mechanism: 'landlock',
  probe: () => ({ available: true, abi: 6 }),
  wrap: (_policy, cmd, args) => ({ cmd, args: [...args] }),
  witness: async () => ({ ran: true, status: 0, stderr: '' }),
};
/** A kernel that does what the policy says, and records what it was asked. */
function faithfulKernel(asked: string[][] = []): Witness {
  return async (_fence, policy, checks) => {
    asked.push(checks.map((c) => c.path));
    return checks.map(({ path, access }) => {
      const granted = fenceAccess(policy, path);
      return { state: (access === 'read' ? granted.read : granted.write) ? 'allowed' : 'refused' };
    });
  };
}

test('each profile is checked on its own folders and on the private files, and the check leaves nothing behind', async () => {
  const before = readdirSync(join(TIMON_HOME));
  const asked: string[][] = [];
  const report = await fenceCoverage({ cfg: AUTO, fence: FENCE, profiles: ['codex'], witness: faithfulKernel(asked) });
  assert.equal(report.state, 'checked');
  assert.equal(report.mechanism, 'landlock');
  const codex = report.profiles[0]!;
  assert.equal(codex.profile, 'codex');
  assert.equal(codex.ok, true, JSON.stringify(codex.checks.filter(failedCheck)));
  const whys = codex.checks.map((c) => c.why);
  assert.ok(whys.includes('the mission\'s TMPDIR'));
  assert.ok(whys.some((why) => why.startsWith('the CLI\'s per-mission home')), 'the provider scratch the fence grants');
  const token = codex.checks.find((c) => c.display.endsWith('daemon-token'));
  assert.deepEqual([token?.expect, token?.policy, token?.kernel], ['refused', 'refused', 'refused']);
  // The folders made for the check are gone, the probes with them.
  for (const path of asked.flat()) {
    if (path.includes(`${join('tmp', 'missions')}`) || path.includes('.timon-doctor-')) assert.equal(existsSync(path), false, path);
  }
  assert.deepEqual(readdirSync(join(TIMON_HOME)).filter((name) => !before.includes(name) && name !== 'tmp' && name !== 'provider-runs' && name !== 'run'), []);
});

test('a path the kernel refuses while the policy grants it fails the profile, and says which', async () => {
  const kernel: Witness = async (fence, policy, checks, file) => {
    const answers = await faithfulKernel()(fence, policy, checks, file);
    return answers.map((answer, i) => (checks[i]?.access === 'write' ? { state: 'refused' } : answer));
  };
  const report = await fenceCoverage({ cfg: AUTO, fence: FENCE, profiles: ['codex'], witness: kernel });
  const codex = report.profiles[0]!;
  assert.equal(codex.ok, false);
  const text = formatFenceCoverage(report);
  assert.match(text, /codex\s+✗/);
  assert.match(text, /write refused by the kernel, the mission needs it/);
});

test('without a fence, the section says missions are not fenced and checks nothing', async () => {
  const unfenced = await fenceCoverage({ cfg: AUTO, fence: { ...FENCE, probe: () => ({ available: false, reason: 'kernel without Landlock', abi: 0 }) } });
  assert.equal(unfenced.state, 'unfenced');
  assert.match(formatFenceCoverage(unfenced), /not fenced here \(kernel without Landlock\)/);
  const off = await fenceCoverage({ cfg: { ...AUTO, host: { ...AUTO.host, isolation: { ...AUTO.host.isolation, filesystem: 'off' } } }, fence: FENCE });
  assert.equal(off.reason, 'turned off by host.isolation.filesystem');
  assert.match(formatFenceCoverage(null, 'the daemon does not answer'), /not checked — the daemon does not answer/);
});

test('an anonymous request for the fence coverage is refused', async () => {
  const express = (await import('express')).default;
  const { registerRoutes } = await import('./plugins-bundled/http/routes.js');
  const app = express();
  registerRoutes(app as never);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  try {
    const res = await fetch(`http://127.0.0.1:${address.port}/api/doctor/fence-coverage`);
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});
