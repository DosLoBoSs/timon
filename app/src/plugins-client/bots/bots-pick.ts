/**
 * A pick in the rail of bots, carried out against the island bus.
 *
 * Outside `/bots` the rail drives one chat: the first pick opens it, the next
 * ones re-target it (`setIslandTabParams`) instead of stacking a chat per bot.
 * The link is the id of the tab the rail opened, kept here and not in the
 * rail: the drawer's rail and the island's rail drive the same chat. A tab id
 * is unique, so a link left by another view or a closed tab matches nothing.
 */

import { activateIslandTab, openIslandTab, setIslandTabParams, type IslandBusSnapshot } from '@/lib/island-bus';
import type { TabId } from '@/lib/island-tree';
import { botsHref, routeBotPick } from './bots-islands';

let driven: TabId | null = null;

/**
 * Picks `agent` from a rail painted on `pathname`: `null` once the workspace
 * took the pick, else the `/bots` address to navigate to (on `/bots` itself,
 * without a workspace, or when the workspace refused to open the chat).
 */
export function pickBot(input: {
  agent: string;
  pathname: string;
  bus: Pick<IslandBusSnapshot, 'present' | 'tabs'>;
  inIsland: boolean;
}): string | null {
  const pick = routeBotPick({
    agent: input.agent,
    pathname: input.pathname,
    workspace: input.bus.present,
    tabs: input.bus.tabs,
    inIsland: input.inIsland,
    driven,
  });
  switch (pick.kind) {
    case 'route':
      return pick.href;
    case 'activate':
      activateIslandTab(pick.tabId);
      return null;
    case 'retarget':
      if (setIslandTabParams(pick.tabId, pick.params)) {
        activateIslandTab(pick.tabId);
        return null;
      }
      // The chat is gone or refused the bot: the rail opens a new one.
      driven = null;
      return pickBot(input);
    case 'open': {
      const tabId = openIslandTab(pick.content, { edge: pick.edge });
      if (!tabId) return botsHref(input.agent);
      driven = tabId;
      return null;
    }
  }
}

/** Forgets the chat the rail drives. Tests only. */
export function forgetDrivenBotChatForTests(): void {
  driven = null;
}
