/**
 * The GitHub CLI, as the daemon runs it for a project's integration setting
 * (`docs/KANBAN-PR-PIPELINE.md` §2.5, §3.2).
 *
 * One rule: `gh` acts as the account of the config folder the project names,
 * never as whatever the daemon's environment happens to hold. A `GH_TOKEN` or
 * `GITHUB_TOKEN` in that environment wins over every config folder, so it is
 * removed whenever a folder is named; prompts are off, since nobody can answer
 * one behind the daemon.
 *
 * The folder's content is never read by Timon, and its path never reaches a
 * log or an error: only `gh` opens it.
 */
import type { ExecOpts, ExecResult } from './types.js';
import { getHost } from './index.js';

/** Variables through which a token overrides the config folder. */
const TOKEN_VARIABLES = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'] as const;

/** The environment `gh` runs in for a project: its config folder, no token
 *  that would override it, no prompt, no update check. */
export function ghEnv(configDir: string | null, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };
  if (configDir) {
    env.GH_CONFIG_DIR = configDir;
    for (const name of TOKEN_VARIABLES) delete env[name];
  }
  return env;
}

export type GhRunner = (args: string[], opts: ExecOpts) => Promise<ExecResult>;

const hostRunner: GhRunner = (args, opts) => getHost().execAsync('gh', args, opts);

export type GhLoginOutcome =
  | { ok: true; login: string }
  | { ok: false; code: 'gh_missing' | 'gh_failed' | 'timed_out' | 'unexpected_answer'; reason: string };

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const TIMEOUT_MS = 20_000;

/** What gh said, short, without anything shaped like a token. */
function redacted(text: string): string {
  return text
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[redacted]')
    .trim()
    .slice(0, 300);
}

/**
 * The login `gh` answers for with `configDir` (`gh api user`): one network
 * call to the forge, which the caller asks for explicitly.
 */
export async function ghLogin(configDir: string | null, run: GhRunner = hostRunner): Promise<GhLoginOutcome> {
  let result: ExecResult;
  try {
    result = await run(['api', 'user', '--jq', '.login'], { env: ghEnv(configDir), timeout: TIMEOUT_MS });
  } catch {
    return { ok: false, code: 'gh_missing', reason: 'the GitHub CLI (gh) was not found on this machine' };
  }
  if (result.timedOut) return { ok: false, code: 'timed_out', reason: 'gh did not answer in time' };
  if (result.code !== 0) {
    return { ok: false, code: 'gh_failed', reason: redacted(result.stderr || result.stdout) || `gh exited with code ${result.code}` };
  }
  const login = result.stdout.trim();
  if (!GITHUB_LOGIN.test(login)) return { ok: false, code: 'unexpected_answer', reason: 'gh did not answer a GitHub login' };
  return { ok: true, login };
}
