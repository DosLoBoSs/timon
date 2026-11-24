/** What the daemon knows of each provider's sign-in, and how a turn outranks the provider's own check. */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { mountOfficialProviders, stubCliBinaries } = await import('../../tests/helpers/official-providers.js');
await stubCliBinaries('claude', 'codex');
await mountOfficialProviders();
const {
  noteProviderSignedIn, noteProviderSignedInByPerson, noteProviderSignedOut, onProviderSignInChanged, primeProviderSignIn, providerSignedIn, providerSignedOut,
  refreshProviderSignIn, resetProviderSignInForTest, setSignInEnv,
} = await import('./sign-in-state.js');
const { tryDefaultBackendName } = await import('./index.js');
const { mainAgentAuthEnv } = await import('../doctor.js');
const { getAgent } = await import('../agent.js');
const { agentDir } = await import('../paths.js');
const { mkdirSync, writeFileSync } = await import('node:fs');
const { join } = await import('node:path');
const { invalidateSettingsCache } = await import('../settings.js');
const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');

test('nothing is asked before the boot wires the environment: the verdict stays unknown', async () => {
  resetProviderSignInForTest();
  assert.equal(await refreshProviderSignIn('claude'), null);
  assert.equal(providerSignedIn('claude'), null);
  assert.equal(providerSignedOut('claude'), false, 'unknown is never signed out');
});

test('the provider check answers, and a turn outranks it', async () => {
  resetProviderSignInForTest();
  setSignInEnv(() => ({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test-token-long-enough' }));
  await primeProviderSignIn(['claude']);
  assert.equal(providerSignedIn('claude'), true, 'a token in the environment is a sign-in');
  noteProviderSignedOut('claude');
  assert.equal(providerSignedOut('claude'), true);
  await refreshProviderSignIn('claude');
  assert.equal(providerSignedOut('claude'), true, 'the CLI refusing a turn wins over a background check, for a while');
  await refreshProviderSignIn('claude', true);
  assert.equal(providerSignedIn('claude'), true, 'a person asking again (setup\'s Try again) gets the fresh answer at once');
  noteProviderSignedIn('claude');
  assert.equal(providerSignedIn('claude'), true);
  resetProviderSignInForTest();
});

test('an environment that itself asks the sign-in state does not recurse (TIM-0119)', async () => {
  resetProviderSignInForTest();
  let calls = 0;
  // `mainAgentAuthEnv` resolved the main agent's default backend, which asks
  // `providerSignedOut` for every provider: with no verdict yet, that walk
  // re-entered the refresh until the stack overflowed.
  setSignInEnv(() => {
    calls++;
    assert.equal(providerSignedOut('claude'), false, 'a refresh in flight answers unknown, not another refresh');
    assert.equal(tryDefaultBackendName(), 'claude');
    return { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test-token-long-enough' };
  });
  try {
    assert.equal(providerSignedIn('claude'), null, 'the first caller gets no verdict and starts the refresh');
    await primeProviderSignIn(['claude']);
    // Each provider refreshes at most a few times here (claude, then the codex
    // the default-backend walk asks about): a bounded count, not a stack.
    assert.ok(calls <= 6, `bounded refreshes, got ${calls}`);
    assert.equal(providerSignedIn('claude'), true);
  } finally {
    resetProviderSignInForTest();
  }
});

test('the real boot wiring: a main agent without a backend of its own does not loop (TIM-0119)', async () => {
  // What both testers had: `_main` renamed or seeded without `backend`, so
  // reading it resolves the default backend, which asks the sign-in state.
  // The boot wires `mainAgentAuthEnv` as the refresh's environment; a unit
  // test with a static environment never walked this cycle.
  resetProviderSignInForTest();
  mkdirSync(agentDir('_main'), { recursive: true });
  writeFileSync(join(agentDir('_main'), 'config.json'), '{}\n');
  // The overflow itself is swallowed by the refresh's own catch (the Windows
  // tester's daemon froze instead of dying): only a count tells the loop.
  let evaluations = 0;
  setSignInEnv(() => { evaluations++; return mainAgentAuthEnv(); });
  try {
    assert.equal(getAgent('_main')?.backend, 'claude', 'the default backend is resolved, not stored');
    assert.doesNotThrow(() => providerSignedIn('claude'));
    await primeProviderSignIn(['claude', 'codex']);
    assert.ok(evaluations <= 6, `a few refreshes, not a walk down the stack: ${evaluations} evaluations`);
    assert.equal(typeof tryDefaultBackendName(), 'string');
  } finally {
    resetProviderSignInForTest();
  }
});

test('an account instance is never tracked here: it carries its own status', () => {
  resetProviderSignInForTest();
  noteProviderSignedOut('claude@acct-1');
  assert.equal(providerSignedIn('claude@acct-1'), null);
});

test('the default backend skips a signed-out provider and honours the preferred one', () => {
  resetProviderSignInForTest();
  const before = tryDefaultBackendName();
  assert.equal(before, 'claude', 'claude serves the daemon\'s own tasks: it leads by default');
  noteProviderSignedOut('claude');
  assert.equal(tryDefaultBackendName(), 'codex', 'a signed-out claude is no default');
  process.env.TIMON_PREFERRED_BACKEND = 'claude';
  invalidateSettingsCache();
  try {
    assert.equal(tryDefaultBackendName(), 'codex', 'a preferred provider that is signed out is passed over');
    noteProviderSignedIn('claude');
    process.env.TIMON_PREFERRED_BACKEND = 'codex';
    invalidateSettingsCache();
    assert.equal(tryDefaultBackendName(), 'codex', 'the preferred provider wins over the usual order');
  } finally {
    delete process.env.TIMON_PREFERRED_BACKEND;
    invalidateSettingsCache();
    resetProviderSignInForTest();
  }
});

test('a flip of the sign-in is announced once, a turn that only confirms it is not', () => {
  resetProviderSignInForTest();
  let calls = 0;
  const off = onProviderSignInChanged(() => { calls += 1; });
  try {
    noteProviderSignedIn('claude');
    assert.equal(calls, 1, 'unknown → signed in is a change');
    noteProviderSignedIn('claude');
    noteProviderSignedIn('claude');
    assert.equal(calls, 1, 'every turn that works says the same thing');
    noteProviderSignedOut('claude');
    assert.equal(calls, 2, 'signed in → signed out is a change');
    noteProviderSignedIn('claude@acct-1');
    assert.equal(calls, 2, 'an account instance is not tracked here');
  } finally {
    off();
    resetProviderSignInForTest();
  }
  noteProviderSignedOut('claude');
  assert.equal(calls, 2, 'an unsubscribed listener hears nothing');
  resetProviderSignInForTest();
});

test('a person signing in makes the provider usable at once, whatever check was running', async () => {
  resetProviderSignInForTest();
  // A config folder with nothing in it: the provider's own check says signed out.
  const empty = mkdtempSync(join(tmpdir(), 'timon-signin-'));
  let signInDuringCheck = false;
  setSignInEnv(() => {
    // The check has started (its environment is being read) when the sign-in lands.
    if (signInDuringCheck) { signInDuringCheck = false; noteProviderSignedInByPerson('claude'); }
    return { CLAUDE_CONFIG_DIR: empty, HOME: empty };
  });
  try {
    assert.equal(await refreshProviderSignIn('claude', true), false, 'known signed out before');
    assert.equal(providerSignedOut('claude'), true);
    assert.equal(tryDefaultBackendName(), 'codex', 'a signed-out claude is passed over');

    // A person asked again (setup's Try again): that explicit check is in flight when the sign-in succeeds.
    signInDuringCheck = true;
    const stale = refreshProviderSignIn('claude', true);
    assert.equal(await stale, true, 'the check that started before the sign-in reports the sign-in, not what it read');
    assert.equal(providerSignedIn('claude'), true, 'the stale check did not undo the sign-in');
    assert.equal(tryDefaultBackendName(), 'claude', 'claude is picked again at once');

    // Without a check in flight, the sign-in is read synchronously: nothing to wait for.
    noteProviderSignedOut('claude');
    noteProviderSignedInByPerson('claude');
    assert.equal(providerSignedIn('claude'), true);
    await refreshProviderSignIn('claude');
    assert.equal(providerSignedIn('claude'), true, 'a background check does not overturn a sign-in the person just made');
  } finally {
    resetProviderSignInForTest();
  }
});

test('a sign-in that lands while a check runs lets the next refresh start afresh', async () => {
  resetProviderSignInForTest();
  const empty = mkdtempSync(join(tmpdir(), 'timon-signin-'));
  setSignInEnv(() => ({ CLAUDE_CONFIG_DIR: empty, HOME: empty }));
  try {
    const first = refreshProviderSignIn('claude', true);
    noteProviderSignedInByPerson('claude');
    const second = refreshProviderSignIn('claude', true);
    assert.notEqual(first, second, 'the refresh after the sign-in is not the stale one');
    assert.equal(await first, true);
    assert.equal(await second, false, 'an explicit check after the sign-in still says what it reads');
  } finally {
    resetProviderSignInForTest();
  }
});
