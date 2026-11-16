/**
 * A regular expression from a plugin's declaration, run with a time limit.
 *
 * V8's backtracking engine has no timeout of its own: a pattern like `(.*.*)*!$` on a few dozen characters
 * keeps the daemon's thread busy for minutes, and with it every mission. Here the match runs in a `vm`
 * script whose timeout interrupts it; the daemon goes on and the caller learns the pattern was too slow.
 *
 * The linear engine of trigger filters (`triggers/safe-regex.ts`) was not used: the SDK contracts that
 * hand us these patterns allow the whole RegExp syntax (lookarounds, backreferences), and a server's
 * `ready` pattern hands back its first capture group, which a yes/no automaton cannot give.
 */
import { createContext, Script } from 'node:vm';

/** A declared pattern matched against a few kilobytes takes microseconds; past this, it is backtracking out of control. */
export const REGEX_TIMEOUT_MS = 250;

export class SlowRegexError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`the regular expression ran past ${timeoutMs} ms`);
    this.name = 'SlowRegexError';
  }
}

export type BoundedRegex = {
  test(subject: string): boolean;
  /** The first capture group when it took part in the match, else the whole match; `null` when nothing matched. */
  firstGroup(subject: string): string | null;
};

const COMPILE = new Script('re = new RegExp(pattern, flags);');
const TEST = new Script('re.test(subject)');
const FIRST_GROUP = new Script('(() => { const m = re.exec(subject); return m === null ? null : (m[1] ?? m[0]); })()');

/**
 * Throws a `SyntaxError` of this realm when `pattern` is not a regular expression; `test` and `firstGroup`
 * throw `SlowRegexError` past `timeoutMs`. The context is made once, so a caller testing every chunk of a
 * process's output does not pay a new realm each time.
 */
export function compileBoundedRegex(pattern: string, flags = '', timeoutMs: number = REGEX_TIMEOUT_MS): BoundedRegex {
  // Compiling is linear in the pattern; doing it here first gives the caller a SyntaxError it can recognise.
  new RegExp(pattern, flags);
  const sandbox: { pattern: string; flags: string; subject: string } = { pattern, flags, subject: '' };
  const context = createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  const run = (script: Script, subject: string): unknown => {
    sandbox.subject = subject;
    try {
      return script.runInContext(context, { timeout: timeoutMs });
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw new SlowRegexError(timeoutMs);
      throw error;
    } finally {
      sandbox.subject = '';
    }
  };
  run(COMPILE, '');
  return {
    test: (subject) => run(TEST, subject) === true,
    firstGroup(subject) {
      const found = run(FIRST_GROUP, subject);
      return typeof found === 'string' ? found : null;
    },
  };
}
