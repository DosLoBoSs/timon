/**
 * The rule an agent name follows. The name is the agent's folder under
 * `agents/`, so the rule is the intersection of what every supported file
 * system accepts as one plain path segment, in any script.
 *
 * Source of truth: `orchestrator/src/agent-name.ts`. `app/src/lib/agent-name-rule.ts`
 * and `desktop/src/agent-name-rule.ts` are verbatim copies (three independent
 * packages, as for `brand.ts`); a parity test in each compares them to this file.
 * Pure: no Node API, the web client runs it in the browser.
 */

/** In UTF-8 bytes, not characters: about 26 Chinese characters, 80 Latin ones. */
export const AGENT_NAME_MAX_BYTES = 80;

/**
 * Letters, marks and digits of any script, plus `.`, `_` and `-`. The first
 * character is a letter, a digit or `_` (`_main`, the ephemeral `_eph-…`
 * agents): never `.` (a hidden folder, `..`), `-` (read as an option by a
 * command line) or a mark (it would combine with nothing). Emoji, spaces,
 * control and bidirectional formatting characters are outside the classes.
 */
export const AGENT_NAME_RE = /^[\p{L}\p{N}_][\p{L}\p{M}\p{N}._-]*$/u;

/** Device names Windows reserves in every folder, with or without an extension. */
const WINDOWS_RESERVED_RE = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/iu;

/** Every name is stored and compared in NFC: macOS input may arrive decomposed. */
export function normalizeAgentName(raw: string): string {
  return raw.normalize('NFC');
}

/** The form two names are compared in: a case-insensitive disk (Windows, macOS) merges what differs only by case. */
export function agentNameKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

export function agentNameBytes(name: string): number {
  return new TextEncoder().encode(name).length;
}

export function isWindowsReservedName(name: string): boolean {
  return WINDOWS_RESERVED_RE.test(name.split('.')[0] ?? '');
}

/**
 * True for a name already in NFC that follows the rule. A trailing `.` is
 * refused because Windows drops it (`foo.` opens `foo`).
 */
export function isValidAgentName(name: string): boolean {
  return name.length > 0
    && name === name.normalize('NFC')
    && agentNameBytes(name) <= AGENT_NAME_MAX_BYTES
    && AGENT_NAME_RE.test(name)
    && !name.endsWith('.')
    && !isWindowsReservedName(name);
}

/** The first `max` bytes of `value`, cut between code points. */
function clipBytes(value: string, max: number): string {
  let out = '';
  let bytes = 0;
  for (const char of value) {
    const size = agentNameBytes(char);
    if (bytes + size > max) break;
    out += char;
    bytes += size;
  }
  return out;
}

/**
 * A display name typed by a human → a valid agent name, never empty. Letters
 * of every script and their accents are kept; a run of anything else (spaces,
 * punctuation, emoji) becomes one `-`. `agent` when nothing usable is left.
 */
export function toAgentName(raw: string): string {
  const name = clipBytes(
    normalizeAgentName(raw)
      .replace(/[^\p{L}\p{M}\p{N}._-]+/gu, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[^\p{L}\p{N}_]+/u, ''),
    AGENT_NAME_MAX_BYTES,
  ).replace(/[-.]+$/, '');
  return isValidAgentName(name) ? name : 'agent';
}
