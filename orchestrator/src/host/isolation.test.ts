/**
 * Mission filesystem isolation (audit finding #4).
 *
 * Two things are tested, and the second one matters more than the first:
 *
 *  1. the directives actually rendered on a launcher that accepts them — the
 *     long `--property=K=V` form, the sensitive paths, and nothing else;
 *  2. the guards that keep the policy from becoming an outage: never mask the
 *     mission's own directory, its backend's credentials, or TIMON_HOME. No
 *     typecheck sees a systemd path list; only these assertions do.
 *
 * And the regression that would hurt the most: the `--scope` line must stay
 * byte-for-byte what it was. A masking directive there is refused by systemd
 * ("Unknown assignment"), `probeWrapper()` marks the whole wrapper unusable,
 * and every mission then launches with no MemoryMax, no nice, no ionice.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const HOME = mkdtempSync(join(tmpdir(), 'timon-isolation-test-'));
process.env.TIMON_HOME = HOME;

const { TimonConfigSchema } = await import('../config/schema.js');
const {
  isolationArgsFor, isolationProperties, resolveIsolation, sandboxSupported,
  setDeclaredCredentialDirsSource, PROTECTED_HOME_DIRS,
  BACKEND_HOME_DIRS, MISSION_TIMON_ZONES, isRefusedTimonEntry, timonRefusedPaths,
} = await import('./isolation.js');

const FAKE_HOME = '/home/tester';
const cfg = (isolation: Record<string, unknown> = {}) =>
  TimonConfigSchema.parse({ host: { isolation } });

test('the rendered directives mask the credential paths, in the long property form', () => {
  const args = isolationArgsFor('service', cfg(), { home: FAKE_HOME, backend: 'claude' });
  const masking = args.filter((a) => a.startsWith('--property=InaccessiblePaths='));
  assert.equal(masking.length, 1, 'exactly one InaccessiblePaths directive');
  // Short form `-p=K=V` is rejected by systemd-run and breaks the spawn.
  for (const a of args) assert.match(a, /^--property=/);
  const paths = masking[0]!.slice('--property=InaccessiblePaths='.length).split(' ');
  // public-name-ok: the archive's home is part of the masked list
  for (const expected of ['.ssh', '.gnupg', '.aws', '.pkos', '.codex', '.grok']) {
    assert.ok(
      paths.includes(`${FAKE_HOME}/${expected}`),
      `${expected} must be masked, got ${paths.join(' ')}`,
    );
  }
});

test('the backend actually in use keeps its credentials, the others do not', () => {
  for (const [backend, dirs] of Object.entries(BACKEND_HOME_DIRS)) {
    const { deny } = resolveIsolation(cfg(), { home: FAKE_HOME, backend });
    for (const dir of dirs) {
      assert.ok(!deny.includes(`${FAKE_HOME}/${dir}`), `${backend} must keep ~/${dir}`);
    }
    // A neighbour backend's directory is still masked: a codex mission has no
    // business reading the claude subscription.
    const other = backend === 'claude' ? '.codex' : '.claude';
    assert.ok(deny.includes(`${FAKE_HOME}/${other}`), `${backend} must not see ~/${other}`);
  }
});

test('a mission cwd living under a masked path is never masked away', () => {
  // Worktrees under a folder the default list masks: masking the ancestor
  // would hide the mission's own repository.
  const { deny } = resolveIsolation(cfg(), {
    home: FAKE_HOME,
    backend: 'claude',
    cwd: `${FAKE_HOME}/.pkos/worktrees/abcd`, // public-name-ok: a masked folder
  });
  assert.ok(!deny.includes(`${FAKE_HOME}/.pkos`), 'an ancestor of the cwd must be spared'); // public-name-ok: a masked folder
  assert.ok(deny.includes(`${FAKE_HOME}/.ssh`), 'the rest of the list still applies');
});

test('TIMON_HOME and its ancestors are never masked, the private files in it always are', () => {
  const timonHome = `${FAKE_HOME}/state/timon`;
  const { deny } = resolveIsolation(cfg({ deny: ['~/state'] }), { home: FAKE_HOME, timonHome });
  assert.ok(!deny.includes(`${FAKE_HOME}/state`) && !deny.includes(timonHome), 'the folders themselves stay visible');
  // Guard 3 no longer spares what lives inside: every refused entry is masked.
  for (const name of MISSION_TIMON_ZONES.refused) {
    assert.ok(deny.includes(`${timonHome}/${name}`), `${name} must be masked`);
  }
  assert.deepEqual(
    deny.filter((p) => p.startsWith(`${FAKE_HOME}/state`)).sort(),
    MISSION_TIMON_ZONES.refused.map((name) => `${timonHome}/${name}`).sort(),
    'nothing else under the Timon home is masked by this launcher',
  );
});

test('neither the cwd nor allow reopens a private file of the Timon home', () => {
  const timonHome = `${FAKE_HOME}/.timon`;
  const { deny, readOnly } = resolveIsolation(
    cfg({ allow: ['~/.timon', '~/.timon/daemon-token'], readOnly: ['~/.timon/secret-key'] }),
    { home: FAKE_HOME, timonHome, cwd: `${timonHome}/backups/x` },
  );
  for (const name of ['daemon-token', 'secret-key', 'timon.db', 'timon.config.json', 'backups']) {
    assert.ok(deny.includes(`${timonHome}/${name}`), `${name} must stay masked`);
  }
  assert.ok(!readOnly.includes(`${timonHome}/secret-key`), 'a masked path is not also listed read-only');
});

test('the refused entries of the Timon home include the copies a prefix catches', () => {
  const paths = timonRefusedPaths('/t', ['timon.config.json.bak-20261025', 'license.state.json.tmp-42', 'skills', 'timon.db-journal']);
  for (const name of ['daemon-token', 'timon.config.json.bak-20261025', 'license.state.json.tmp-42', 'timon.db-journal']) {
    assert.ok(paths.includes(join('/t', name)), `${name} must be refused`);
  }
  assert.ok(!paths.includes(join('/t', 'skills')));
  for (const name of [...MISSION_TIMON_ZONES.writable, ...MISSION_TIMON_ZONES.readable]) {
    assert.equal(isRefusedTimonEntry(name), false, `${name} cannot be both granted and refused`);
  }
});

test('allow wins over the built-in list, deny and readOnly extend it', () => {
  const policy = resolveIsolation(
    cfg({ allow: ['~/.ssh'], deny: ['~/secrets'], readOnly: ['/etc'] }),
    { home: FAKE_HOME },
  );
  assert.ok(!policy.deny.includes(`${FAKE_HOME}/.ssh`), 'allow must win');
  assert.ok(policy.deny.includes(`${FAKE_HOME}/secrets`));
  assert.deepEqual(policy.readOnly, ['/etc']);
  assert.ok(
    isolationProperties(policy).includes('--property=ReadOnlyPaths=/etc'),
    'readOnly must render its own directive',
  );
});

test('a path holding a space is quoted, or systemd reads two paths', () => {
  const rendered = isolationProperties({
    deny: ['/home/t/my keys'], readOnly: [], enabled: true,
  });
  assert.deepEqual(rendered, ['--property=InaccessiblePaths="/home/t/my keys"']);
});

test('filesystem: off masks nothing at all', () => {
  const policy = resolveIsolation(cfg({ filesystem: 'off' }), { home: FAKE_HOME });
  assert.equal(policy.enabled, false);
  assert.deepEqual(isolationProperties(policy), []);
  assert.deepEqual(isolationArgsFor('service', cfg({ filesystem: 'off' }), { home: FAKE_HOME }), []);
});

test('a scope carries NO masking directive, whatever the policy says', () => {
  // Hard invariant: systemd answers "Unknown assignment" to Exec* directives
  // on a scope, `probeWrapper()` then disables the whole wrapper and missions
  // lose their memory cap. Never trade the resource guard for an inert sandbox.
  assert.equal(sandboxSupported('scope'), false);
  assert.deepEqual(
    isolationArgsFor('scope', cfg({ deny: ['~/anything'] }), { home: FAKE_HOME }),
    [],
  );
});

test('the mission wrapper line is unchanged by the isolation wiring', async () => {
  const { wrapMissionLaunch } = await import('../resources.js');
  const { cmd, args } = wrapMissionLaunch('claude', ['--x'], 'aaaaaaaa-0000-4000-8000-000000000000', {
    cwd: '/tmp', backend: 'claude', home: FAKE_HOME,
  });
  if (cmd !== 'systemd-run') return; // no systemd here (CI): nothing to check
  assert.deepEqual(
    args.filter((a) => /InaccessiblePaths|ReadOnlyPaths|ProtectHome/.test(a)),
    [],
    'no masking directive may reach the scope launcher',
  );
});

test('a folder a plugin declared for the running backend is spared, but never one of the user\'s credentials', () => {
  try {
    setDeclaredCredentialDirsSource(() => ({ acme: ['.acme', '.config/acme'] }));
    const ok = resolveIsolation(cfg(), { home: FAKE_HOME, backend: 'acme' });
    assert.ok(!ok.deny.includes(`${FAKE_HOME}/.acme`) && !ok.deny.includes(`${FAKE_HOME}/.config/acme`), 'its own folders are spared');
    assert.ok(ok.deny.includes(`${FAKE_HOME}/.ssh`));
    // Another backend's mission does not see them.
    assert.ok(resolveIsolation(cfg(), { home: FAKE_HOME, backend: 'claude' }).deny.includes(`${FAKE_HOME}/.acme`));

    // A declaration that got past registration still cannot open the user's keys, nor a parent of them.
    // public-name-ok: the archive's home is protected like the keys
    for (const hostile of ['.ssh', '.aws', '.gnupg', '.config', '.config/gcloud', '.pkos', '.claude', '.codex']) {
      setDeclaredCredentialDirsSource(() => ({ acme: [hostile] }));
      const { deny } = resolveIsolation(cfg(), { home: FAKE_HOME, backend: 'acme' });
      for (const protectedDir of ['.ssh', '.aws', '.gnupg', '.config/gcloud', '.pkos', '.claude', '.codex']) { // public-name-ok: as above
        assert.ok(deny.includes(`${FAKE_HOME}/${protectedDir}`), `declaring ${hostile} must not unmask ~/${protectedDir}`);
      }
    }
    // The running backend's own built-in folder is still spared by the built-in table, not by the declaration.
    setDeclaredCredentialDirsSource(() => ({ claude: ['.claude'] }));
    assert.ok(!resolveIsolation(cfg(), { home: FAKE_HOME, backend: 'claude' }).deny.includes(`${FAKE_HOME}/.claude`));
    assert.ok(PROTECTED_HOME_DIRS.includes('.ssh') && PROTECTED_HOME_DIRS.includes('.config/gcloud'));
  } finally {
    setDeclaredCredentialDirsSource(() => ({}));
  }
});
