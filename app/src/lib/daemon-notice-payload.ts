/**
 * An orchestrator notice in the reader's language (TODO #845).
 *
 * `notifyUser` (orchestrator/src/notify.ts) queues a JSON payload whose
 * `title` and `body` are English, the words agents read, and adds `code` and
 * `params` when the daemon wrote them. The Messages page reads the payload as a
 * mail: this rewrites its title and body in the reader's language and drops the
 * code, which is not something to show as a field. Any other payload comes back
 * as it was.
 */
import { daemonNotificationText, parseDaemonMessage } from './api-error';

export function localizedNoticePayload(payload: string): string {
  if (!payload.trimStart().startsWith('{')) return payload;
  let value: unknown;
  try { value = JSON.parse(payload); } catch { return payload; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return payload;
  const { code, params, ...rest } = value as Record<string, unknown>;
  if (!parseDaemonMessage({ code, params }) || typeof rest.title !== 'string') return payload;
  const english = { title: rest.title, body: typeof rest.body === 'string' ? rest.body : null };
  const shown = daemonNotificationText({ code, params }, english);
  return JSON.stringify({ ...rest, title: shown.title, ...(shown.body !== null ? { body: shown.body } : {}) });
}
