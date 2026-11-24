/**
 * `POST /api/missions/:id/fence-grants/:refusalId` — a person's answer to the
 * "Allow for this agent" card of a path the mission fence refused (TODO #1162).
 *
 *   { decision: 'allow' }   adds the offered folder to the agent's extra folders,
 *                           then relaunches the mission: its fence is fixed when
 *                           its process starts, so the process is stopped and a
 *                           turn resumes the same conversation in a new one.
 *   { decision: 'refuse' }  closes the card; nothing changes.
 *
 * A gesture of a person only: a browser session or a paired device. The daemon
 * token (CLI, scripts) and a mission token are refused, whatever they hold: an
 * agent never opens a folder to itself, and nobody answers a card in its name.
 * Allowing also takes the rights of the agent's folder list
 * (`agents:manage` and `agents:privileged-config`, as on the agent's page).
 *
 * Nothing of the stored event is trusted by itself: the refusal must be one of
 * this mission's, still carry an offer, and the folder passes every check of
 * `normalizeExtraDirs` again — never the Timon home, an ancestor of it, a home
 * folder, a disk's root or a folder of credentials.
 */
import type { IRouter, Request, Response } from 'express';
import { resolve } from 'node:path';
import { z } from 'zod';
import { apiError } from '../../api-error.js';
import { publishAgentUpdated, restartMissionProcess } from '../../agent.js';
import { agentExtraDirs, ExtraDirError, normalizeExtraDirs, setAgentExtraDirs } from '../../agent-extra-dirs.js';
import { dbApi, type MissionRow } from '../../db.js';
import {
  fenceGrantTurn, findFenceRefusal, recordFenceGrant,
  type FenceGrantOffer, type FenceGrantResolution, type StoredFenceRefusal,
} from '../../fence-grant.js';
import { auditRequest } from '../../users/audit-actor.js';
import { isPersonAuth, rejectIfDenied, requestHasPermission, viewerFromRequest } from '../../users/identity.js';
import { PRIVILEGED_CONFIG_PERMISSION, rejectOverride } from '../../users/privileged-overrides.js';
import { scopedDb } from '../../users/scoped-db.js';
import { sendMissionTurn } from './routes.js';

const BodySchema = z.object({ decision: z.enum(['allow', 'refuse']) }).strict();
const RefusalId = z.string().min(1).max(64).regex(/^[A-Za-z0-9-]+$/);

/** Relaunches `mission` with `text` once its folder is open; true when the turn was delivered. */
export type FenceGrantRelaunch = (mission: MissionRow, text: string) => Promise<boolean>;

export async function relaunchAfterGrant(mission: MissionRow, text: string): Promise<boolean> {
  await restartMissionProcess(mission.id);
  const fresh = dbApi.getMission(mission.id) ?? mission;
  try {
    const outcome = await sendMissionTurn(fresh, { input: text }, null);
    if (outcome.status >= 300) {
      console.warn(`[fence] mission ${mission.id.slice(0, 8)} not relaunched after the accord: ${String(outcome.body.error ?? outcome.status)}`);
    }
    return outcome.status < 300;
  } catch (err) {
    console.warn(`[fence] mission ${mission.id.slice(0, 8)} not relaunched after the accord: ${(err as Error).message}`);
    return false;
  }
}

/** The person answering, or null after the refusal was sent. */
function personOf(req: Request, res: Response): string | null {
  if (!req.auth) {
    res.status(401).json({ error: 'unauthorized' });
    return null;
  }
  if (!isPersonAuth(req.auth) || !req.auth.user) {
    res.status(403).json(apiError('fence_grant_session_required', 'a fence card is answered by a person, from the app'));
    return null;
  }
  return req.auth.user.id;
}

/** The agent's folders with `offer` in them: added, or widened to its mode in place. */
function withOffer(current: ReturnType<typeof agentExtraDirs>, offer: FenceGrantOffer): ReturnType<typeof agentExtraDirs> {
  const key = resolve(offer.path);
  const held = current.find((dir) => resolve(dir.path) === key);
  if (!held) return [...current, { path: offer.path, mode: offer.mode }];
  if (held.mode === 'write' || offer.mode === 'read') return current;
  return current.map((dir) => (resolve(dir.path) === key ? { path: dir.path, mode: offer.mode } : dir));
}

export function registerFenceGrantRoutes(app: IRouter, deps: { relaunch?: FenceGrantRelaunch } = {}): void {
  const relaunch = deps.relaunch ?? relaunchAfterGrant;

  app.post('/api/missions/:id/fence-grants/:refusalId', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const userId = personOf(req, res);
    if (!userId) return;
    const mission = scopedDb(viewerFromRequest(req)).getMission(String(req.params.id ?? ''));
    if (!mission) {
      res.status(404).json(apiError('mission_not_found', 'mission not found'));
      return;
    }
    const refusalId = RefusalId.safeParse(req.params.refusalId);
    const body = BodySchema.safeParse(req.body ?? {});
    if (!refusalId.success || !body.success) {
      res.status(400).json(apiError('fence_grant_invalid', 'expected { decision: "allow" | "refuse" }'));
      return;
    }
    const found = findFenceRefusal(mission.id, refusalId.data);
    const refusal: StoredFenceRefusal | undefined = found?.refusal;
    const offer = refusal && refusal.grantable && !refusal.timonHome && refusal.agent ? refusal.grant ?? null : null;
    if (!found || !refusal || !offer || !refusal.agent) {
      res.status(404).json(apiError('fence_refusal_not_found', 'this mission holds no fence refusal a person may answer with that id'));
      return;
    }
    if (found.resolution) {
      res.status(409).json({ ...apiError('fence_grant_settled', 'this card was already answered'), resolution: found.resolution });
      return;
    }
    const agent = refusal.agent;

    if (body.data.decision === 'refuse') {
      const resolution: FenceGrantResolution = { id: refusalId.data, status: 'refused', path: null, mode: null, resolvedAt: Date.now() };
      recordFenceGrant(mission.id, resolution);
      auditRequest(req, 'mission.fence_grant.refuse', `mission:${mission.id} ${offer.path}`);
      res.json({ ok: true, resolution, relaunched: false });
      return;
    }

    // The rights of the agent's folder list, as on its page.
    if (rejectIfDenied(req, res, 'agents:manage')) return;
    if (!requestHasPermission(req, PRIVILEGED_CONFIG_PERMISSION)) {
      rejectOverride(req, res, 'agent.extra_dirs_denied', `agent:${agent}`,
        `opening a folder to an agent needs the ${PRIVILEGED_CONFIG_PERMISSION} permission`);
      return;
    }
    const before = agentExtraDirs(agent);
    let stored;
    try {
      stored = setAgentExtraDirs(agent, normalizeExtraDirs(withOffer(before, offer), before));
    } catch (err) {
      if (err instanceof ExtraDirError) {
        res.status(400).json(apiError('extra_dir_refused', err.message, err.path ? { path: err.path } : undefined));
        return;
      }
      if (err instanceof Error && /^agent not found/.test(err.message)) {
        res.status(404).json(apiError('agent_not_found', `agent not found: ${agent}`));
        return;
      }
      throw err;
    }
    if (JSON.stringify(before) !== JSON.stringify(stored)) publishAgentUpdated(agent, ['extra_dirs']);
    const resolution: FenceGrantResolution = { id: refusalId.data, status: 'allowed', path: offer.path, mode: offer.mode, resolvedAt: Date.now() };
    recordFenceGrant(mission.id, resolution);
    auditRequest(req, 'mission.fence_grant.allow', `agent:${agent} ${offer.mode} ${offer.path}`);
    const relaunched = await relaunch(mission, fenceGrantTurn(refusal, offer));
    res.json({ ok: true, resolution, relaunched });
  });
}
