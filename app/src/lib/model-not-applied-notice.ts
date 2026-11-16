/**
 * The sentence rendered in the thread when an agent kept another model or
 * thinking level than the mission asked for (persisted `model_not_applied`
 * event, orchestrator/src/backends/acp/driver.ts).
 *
 * The mission still runs: without this line, its answers would come from a
 * model nobody chose, and nothing on screen would say so.
 */
import { t } from './i18n';

/** Payload of the `model_not_applied` event. */
export type ModelNotAppliedPayload = {
  backend?: unknown;
  requested_model?: unknown;
  active_model?: unknown;
  model_reason?: unknown;
  requested_effort?: unknown;
  effort_reason?: unknown;
};

const REASON_CHARS = 400;

function text(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function reason(value: unknown): string {
  const raw = text(value).replace(/\.$/, '');
  return raw.length > REASON_CHARS ? `${raw.slice(0, REASON_CHARS)}…` : raw || '?';
}

/** Null when the payload names nothing that was refused. */
export function modelNotAppliedNotice(payload: ModelNotAppliedPayload): string | null {
  const backend = text(payload.backend) || '?';
  const parts: string[] = [];
  const model = text(payload.requested_model);
  if (model) {
    const active = text(payload.active_model);
    const vars = { backend, model, reason: reason(payload.model_reason) };
    parts.push(active
      ? t('chatPage.modelNotApplied', { ...vars, active })
      : t('chatPage.modelNotAppliedDefault', vars));
  }
  const effort = text(payload.requested_effort);
  if (effort) parts.push(t('chatPage.effortNotApplied', { backend, effort, reason: reason(payload.effort_reason) }));
  return parts.length ? parts.join(' ') : null;
}
