/**
 * A memory rule outlives its removal in every provider session that saw it.
 *
 * The rule reaches an agent through its system prompt, rebuilt at each spawn
 * (`collectMemoryInjection`), but a new mission resumes the agent's latest
 * session by default, and that session's history still holds the old prompt
 * and whatever the agent did because of it. Removing or rewriting a rule
 * therefore fences every agent it may have reached: from then on, a new
 * mission of those agents starts a fresh conversation instead of resuming a
 * session born before the fence (`dbApi.sessionFenced`, checked by
 * `resolveSpawnResume` for every backend alike).
 *
 * "May have reached" mirrors the recall's visibility filter (`searchRules`):
 * the agent itself for an agent rule, the agents of the project, of the role
 * (across projects or in the rule's project), every agent for a global rule.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './agent-config.js';
import { dbApi, type MemoryRuleRow } from './db.js';
import { AGENTS_DIR } from './paths.js';
import { projectFromCwd } from './task-project.js';

type RuleTarget = Pick<MemoryRuleRow, 'scope' | 'project' | 'agent' | 'role'>;
type AgentTarget = { name: string; project: string | null; role: string | null };

function installedAgents(): AgentTarget[] {
  if (!existsSync(AGENTS_DIR)) return [];
  const out: AgentTarget[] = [];
  for (const name of readdirSync(AGENTS_DIR)) {
    try {
      if (!statSync(join(AGENTS_DIR, name)).isDirectory()) continue;
      const cfg = loadConfig(name);
      // Same resolution as the recall: a different one would fence the wrong agents.
      out.push({ name, project: cfg.project ?? projectFromCwd(cfg.cwd), role: cfg.role ?? null });
    } catch {
      // An unreadable config still names an agent that may hold a session.
      out.push({ name, project: null, role: null });
    }
  }
  return out;
}

function reaches(rule: RuleTarget, agent: AgentTarget): boolean {
  switch (rule.scope) {
    case 'agent': return !!rule.agent && rule.agent.toLowerCase() === agent.name.toLowerCase();
    case 'project': return !!rule.project && rule.project === agent.project;
    case 'role': return !!rule.role && rule.role === agent.role && (rule.project == null || rule.project === agent.project);
    case 'global': return true;
    // A scope the recall does not know was never injected; fencing everyone is the safe reading.
    default: return true;
  }
}

/** Names of the installed agents whose prompt the rule may have reached. */
export function agentsReachedByRule(rule: RuleTarget): string[] {
  const agents = installedAgents().filter((a) => reaches(rule, a)).map((a) => a.name);
  // An agent rule naming an agent with no folder (trashed, renamed by hand) still fences that name.
  if (rule.scope === 'agent' && rule.agent && agents.length === 0) agents.push(rule.agent);
  return agents.sort();
}

/**
 * Fences the agents the rule may have reached; returns their names, which
 * start a fresh conversation at their next mission.
 */
export function fenceSessionsForRule(rule: RuleTarget, at: number = Date.now()): string[] {
  const agents = agentsReachedByRule(rule);
  if (agents.length > 0) dbApi.fenceAgentSessions(agents, at);
  return agents;
}

/**
 * Whether an edit takes away from the agents something the rule used to tell
 * them: its text, its audience, or its being active at all. Raising its tier or
 * re-labelling its kind changes nothing an earlier session holds.
 */
export function ruleEditRevokes(before: MemoryRuleRow, after: MemoryRuleRow): boolean {
  if (before.text !== after.text) return true;
  if (before.scope !== after.scope || before.project !== after.project
    || before.agent !== after.agent || before.role !== after.role) return true;
  return before.status === 'active' && after.status !== 'active';
}
