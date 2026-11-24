/**
 * `/api/agents/:name/extra-dirs`: the folders outside its working directory
 * an agent's missions may read or write (`agent-extra-dirs.ts`, TODO #505).
 *
 *   GET    → { agent, extra_dirs, dropped, running }
 *   PUT    { extra_dirs: [{ path, mode }], restart? }  the whole list
 *   POST   { path, mode, restart? }                     adds a folder, or changes its mode
 *   DELETE { path, restart? }                           removes a folder
 *
 * A write answers like GET, plus `restarted`. The fence is fixed when a
 * mission's process starts: a running process keeps the folders it was
 * launched with (`running` counts them) until it ends, or until the write
 * asks `restart: true`, which stops them; the next turn starts a new process
 * that resumes the same conversation.
 *
 * Who writes: a person, or a mission whose account holds
 * `agents:privileged-config`, never for its own agent — an agent does not
 * grant itself folders. Every route refuses an anonymous caller, even on the
 * first-run loopback where `rejectIfDenied` alone lets one through. Each path
 * must be an existing folder that `extraDirFenceProblem` accepts: never the
 * Timon home nor one of its ancestors, never a folder of credentials.
 */
import type express from 'express';
import type { Request, Response } from 'express';
import { resolve } from 'node:path';
import { z } from 'zod';
import { apiError } from '../../api-error.js';
import { canonicalAgentName, killRunningForAgent, publishAgentUpdated, runningCountForAgent } from '../../agent.js';
import {
  agentExtraDirs, ExtraDirError, extraDirProblem, extraDirSchema, extraDirsSchema, normalizeExtraDirs, setAgentExtraDirs,
  type AgentExtraDir,
} from '../../agent-extra-dirs.js';
import { isValidAgentName } from '../../agent-config.js';
import { delegatingAgent } from '../../delegation-guard.js';
import { agentDir } from '../../paths.js';
import { existsSync } from 'node:fs';
import { rejectIfDenied, rejectUnlessAny, requestHasPermission } from '../../users/identity.js';
import { PRIVILEGED_CONFIG_PERMISSION, rejectOverride } from '../../users/privileged-overrides.js';

const restartField = { restart: z.boolean().optional() };
const putSchema = z.object({ extra_dirs: extraDirsSchema, ...restartField }).strict();
const postSchema = extraDirSchema.extend(restartField).strict();
const deleteSchema = z.object({ path: z.string().trim().min(1).max(4096), ...restartField }).strict();

/** The agent the route names, as its folder spells it, or null after a 404 was sent. */
function targetAgent(req: Request, res: Response): string | null {
  const raw = String(req.params.name ?? '');
  const name = isValidAgentName(raw) ? canonicalAgentName(raw) : null;
  if (!name || !existsSync(agentDir(name))) {
    res.status(404).json(apiError('agent_not_found', `agent not found: ${raw}`));
    return null;
  }
  return name;
}

function rejectAnonymous(req: Request, res: Response): boolean {
  if (req.auth) return false;
  res.status(401).json({ error: 'unauthorized' });
  return true;
}

/**
 * Why `req` may not change the folders of `agent`, after the response was
 * sent; `false` when it may. Removing a folder takes the same rights as
 * adding one: the list is one setting, and its writer one kind of caller.
 */
function rejectWriter(req: Request, res: Response, agent: string): boolean {
  if (rejectAnonymous(req, res)) return true;
  if (rejectIfDenied(req, res, 'agents:manage')) return true;
  if (!requestHasPermission(req, PRIVILEGED_CONFIG_PERMISSION)) {
    return rejectOverride(req, res, 'agent.extra_dirs_denied', `agent:${agent}`,
      `changing the folders an agent may reach needs the ${PRIVILEGED_CONFIG_PERMISSION} permission: a person sets them from the agent's page of the app`);
  }
  const caller = delegatingAgent(req);
  if (caller !== null && caller.normalize('NFC').toLowerCase() === agent.normalize('NFC').toLowerCase()) {
    return rejectOverride(req, res, 'agent.extra_dirs_denied', `agent:${agent}`,
      'an agent never changes the folders its own missions may reach: a person does it from the agent\'s page of the app');
  }
  return false;
}

/** The stored folders that a launch would leave out now, with the reason (a folder removed since, a fence rule). */
function droppedDirs(dirs: readonly AgentExtraDir[]): Array<{ path: string; reason: string }> {
  return dirs.flatMap((dir) => {
    const reason = extraDirProblem(dir.path);
    return reason ? [{ path: dir.path, reason }] : [];
  });
}

function view(agent: string, dirs: readonly AgentExtraDir[]): Record<string, unknown> {
  return { agent, extra_dirs: dirs, dropped: droppedDirs(dirs), running: runningCountForAgent(agent) };
}

export function registerExtraDirsRoutes(app: express.IRouter): void {
  app.get('/api/agents/:name/extra-dirs', (req, res) => {
    if (rejectAnonymous(req, res)) return;
    if (rejectUnlessAny(req, res, ['agents:read', 'agents:manage'])) return;
    const agent = targetAgent(req, res);
    if (!agent) return;
    res.json(view(agent, agentExtraDirs(agent)));
  });

  const write = (
    req: Request,
    res: Response,
    next: (current: AgentExtraDir[]) => unknown,
    restart: boolean | undefined,
  ): void => {
    const agent = targetAgent(req, res);
    if (!agent) return;
    if (rejectWriter(req, res, agent)) return;
    const before = agentExtraDirs(agent);
    let dirs: AgentExtraDir[];
    try {
      dirs = normalizeExtraDirs(next(before), before);
    } catch (err) {
      if (err instanceof ExtraDirError) {
        res.status(400).json(apiError('extra_dir_refused', err.message, err.path ? { path: err.path } : undefined));
        return;
      }
      throw err;
    }
    const stored = setAgentExtraDirs(agent, dirs);
    if (JSON.stringify(before) !== JSON.stringify(stored)) publishAgentUpdated(agent, ['extra_dirs']);
    const restarted = restart ? killRunningForAgent(agent) : 0;
    res.json({ ...view(agent, stored), restarted });
  };

  app.put('/api/agents/:name/extra-dirs', (req, res) => {
    if (rejectAnonymous(req, res)) return;
    const body = putSchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json(apiError('extra_dirs_invalid', 'expected { extra_dirs: [{ path, mode: "read" | "write" }], restart? }'));
      return;
    }
    write(req, res, () => body.data.extra_dirs, body.data.restart);
  });

  app.post('/api/agents/:name/extra-dirs', (req, res) => {
    if (rejectAnonymous(req, res)) return;
    const body = postSchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json(apiError('extra_dirs_invalid', 'expected { path, mode: "read" | "write", restart? }'));
      return;
    }
    const { path, mode } = body.data;
    write(req, res, (current) => {
      const key = resolve(path);
      const kept = current.filter((d) => resolve(d.path) !== key);
      return [...kept, { path, mode }];
    }, body.data.restart);
  });

  app.delete('/api/agents/:name/extra-dirs', (req, res) => {
    if (rejectAnonymous(req, res)) return;
    const body = deleteSchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json(apiError('extra_dirs_invalid', 'expected { path, restart? }'));
      return;
    }
    const key = resolve(body.data.path);
    write(req, res, (current) => current.filter((d) => resolve(d.path) !== key), body.data.restart);
  });
}
