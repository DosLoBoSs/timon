/**
 * Another TIM, created from the main agent's setup conversation
 * (`setup_create_tim`), in the "Create another TIM" branch of the welcome.
 *
 * Why a narrow route instead of `agent_create`: the setup mission holds
 * `agents:manage`, but `agent_create` refuses a folder outside every registered
 * project, and the main agent's folder is usually not one. This route answers
 * THE setup conversation only, while the step is pending, and what it writes is
 * fixed here: the main agent's folder and model, reporting to it, one of the
 * roles the Agents page offers and the user's own words as the job. Never the
 * `orchestrator` role: it grants the orchestrator-only tools, and the cockpit
 * would draw the new TIM in the main agent's seat. A conversation cannot turn
 * this into a general agent factory: a handful of TIMs at most, and repeating
 * a call returns the TIM it already made instead of a copy.
 */
import { existsSync } from 'node:fs';
import { getAgent, loadConfig, upsertAgent, type AgentConfig } from './agent.js';
import { findAgentFolder } from './agent-config.js';
import { agentNameKey } from './agent-name.js';
import { getRole } from './agent-roles.js';
import { dbApi } from './db.js';
import { mainAgentName } from './main-agent.js';
import { defaultExcludedMcpIds } from './mcp.js';
import { MainAgentSetupError, toAgentName } from './onboarding-main-agent.js';
import { agentDir } from './paths.js';

/** The TIMs this step created, so a repeated call answers with them. */
export const SETUP_TIMS_KEY = 'onboarding.mainAgent.tims';

/** Enough for a first evening; more go through the "New TIM" button. */
export const SETUP_TIM_LIMIT = 3;

export type SetupTim = { name: string; role: string; created: boolean };

/** Roles a conversation may give: the orchestrator's tools stay with the agents the person sets up by hand. */
const FORBIDDEN_ROLES: ReadonlySet<string> = new Set(['orchestrator']);

function prompt(name: string, job: string | null, lead: string): string {
  return [
    `You are ${name}, one of the user's TIMs. ${lead} is their main agent and created you with them.`,
    ...(job ? [`Your job, in the user's words: ${job}`] : []),
    `Report to ${lead} when ${lead} hands you work. Respond in the user's language.`,
    'Work only when given a mission. Never create recurring jobs or start background work on your own. Ask before publishing, sending external messages or deleting anything.',
  ].join('\n\n');
}

function recorded(): string[] {
  const raw = dbApi.getAllSettings()[SETUP_TIMS_KEY];
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === 'string') : [];
  } catch { return []; }
}

/** The TIMs this step created that still exist. */
export function setupTims(): string[] {
  return recorded().filter((name) => existsSync(agentDir(name)));
}

/**
 * Creates one TIM under the name the agent proposes (a display name is turned
 * into an agent name, as for the main agent). `role` is a role id of the
 * Agents page (`coder`, `research`, `ops`…, or a custom one); `job` is what the
 * TIM does, in one or two sentences. Refused with `invalid_role` for an unknown
 * or forbidden role, `name_taken` when the name belongs to an agent this step
 * did not create, `tim_limit` past {@link SETUP_TIM_LIMIT}.
 */
export function createSetupTim(input: { name: string; role: string; job?: string }): SetupTim {
  const lead = mainAgentName();
  if (!lead || !getAgent(lead)) throw new MainAgentSetupError('main_agent_unavailable');
  const raw = input.name.trim();
  const role = input.role.trim();
  const job = input.job?.trim() || null;
  if (!raw) throw new MainAgentSetupError('invalid_name');
  if (FORBIDDEN_ROLES.has(role) || !getRole(role)) throw new MainAgentSetupError('invalid_role');
  const name = toAgentName(raw);
  if (agentNameKey(name) === agentNameKey(lead)) throw new MainAgentSetupError('name_taken');

  const mine = setupTims();
  const found = findAgentFolder(name);
  // A model that repeats the call after a reload gets the TIM it made, not a copy.
  if (found !== null && mine.includes(found)) {
    return { name: found, role: loadConfig(found).role ?? role, created: false };
  }
  // Any other existing agent is not ours to rewrite, whatever its case.
  if (found !== null) throw new MainAgentSetupError('name_taken');
  if (mine.length >= SETUP_TIM_LIMIT) throw new MainAgentSetupError('tim_limit');

  const main = loadConfig(lead);
  if (!main.cwd) throw new MainAgentSetupError('workspace_unavailable');
  const config: AgentConfig = {
    cwd: main.cwd,
    ...(main.backend ? { backend: main.backend } : {}),
    ...(main.model ? { model: main.model } : {}),
    role,
    permission_mode: 'default',
    reports_to: lead,
    // Like an agent made in the Agents page: external connectors one by one, never all at once.
    excluded_mcp_servers: defaultExcludedMcpIds(),
  };
  upsertAgent({ name, system_prompt: prompt(name, job, lead), config }, { createdBy: lead });
  dbApi.setSetting(SETUP_TIMS_KEY, JSON.stringify([...recorded().filter((n) => n !== name), name]));
  return { name, role, created: true };
}
