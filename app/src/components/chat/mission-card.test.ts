/**
 * The mission sheet shows the provider and model of the next turn, the pair
 * the composer shows, not the agent's configured default: a mission switched
 * to another provider read the agent's Opus on the card.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { MissionSummary } from './chat-types';

// The test runner compiles JSX in the classic runtime.
Object.assign(globalThis, { React });

async function render(backend: string, model: string): Promise<string> {
  const { MissionCard } = await import('./mission-card');
  const mission = {
    id: 'm1234567-aaaa',
    status: 'done',
    running: false,
    started_at: Date.now(),
  } as unknown as MissionSummary;
  return renderToStaticMarkup(React.createElement(MissionCard, {
    agent: { name: 'demo.main', backend: 'claude', model: 'claude-opus-5-5' },
    agentId: 'demo.main',
    missions: [mission],
    currentMissionId: mission.id,
    currentSessionId: null,
    stats: { tok: 0, cost: 0 },
    backend,
    model,
    onNew: () => {},
  }));
}

test('the card shows the effective model and provider, not the agent default', async () => {
  const html = await render('codex', 'gpt-6.1-sol');
  assert.match(html, />gpt-6\.1-sol</);
  assert.match(html, />codex</);
  assert.doesNotMatch(html, /opus-5-5/);
});

test('a Claude model reads without its vendor prefix nor date suffix', async () => {
  const html = await render('claude', 'claude-sonnet-5-5-20261001');
  assert.match(html, />sonnet-5-5</);
  assert.match(html, /title="claude-sonnet-5-5-20261001"/);
});
