import type { IslandParams } from '@/lib/island-tree';
import { isValidAgentName, normalizeAgentName } from './agent-name-rule';

const MISSION = /^[A-Za-z0-9-]{1,64}$/;

/** `{ agent, mission, display }`. A `profile` handed by a source is dropped: the daemon
 *  resolves it from the agent (`components/browser-island.tsx`). Kept apart from
 *  the island so registering it does not load the browser view. */
export function parseBrowserIslandParams(raw: unknown): IslandParams | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { agent: rawAgent, mission, display } = raw as Record<string, unknown>;
  // The daemon's own rule for an agent name, in NFC as it stores them.
  const agent = typeof rawAgent === 'string' ? normalizeAgentName(rawAgent) : '';
  if (!isValidAgentName(agent)) return null;
  return {
    agent,
    mission: typeof mission === 'string' && MISSION.test(mission) ? mission : null,
    display: display === 'mobile' || display === 'desktop' ? display : 'auto',
  };
}
