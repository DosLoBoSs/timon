/**
 * The sentence rendered in the thread when the mission fence refused a path
 * (persisted `fence_refused` event, orchestrator/src/fence-refusal.ts).
 *
 * Pure, like `spawn-failure-notice.ts`. Before this notice a refusal of the fence
 * read as the CLI's own "Operation not permitted": nothing named the fence, the
 * path, or Settings › System › Security, where it is changed.
 */
import { t } from './i18n';

/** Payload of the `fence_refused` event: the daemon's `FenceRefusal`. Read defensively. */
export type FenceRefusedPayload = {
  path?: unknown;
  display?: unknown;
  access?: unknown;
  mechanism?: unknown;
  stage?: unknown;
  backend?: unknown;
  timonHome?: unknown;
  grantable?: unknown;
};

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

/** `launch`: the mission never started, and this notice is all its thread says. */
export function fenceRefusalEndsTurn(payload: FenceRefusedPayload): boolean {
  return payload.stage === 'launch';
}

export function fenceRefusalNotice(payload: FenceRefusedPayload): string {
  const vars = {
    path: text(payload.display, text(payload.path, '?')),
    access: payload.access === 'write' ? 'write' : 'read',
    mechanism: payload.mechanism === 'seatbelt' ? 'seatbelt' : 'landlock',
    backend: text(payload.backend, '?'),
    stage: payload.stage === 'launch' ? 'launch' : 'run',
  };
  // The gesture depends on where the path is: a defect of Timon has a workaround,
  // a credential folder none, any other folder an exception.
  if (payload.timonHome === true) return t('chatPage.fenceRefusedTimonHome', vars);
  if (payload.grantable === true) return t('chatPage.fenceRefusedGrantable', vars);
  return t('chatPage.fenceRefusedProtected', vars);
}
