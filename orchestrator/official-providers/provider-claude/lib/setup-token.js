// @ts-check
/**
 * `claude setup-token` as the daemon plays it (`ProviderTokenDriver`): a long-lived token for the
 * host's launches, minted in the app through the same paste-code page as a sign-in.
 *
 * What the CLI does (read on Claude Code 2.1.322): it needs a terminal (through pipes it prints
 * nothing), draws its screen with column moves instead of spaces, prints the page's address twice
 * (inside an OSC 8 hyperlink, whose target is the whole address, and as visible text), reads the
 * code typed on its screen followed by Enter, then prints the token on a line of its own after
 * "Your OAuth token (valid for …):". A code it refuses leaves it open on "OAuth error: That code
 * wasn't accepted … Press Enter to retry". It stores nothing: the token exists only on its screen.
 *
 * @typedef {{ setClaudeToken(raw: string): void; claudeTokenStatus(): { configured: boolean } }} ClaudeTokenStore
 * @typedef {{ resetClaudeUsageCache(): void }} ClaudeUsageCache
 */
import { claudeAccountEnv } from './token.js';

/** The target of an OSC 8 hyperlink to the authorize page: the address in one piece. */
const LINK_TARGET = /\u001b\]8;[^;\u0007\u001b]*;(https:\/\/[^\u0007\u001b\s]*oauth\/authorize[^\u0007\u001b\s]*)/;
/** OSC strings, CSI sequences (colours, cursor and column moves) and the two-byte escapes (cursor save and restore included). */
const ESCAPES = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-9;?<>=!]*[ -/]*[@-~]|\u001b[@-Z\\-_78=>]/g;
const TOKEN = /sk-ant-oat[A-Za-z0-9_-]{20,4000}/;

/** The screen as text: a column move stands where a space was. */
export function screenText(output) {
  return output.replace(ESCAPES, ' ');
}

export function parseSetupTokenPrompt(output) {
  const link = LINK_TARGET.exec(output)?.[1];
  const url = link ?? /https:\/\/\S*oauth\/authorize\S*/.exec(screenText(output))?.[0];
  return url ? { kind: 'paste-code', url } : null;
}

/** The token, read only after the line that announces it: nothing else on the screen can pass for one. */
export function parseSetupToken(output) {
  const text = screenText(output);
  const announced = /OAuth\s+token\s+\(valid\s+for/.exec(text);
  if (!announced) return null;
  return TOKEN.exec(text.slice(announced.index))?.[0] ?? null;
}

export function setupTokenRejected(output) {
  return /OAuth\s+error/.test(screenText(output));
}

/**
 * @param {ClaudeTokenStore} token
 * @param {ClaudeUsageCache} usage
 */
export function claudeTokenDriver(token, usage) {
  return {
    args: () => ['setup-token'],
    // A throwaway folder, and no token of the daemon's: the CLI mints a new one for the person's account.
    env: (dir, base) => ({ ...base, ...claudeAccountEnv(dir), TERM: 'xterm-256color' }),
    parse: parseSetupTokenPrompt,
    token: parseSetupToken,
    rejected: setupTokenRejected,
    save(value) {
      token.setClaudeToken(value);
      usage.resetClaudeUsageCache();
    },
    stored: () => token.claudeTokenStatus().configured,
    ttlMs: 10 * 60_000,
  };
}
