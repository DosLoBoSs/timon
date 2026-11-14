/**
 * The real `agy` inside the real mission fence (Linux, Landlock), on an empty home: it must start,
 * write in the folder its provider declares, and answer `auth_required` at once, not wait on a
 * keychain bus the fence refuses. Skipped where there is no fence launcher, no Landlock or no `agy`.
 * A signed-in run needs the user's own Google sign-in, which a test never copies: that case is a
 * manual check (`docs/A-TESTER-MULTI-OS.md`).
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findFenceBinary, probeFence } from '../host/fence.js';
import { createLandlockFence } from '../host/landlock.js';
import { setDeclaredCredentialDirsSource } from '../host/isolation.js';
import { fenceMissionCommand } from '../resources.js';
import { antigravityKeychainEnv } from '../../official-providers/provider-acp/lib/agents.js';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const MISSION = 'cccccccc-0000-4000-8000-0000000000a9';

function launcher(): string | null {
  if (process.platform !== 'linux') return null;
  const found = findFenceBinary();
  if (found) return found;
  const out = join(mkdtempSync(join(tmpdir(), 'agy-fence-bin-')), 'timon-fence');
  try {
    execFileSync(process.execPath, [join(REPO, 'native', 'timon-fence', 'build.mjs'), '--out', out, '--optional'], { stdio: 'ignore', timeout: 120_000 });
  } catch { return null; }
  return existsSync(out) ? out : null;
}

function agyPath(): string | null {
  try {
    return execFileSync('/bin/sh', ['-c', 'command -v agy'], { encoding: 'utf8' }).trim() || null; // portability: Linux-only test, skipped elsewhere
  } catch {
    return null;
  }
}

const BIN = launcher();
const PROBE = BIN ? probeFence(BIN) : null;
const AGY = BIN && PROBE?.available ? agyPath() : null;
const skip = !BIN ? 'no timon-fence for this machine (Linux with a C compiler only)'
  : !PROBE?.available ? `no fence on this kernel: ${PROBE?.reason}`
  : !AGY ? 'agy is not installed' : false;

/** The declared sign-in folders of the ACP agents, as the provider's manifest lists them. */
function declaredDirs(): Record<string, string[]> {
  const manifest = JSON.parse(readFileSync(join(REPO, 'orchestrator', 'official-providers', 'provider-acp', 'package.json'), 'utf8')) as {
    timon: { provider: { backends: Array<{ id: string; credentialDirs?: string[] }> } };
  };
  return Object.fromEntries(manifest.timon.provider.backends.map((b) => [b.id, b.credentialDirs ?? []]));
}

type Reply = { id?: number; error?: { code?: number }; result?: unknown };

test('a fenced agy on a home without sign-in starts, writes in its own folder and answers auth_required at once', { skip, timeout: 60_000 }, async () => {
  // Not under /tmp when avoidable: every mission writes it, so a home inside it is listed whole.
  const runtime = process.env.XDG_RUNTIME_DIR;
  const base = runtime && existsSync(runtime) ? runtime : tmpdir();
  const root = realpathSync(mkdtempSync(join(base, 'agy-fence-')));
  setDeclaredCredentialDirsSource(declaredDirs);
  try {
    const home = join(root, 'home');
    const th = join(home, '.timon');
    const cwd = join(th, 'worktrees', 'task-agy');
    const own = join(home, '.gemini', 'antigravity-cli');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(own, { recursive: true });
    const fence = createLandlockFence({ status: () => ({ state: 'ready', binary: BIN as string, abi: PROBE?.abi ?? 0, seccomp: true }) });
    const launch = fenceMissionCommand(AGY as string, ['acp'], 'unit-agy', {
      timonHome: th, home, cwd, missionId: MISSION, backend: 'antigravity', platform: 'linux',
    }, { mode: 'enforce', fence, warn: () => {} });
    assert.ok(launch.fence?.state === 'fenced' && launch.fence.tmpDir);
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, TMPDIR: launch.fence.tmpDir, AGY_ADC_AUTH: '', GEMINI_API_KEY: '', ...antigravityKeychainEnv('linux') };
    const child = spawn(launch.cmd, launch.args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.resume();
    const replies = new Map<number, (reply: Reply) => void>();
    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        try {
          const reply = JSON.parse(line) as Reply;
          if (typeof reply.id === 'number') replies.get(reply.id)?.(reply);
        } catch { /* agy's own output, not a reply */ }
      }
    });
    let next = 0;
    const ask = (method: string, params: unknown): Promise<Reply> => new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => reject(new Error(`${method}: no answer within 20 s`)), 20_000);
      replies.set(id, (reply) => { clearTimeout(timer); resolve(reply); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    try {
      const init = await ask('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
      assert.equal(init.error, undefined, 'agy starts and speaks ACP inside the fence');
      const started = Date.now();
      const session = await ask('session/new', { cwd, mcpServers: [] });
      assert.equal(session.error?.code, -32000, 'no sign-in on this home: auth_required');
      assert.ok(Date.now() - started < 10_000, 'answered at once, with no wait on the keychain');
    } finally {
      child.kill('SIGKILL');
    }
    // The folder the provider declares is the one agy writes: its log lands there.
    assert.ok(existsSync(join(own, 'log')) && readdirSync(join(own, 'log')).length > 0, 'agy wrote its log in its declared folder');
  } finally {
    setDeclaredCredentialDirsSource(() => ({}));
    rmSync(root, { recursive: true, force: true });
  }
});
