/**
 * macOS: a launch on a Claude subscription account moves the account's sign-in out of the
 * login keychain into the account's own folder, before the CLI starts. Inside the mission's
 * fence the CLI can read the keychain but neither update nor delete it, so a refreshed token
 * written to the folder would stay shadowed by the stale entry the CLI reads first.
 *
 * darwin is injected: the keychain is the SDK testing kit's stand-in, nothing touches the OS.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderContext } from '../../../packages/sdk/src/testing/index.js';
import { createClaudeProvider } from '../../official-providers/provider-claude/lib/claude.js';
import { createClaudeToken } from '../../official-providers/provider-claude/lib/token.js';
import { createClaudeUsage } from '../../official-providers/provider-claude/lib/usage.js';
import { claudeAccountKeychainService } from '../../official-providers/provider-claude/lib/account-keychain.js';

const { timon: { apiVersion } } = JSON.parse(readFileSync(new URL('../../official-providers/provider-claude/package.json', import.meta.url), 'utf8')) as { timon: { apiVersion: number } };

const ACCESS = 'sk-ant-oat01-keychain-access-token-for-the-test';
const REFRESH = 'sk-ant-ort01-keychain-refresh-token-for-the-test';
const FRESH_ACCESS = 'sk-ant-oat01-file-access-token-renewed-in-a-mission';
const FRESH_REFRESH = 'sk-ant-ort01-file-refresh-token-renewed-in-a-mission';
const SECRETS = [ACCESS, REFRESH, FRESH_ACCESS, FRESH_REFRESH];
const HOUR = 3_600_000;

const roots: string[] = [];
process.on('exit', () => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function pair(accessToken: string, refreshToken: string, expiresAt: number) {
  return { claudeAiOauth: { accessToken, refreshToken, expiresAt, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max' } };
}

type Setup = { platform?: NodeJS.Platform; keychain?: string; file?: unknown; locked?: boolean };

async function launchOnAccount(setup: Setup) {
  const root = mkdtempSync(join(tmpdir(), 'timon-claude-account-'));
  roots.push(root);
  const configDir = join(root, 'backend-accounts', 'acc-1');
  (await import('node:fs')).mkdirSync(configDir, { recursive: true, mode: 0o700 });
  if (setup.file !== undefined) writeFileSync(join(configDir, '.credentials.json'), JSON.stringify(setup.file), { mode: 0o600 });
  const service = claudeAccountKeychainService(configDir);
  const ctx = createProviderContext({
    apiVersion, secrets: SECRETS,
    osCredentials: setup.keychain === undefined ? {} : { [service]: setup.keychain },
    ...(setup.locked ? { lockedOsCredentials: [service] } : {}),
  });
  process.on('exit', () => ctx.cleanup());
  const warnings: string[] = [];
  const log = { info: () => {}, warn: (...args: unknown[]) => { warnings.push(args.join(' ')); }, error: () => {} };
  const token = createClaudeToken(ctx.provider);
  ctx.provider.registerProvider(createClaudeProvider(ctx.provider, token, createClaudeUsage(ctx.provider, token), { platform: setup.platform ?? 'darwin', log }));
  const dialect = ctx.registered.dialect('claude');
  const profile = { id: 'claude@acc-1', cmd: 'claude', env: {}, account: { id: 'acc-1', name: 'Work', configDir } };
  const spec = await dialect.buildSpawn({
    agentName: 'claude.account', systemPrompt: 'contract', message: 'ping', resumeSession: null, missionId: `mission-account-${roots.length}`,
    cfg: { cwd: root, permission_mode: 'auto', mcp_servers: [] },
  } as never, profile as never);
  const entry = ctx.provider.account.osCredential(profile as never, service)!;
  const file = join(configDir, '.credentials.json');
  return {
    spec, configDir, warnings, logs: ctx.logs,
    keychainLeft: await entry.read(),
    file: existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> : null,
    mode: existsSync(file) ? statSync(file).mode & 0o777 : null,
  };
}

/** No secret on the command line, in the environment, in a warning or a log line. */
function assertNoSecretOut(result: Awaited<ReturnType<typeof launchOnAccount>>): void {
  const out = JSON.stringify([result.spec.cmd, result.spec.args, result.spec.env, result.warnings, result.logs]);
  for (const secret of SECRETS) assert.ok(!out.includes(secret), 'a token leaked into the launch, a warning or a log');
}

test('the CLI names an account\'s keychain entry after its folder: first 8 hex of sha256, NFC', () => {
  // Measured on macOS: `printf %s /private/tmp/kc-cli.Gxaa/acct | shasum -a 256`.
  assert.equal(claudeAccountKeychainService('/private/tmp/kc-cli.Gxaa/acct'), 'Claude Code-credentials-74619e8d');
  assert.equal(claudeAccountKeychainService('/Users/me/A\u030angstrom'), claudeAccountKeychainService('/Users/me/\u00c5ngstrom'));
});

test('darwin: the entry moves into the account\'s folder and leaves the keychain, before the CLI starts', async () => {
  const stored = { ...pair(ACCESS, REFRESH, Date.now() + 4 * HOUR), mcpOAuth: { server: { accessToken: 'mcp' } } };
  const result = await launchOnAccount({ keychain: JSON.stringify(stored) });
  assert.deepEqual(result.file, stored);
  if (process.platform !== 'win32') assert.equal(result.mode, 0o600);
  assert.equal(result.keychainLeft, null, 'no entry is left to shadow the file');
  // The CLI reads that folder, and its keychain name is pinned to it.
  assert.equal(result.spec.env?.CLAUDE_CONFIG_DIR, result.configDir);
  assert.equal(result.spec.env?.CLAUDE_SECURESTORAGE_CONFIG_DIR, result.configDir);
  assert.equal(result.spec.env?.CLAUDE_CODE_OAUTH_TOKEN, '');
  assert.deepEqual(result.warnings, []);
  assertNoSecretOut(result);
});

test('darwin: a fresher pair a fenced refresh already wrote to the folder wins over the stale entry', async () => {
  const fresh = pair(FRESH_ACCESS, FRESH_REFRESH, Date.now() + 8 * HOUR);
  const result = await launchOnAccount({ keychain: JSON.stringify(pair(ACCESS, REFRESH, Date.now() - HOUR)), file: fresh });
  assert.deepEqual(result.file?.claudeAiOauth, fresh.claudeAiOauth);
  assert.equal(result.keychainLeft, null);
  assertNoSecretOut(result);
});

test('darwin: a fresher entry replaces the folder\'s pair and keeps what else the file holds; hex is read', async () => {
  const stored = pair(ACCESS, REFRESH, Date.now() + 4 * HOUR);
  const result = await launchOnAccount({
    keychain: Buffer.from(JSON.stringify(stored), 'utf8').toString('hex'),
    file: { ...pair(FRESH_ACCESS, FRESH_REFRESH, Date.now() - HOUR), mcpOAuth: { kept: true } },
  });
  assert.deepEqual(result.file?.claudeAiOauth, stored.claudeAiOauth);
  assert.deepEqual(result.file?.mcpOAuth, { kept: true });
  assert.equal(result.keychainLeft, null);
  assertNoSecretOut(result);
});

test('darwin: a keychain that refuses the delete keeps its entry, and the warning names no secret', async () => {
  const result = await launchOnAccount({ keychain: JSON.stringify(pair(ACCESS, REFRESH, Date.now() + HOUR)), locked: true });
  assert.ok(result.keychainLeft, 'the entry is still there');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /account acc-1 stays in the macOS keychain \(kept\)/);
  assertNoSecretOut(result);
});

test('darwin: an entry that is not the CLI\'s JSON is left alone, and nothing is written', async () => {
  const result = await launchOnAccount({ keychain: 'not json' });
  assert.equal(result.keychainLeft, 'not json');
  assert.equal(result.file, null);
  assert.match(result.warnings[0] ?? '', /\(unreadable\)/);
});

test('darwin: an account with no entry launches as before, with nothing written', async () => {
  const result = await launchOnAccount({});
  assert.equal(result.file, null);
  assert.deepEqual(result.warnings, []);
});

test('Linux and Windows: the account\'s folder already holds its sign-in, the keychain is never asked', async () => {
  for (const platform of ['linux', 'win32'] as const) {
    const keychain = JSON.stringify(pair(ACCESS, REFRESH, Date.now() + HOUR));
    const result = await launchOnAccount({ platform, keychain });
    assert.equal(result.file, null, platform);
    assert.equal(result.keychainLeft, keychain, platform);
    assertNoSecretOut(result);
  }
});
