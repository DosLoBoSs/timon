/**
 * Picks in the rail of bots outside `/bots`, against a workspace announced on
 * the island bus: the first pick opens a chat, the next ones re-target it, so
 * two bots picked in a row leave one chat island, not two.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { CHAT_ISLAND_TYPE } from '@/lib/chat-island-params';
import * as bus from '@/lib/island-bus';
import type { IslandContent, IslandParams, IslandTab } from '@/lib/island-tree';
import { forgetDrivenBotChatForTests, pickBot } from './bots-pick';

function fakeWorkspace(t: test.TestContext, { refuse = false }: { refuse?: boolean } = {}) {
  let tabs: IslandTab[] = [];
  let next = 0;
  const activated: string[] = [];
  const handle: bus.IslandWorkspaceHandle = {
    open: (content) => handle.openTab!(content, 'right') !== null,
    openTab: (content: IslandContent) => {
      if (refuse) return null;
      const tab = { id: `tab-${++next}`, content };
      tabs = [...tabs, tab];
      bus.publishIslandTabs(handle, tabs, false);
      return tab.id;
    },
    setParams: (tabId: string, params: IslandParams) => {
      if (!tabs.some((tab) => tab.id === tabId)) return false;
      tabs = tabs.map((tab) => (tab.id === tabId ? { ...tab, content: { ...tab.content, params } } : tab));
      bus.publishIslandTabs(handle, tabs, false);
      return true;
    },
    activate: (tabId) => { activated.push(tabId); },
    close: (tabId) => {
      tabs = tabs.filter((tab) => tab.id !== tabId);
      bus.publishIslandTabs(handle, tabs, false);
    },
  };
  const withdraw = bus.announceIslandWorkspace(handle);
  bus.publishIslandTabs(handle, tabs, false);
  forgetDrivenBotChatForTests();
  t.after(() => { withdraw(); forgetDrivenBotChatForTests(); });
  const snapshot = () => ({ present: true, tabs });
  const chats = () => tabs.filter((tab) => tab.content.type === CHAT_ISLAND_TYPE);
  const pick = (agent: string) => pickBot({ agent, pathname: '/kanban', bus: snapshot(), inIsland: true });
  return { pick, chats, activated, handle, add: (tab: IslandTab) => { tabs = [...tabs, tab]; } };
}

test('two bots picked in a row leave one chat island, re-targeted to the second', (t) => {
  const w = fakeWorkspace(t);
  assert.equal(w.pick('ada'), null);
  assert.deepEqual(w.chats().map((tab) => tab.content.params.agent), ['ada']);
  const [first] = w.chats();
  assert.equal(w.pick('bob'), null);
  assert.deepEqual(w.chats().map((tab) => [tab.id, tab.content.params]), [[first!.id, { agent: 'bob', missionId: null, fresh: false }]]);
  assert.deepEqual(w.activated, [first!.id], 'the re-targeted chat is brought forward');
  // Back to the first bot: still the same chat.
  w.pick('ada');
  assert.equal(w.chats().length, 1);
  assert.equal(w.chats()[0]!.content.params.agent, 'ada');
});

test('a chat the user opened elsewhere is never re-targeted', (t) => {
  const w = fakeWorkspace(t);
  w.add({ id: 'theirs', content: { type: CHAT_ISLAND_TYPE, params: { agent: 'cy', missionId: 'm1', fresh: false } } });
  w.pick('ada');
  w.pick('cy');
  assert.deepEqual(w.activated, ['theirs'], 'the open chat of that bot is activated');
  w.pick('bob');
  assert.deepEqual(w.chats().map((tab) => tab.content.params.agent).sort(), ['bob', 'cy']);
});

test('once the driven chat is closed, the next pick opens a new one', (t) => {
  const w = fakeWorkspace(t);
  w.pick('ada');
  w.handle.close(w.chats()[0]!.id);
  assert.equal(w.pick('bob'), null);
  assert.deepEqual(w.chats().map((tab) => tab.content.params.agent), ['bob']);
});

test('a workspace that refuses the chat sends the pick to /bots; on /bots it follows ?agent=', (t) => {
  const w = fakeWorkspace(t, { refuse: true });
  assert.equal(w.pick('ada'), '/bots?agent=ada');
  assert.equal(pickBot({ agent: 'ada', pathname: '/bots', bus: { present: true, tabs: [] }, inIsland: true }), '/bots?agent=ada');
});
