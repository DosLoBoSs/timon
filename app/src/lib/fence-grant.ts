/**
 * "Allow for this agent": the card of a path the mission fence refused, when
 * the daemon offers a folder to open (TODO #1162). Mirrors `FenceRefusal` and
 * `FenceGrantResolution` (orchestrator/src/fence-refusal.ts, fence-grant.ts):
 * the app and the daemon are separate packages, no import possible.
 *
 * A refusal with no offer (the Timon home, a credential folder, a folder too
 * wide) is no card: its notice (`fence-refusal-notice.ts`) says it all. The
 * answer goes once, from the person's session, to the daemon, which checks
 * the folder again before it opens anything.
 */

export const FENCE_REFUSED_EVENT = 'fence_refused';
export const FENCE_GRANT_RESOLVED_EVENT = 'fence_grant_resolved';

export type FenceGrantMode = 'read' | 'write';
export type FenceGrantStatus = 'pending' | 'allowed' | 'refused';

export type FenceGrantView = {
  /** The refusal's id: what the answer names. */
  id: string;
  missionId: string;
  agent: string;
  /** The refused path, as displayed (`~` for the home). */
  display: string;
  access: FenceGrantMode;
  mechanism: 'landlock' | 'seatbelt';
  stage: 'launch' | 'run';
  /** The folder an accord adds, and the access it gives. */
  folder: { path: string; display: string; mode: FenceGrantMode };
  status: FenceGrantStatus;
  /** True once the mission was relaunched after the accord given here. */
  relaunched: boolean | null;
};

export type FenceGrantResolution = { id: string; status: Exclude<FenceGrantStatus, 'pending'> };

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f\u0080-\u009f\u2028\u2029]/;

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() && !CONTROL_CHARS.test(value) ? value : null;
}

const mode = (value: unknown): FenceGrantMode | null => (value === 'read' || value === 'write' ? value : null);

/**
 * The card of a `fence_refused` payload, or null when it offers nothing: no
 * card is drawn for the Timon home or a credential folder, whatever the
 * payload says, since the daemon never offers them.
 */
export function parseFenceGrant(raw: unknown): FenceGrantView | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (p.grantable !== true || p.timonHome === true) return null;
  const grant = p.grant && typeof p.grant === 'object' ? (p.grant as Record<string, unknown>) : null;
  const id = str(p.id);
  const missionId = str(p.missionId);
  const agent = str(p.agent);
  const access = mode(p.access);
  const folderPath = str(grant?.path);
  const folderMode = mode(grant?.mode);
  if (!id || !missionId || !agent || !access || !folderPath || !folderMode) return null;
  return {
    id,
    missionId,
    agent,
    display: str(p.display) ?? str(p.path) ?? folderPath,
    access,
    mechanism: p.mechanism === 'seatbelt' ? 'seatbelt' : 'landlock',
    stage: p.stage === 'launch' ? 'launch' : 'run',
    folder: { path: folderPath, display: str(grant?.display) ?? folderPath, mode: folderMode },
    status: 'pending',
    relaunched: null,
  };
}

export function parseFenceGrantResolution(raw: unknown): FenceGrantResolution | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const id = str(p.id);
  if (!id || (p.status !== 'allowed' && p.status !== 'refused')) return null;
  return { id, status: p.status };
}

/** The card once answered; an answer never goes back to pending. */
export function applyFenceGrantResolution(view: FenceGrantView, resolution: FenceGrantResolution): FenceGrantView {
  if (view.id !== resolution.id || view.status !== 'pending') return view;
  return { ...view, status: resolution.status };
}

export type FenceGrantAnswer =
  | { ok: true; view: FenceGrantView }
  /** `body`: the daemon's error, for `apiErrorMessage`; `status` 0 when nothing came back. */
  | { ok: false; status: number; body: unknown };

/** Sends the person's answer. A card already answered elsewhere comes back answered, not as an error. */
export async function answerFenceGrant(view: FenceGrantView, decision: 'allow' | 'refuse'): Promise<FenceGrantAnswer> {
  const url = `/api/ui/missions/${encodeURIComponent(view.missionId)}/fence-grants/${encodeURIComponent(view.id)}`;
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision }) });
  } catch {
    return { ok: false, status: 0, body: null };
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const resolution = parseFenceGrantResolution(body?.resolution);
  if (res.ok && resolution) {
    return { ok: true, view: { ...applyFenceGrantResolution(view, resolution), relaunched: body?.relaunched === true } };
  }
  if (res.status === 409 && resolution) return { ok: true, view: applyFenceGrantResolution(view, resolution) };
  return { ok: false, status: res.status, body };
}
