/**
 * Who may run a workflow `script` node (TODO #685).
 *
 * A script node runs a program on the host under the daemon's OS account —
 * `~/.timon/daemon-token` is readable from there. It is held to the rule of
 * a trigger's `script` action (`triggers/script-run.ts`, SECURITY.md §9.2):
 *
 *  - the run acts as the workflow's OWNER, whose account must hold
 *    `scripts:run`, checked at publish and again at every run (a revoked
 *    grant stops the next run, not the next publish);
 *  - an agent never writes, publishes or runs script content a person has not
 *    put there, whatever its token holds (a developer-owner mission carries
 *    every permission): it proposes the change (`workflow_propose`) and a
 *    person accepts it;
 *  - the local files a node runs are fingerprinted when a person saves a
 *    script node they added or changed, publishes the workflow or re-approves
 *    its scripts, and checked again right before every run: the project
 *    folder is one missions write in, so a file rewritten since, or a
 *    workflow saved before this check existed, runs nothing until a person
 *    approves it (the trigger's own check, reused). Saving the rest of the
 *    draft approves nothing.
 */
import { mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { db, dbApi, type WorkflowRow } from '../../db.js';
import { TIMON_HOME } from '../../paths.js';
import { userAllows } from '../../users/permissions.js';
import { pinFor, pinScript, scriptPinProblem, type ScriptPlace, type ScriptRun } from '../../triggers/script-run.js';
import { scriptPinSchema, type ScriptPin } from '../../triggers/store.js';

export const SCRIPT_NODE_PERMISSION = 'scripts:run';

/** What an agent reads when it adds or changes a script node. */
export const SCRIPT_NODE_AGENT_REFUSAL = 'an agent cannot add, change, publish or run an unpublished script node: '
  + 'propose the change with workflow_propose for the user to accept, or ask the user';

type NodeLike = { id: string; type: string; config: Record<string, unknown> };

/**
 * Why `ownerUserId` may not run a script node, or `null`. No account on the
 * install (open setup) and no owner, or the daemon-token as owner, both mean
 * the operator's own workflow. Anything else must be an active account holding
 * `scripts:run`: a plugin or a system token is refused, failing closed.
 */
export function scriptNodeDenied(ownerUserId: string | null): string | null {
  if (dbApi.countUsers() === 0 || ownerUserId === null || ownerUserId === 'daemon-token') return null;
  if (ownerUserId.startsWith('plugin:')) return 'not permitted: a plugin cannot own a workflow that runs a script';
  const owner = dbApi.getUserById(ownerUserId);
  if (!owner || owner.status !== 'active') return 'not permitted: the workflow owner is not an active account';
  if (!userAllows(owner, dbApi.listPermissionsForUser(owner.id), SCRIPT_NODE_PERMISSION)) {
    return `not permitted: a script node needs ${SCRIPT_NODE_PERMISSION} on the workflow owner's account`;
  }
  return null;
}

/**
 * Publish refuses what the run would refuse, naming the node (a `ZodError`
 * so `describeWorkflowError` hands the builder its per-node issues).
 */
export function assertScriptNodesAllowed(nodes: ReadonlyArray<NodeLike>, ownerUserId: string | null): void {
  const scripts = nodes.filter((node) => node.type === 'script');
  if (!scripts.length) return;
  const reason = scriptNodeDenied(ownerUserId);
  if (!reason) return;
  throw new z.ZodError(scripts.map((node): z.core.$ZodIssue => ({ code: 'custom', message: `${reason} (${node.id})`, path: ['nodes', node.id], input: node.config })));
}

/** Key order aside: a stored config and the same one sent back by the builder. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
    : v));
}

/**
 * Ids of the script nodes of `next` that `previous` does not hold as they are
 * (added, or config changed). A script node kept untouched is not the
 * caller's doing: an agent may still edit the rest of a workflow a person
 * armed with a script.
 */
export function changedScriptNodes(next: ReadonlyArray<NodeLike>, previous: ReadonlyArray<NodeLike> | null | undefined): string[] {
  const before = new Map((previous ?? []).filter((node) => node.type === 'script').map((node) => [node.id, canonical(node.config)]));
  return next.filter((node) => node.type === 'script' && before.get(node.id) !== canonical(node.config)).map((node) => node.id);
}

/**
 * The folder a script node runs in: its `cwd` inside the workflow's project,
 * or inside the workflow's own folder under the Timon home when it has none.
 */
export function scriptNodeFolder(workflow: Pick<WorkflowRow, 'slug' | 'project'>, configCwd: string | undefined): { allowed: string; cwd: string } {
  const projectCwd = workflow.project ? dbApi.getProjectRow(workflow.project)?.cwd : null;
  const fallback = join(TIMON_HOME, 'workflows', workflow.slug); mkdirSync(fallback, { recursive: true });
  const allowed = projectCwd ?? fallback;
  const cwd = configCwd ? resolve(allowed, configCwd) : allowed;
  if (cwd !== allowed && !cwd.startsWith(allowed + sep)) throw new Error('script cwd escapes workflow directory');
  return { allowed, cwd };
}

// ── approval of what a script node runs ─────────────────────────────────────

/** The approved fingerprints of a workflow's script nodes; none when unreadable, so nothing runs. */
export function getWorkflowScriptPins(workflowId: string): ScriptPin[] {
  const row = db.prepare(`SELECT pins FROM workflow_script_pins WHERE workflow_id = ?`).get(workflowId) as { pins: string } | undefined;
  if (!row) return [];
  try {
    return z.array(scriptPinSchema).parse(JSON.parse(row.pins));
  } catch (err) {
    console.warn(`[workflows] ${workflowId}: script approvals unreadable, none kept — ${(err as Error).message}`);
    return [];
  }
}

/** Replaces them all. Only a person's save, publish or re-approval calls this. */
export function setWorkflowScriptPins(workflowId: string, pins: readonly ScriptPin[]): void {
  if (!pins.length) { db.prepare(`DELETE FROM workflow_script_pins WHERE workflow_id = ?`).run(workflowId); return; }
  db.prepare(`INSERT INTO workflow_script_pins (workflow_id, pins) VALUES (?, ?) ON CONFLICT(workflow_id) DO UPDATE SET pins = excluded.pins`)
    .run(workflowId, JSON.stringify(pins));
}

export function deleteWorkflowScriptPins(workflowId: string): void {
  db.prepare(`DELETE FROM workflow_script_pins WHERE workflow_id = ?`).run(workflowId);
}

type ScriptWorkflow = Pick<WorkflowRow, 'id' | 'slug' | 'project'>;

/** What a person runs to approve the files as they are now. */
function reapproveHint(workflow: ScriptWorkflow): string {
  return `a person re-approves it with \`timon workflow approve-script ${workflow.slug}\`, or by publishing it again from the builder`;
}

/** Program, argv and folder of a node, as saved (the key of its approval); null when its config is not a script's. */
function scriptNodeRun(workflow: ScriptWorkflow, config: Record<string, unknown>): ScriptRun | { error: string } | null {
  const { bin, args, cwd } = config;
  if (typeof bin !== 'string' || !bin) return null;
  if (args !== undefined && !(Array.isArray(args) && args.every((arg) => typeof arg === 'string'))) return null;
  if (cwd !== undefined && typeof cwd !== 'string') return null;
  try {
    return { command: bin, args: (args as string[] | undefined) ?? [], cwd: scriptNodeFolder(workflow, cwd).cwd };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/**
 * Real paths the node's files are read under. Both resolved, and the folder
 * kept inside the allowed one: a link in the project must not lead the
 * fingerprint, nor the run, out of it.
 */
function scriptNodePlace(workflow: ScriptWorkflow, run: ScriptRun): ScriptPlace | { error: string } {
  const { allowed } = scriptNodeFolder(workflow, undefined);
  let root: string; let cwd: string;
  try { root = realpathSync(allowed); cwd = realpathSync(run.cwd); } catch { return { error: `cwd not found: ${run.cwd}` }; }
  const rel = relative(root, cwd);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return { error: 'script cwd escapes workflow directory' };
  return { cwd, project: workflow.project ?? '', root };
}

/**
 * How each group of nodes is approved:
 *  - `strict`: as its files are now, or with the approval it already had when
 *    they cannot be read today; otherwise the save is refused, naming the node;
 *  - `loose`: the same, but a node that cannot be read is left unapproved (a
 *    draft is work in progress: its runs are refused until it can be);
 *  - `keep`: only the approval it already had (a published node the person
 *    did not touch keeps running as approved, and is not re-approved).
 */
export type ScriptPinning = { strict?: ReadonlyArray<NodeLike>; loose?: ReadonlyArray<NodeLike>; keep?: ReadonlyArray<NodeLike> };

/**
 * Records the approvals a person gives by saving, publishing or re-approving
 * the workflow; what no group names is dropped. Refuses with a `ZodError`
 * naming each `strict` node that cannot be approved, and then writes nothing.
 * Returns the approvals kept.
 */
export function pinWorkflowScripts(workflow: ScriptWorkflow, groups: ScriptPinning, now: number = Date.now()): ScriptPin[] {
  const stored = getWorkflowScriptPins(workflow.id);
  const pins: ScriptPin[] = [];
  const add = (pin: ScriptPin) => { if (!pinFor(pins, pin)) pins.push(pin); };
  const issues: z.core.$ZodIssue[] = [];
  const modes: Array<[keyof ScriptPinning, ReadonlyArray<NodeLike>]> = [['strict', groups.strict ?? []], ['loose', groups.loose ?? []], ['keep', groups.keep ?? []]];
  for (const [mode, nodes] of modes) {
    for (const node of nodes) {
      if (node.type !== 'script') continue;
      const run = scriptNodeRun(workflow, node.config);
      if (!run) continue;
      const old = 'error' in run ? undefined : pinFor(stored, run);
      if (mode === 'keep') { if (old) add(old); continue; }
      let fresh: ScriptPin | { error: string };
      if ('error' in run) fresh = run;
      else {
        const place = scriptNodePlace(workflow, run);
        fresh = 'error' in place ? place : pinScript(run, place, now);
      }
      if (!('error' in fresh)) { add(fresh); continue; }
      if (old) { add(old); continue; }
      if (mode === 'strict') issues.push({ code: 'custom', message: `script ${String(node.config.bin)}: ${fresh.error} (${node.id})`, path: ['nodes', node.id], input: node.config });
    }
  }
  if (issues.length) throw new z.ZodError(issues);
  setWorkflowScriptPins(workflow.id, pins);
  return pins;
}

/**
 * Why this node must not run, or null, with the folder it runs in: no
 * approval recorded (a workflow saved before the check existed is not vouched
 * for by what happens to be on disk now), its files changed since, or they
 * can no longer be fingerprinted. Call it right before the spawn.
 */
export function scriptNodeApproval(workflow: ScriptWorkflow, config: Record<string, unknown>): { cwd: string; problem: string | null } {
  const run = scriptNodeRun(workflow, config);
  if (!run) throw new Error('script node needs a bin');
  if ('error' in run) throw new Error(run.error);
  const place = scriptNodePlace(workflow, run);
  if ('error' in place) return { cwd: run.cwd, problem: `${place.error}: ${reapproveHint(workflow)}` };
  return { cwd: run.cwd, problem: scriptPinProblem(getWorkflowScriptPins(workflow.id), run, place, reapproveHint(workflow)) };
}
