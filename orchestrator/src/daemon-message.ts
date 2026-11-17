/**
 * A daemon text stored in the database that the webview can translate (TODO #845).
 *
 * Route errors carry their code in the answer (`api-error.ts`). A blocked reason
 * or a notification is written once and read later, by anyone: the English
 * sentence stays the column every reader knows (CLI, MCP, agents), and its code
 * plus params sit beside it, in a JSON column, for the webview to show
 * `daemonMessages.<code>` in the reader's language.
 *
 * A code is written only by the daemon's own producers. Any other writer of the
 * English column (an agent's reason, a person's edit) leaves the code NULL, so
 * the translation can never describe another sentence than the stored one.
 */
import { API_ERROR_CODE } from './plugins/contract/api-error.js';

export type DaemonMessageParams = Readonly<Record<string, string | number>>;

export interface DaemonMessage {
  /** snake_case, a key segment under `daemonMessages`. */
  code: string;
  params: DaemonMessageParams;
}

/**
 * `daemonMessage('task_interrupted', { reason })`. A malformed code throws, as
 * `apiError` does: a programming error, caught by the first test. Params that are
 * neither a string nor a finite number are dropped.
 */
export function daemonMessage(code: string, params: Record<string, unknown> = {}): DaemonMessage {
  if (!API_ERROR_CODE.test(code)) throw new TypeError(`daemonMessage: code must be snake_case, got "${code}"`);
  const kept: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(params)) {
    if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) kept[name] = value;
  }
  return { code, params: kept };
}

/**
 * The column value. `redact` masks every string param: a param carries the same
 * prose as the English column (a backend's last error, a review's feedback), and
 * must hide what that column hides.
 */
export function encodeDaemonMessage(
  message: DaemonMessage | null | undefined,
  redact: (text: string) => string,
): string | null {
  return message ? JSON.stringify(redactDaemonMessage(message, redact)) : null;
}

/** `message` with every string param passed through `redact`. */
export function redactDaemonMessage(message: DaemonMessage, redact: (text: string) => string): DaemonMessage {
  const params: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(message.params)) {
    params[name] = typeof value === 'string' ? redact(value) : value;
  }
  return { code: message.code, params };
}

/** The stored value read back; `null` for a NULL, a malformed or a foreign value. */
export function decodeDaemonMessage(raw: string | null | undefined): DaemonMessage | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { code?: unknown; params?: unknown };
    if (typeof value.code !== 'string' || !API_ERROR_CODE.test(value.code)) return null;
    const params = value.params && typeof value.params === 'object' && !Array.isArray(value.params)
      ? value.params as Record<string, unknown>
      : {};
    return daemonMessage(value.code, params);
  } catch {
    return null;
  }
}
