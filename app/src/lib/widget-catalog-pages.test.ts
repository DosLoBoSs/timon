import assert from 'node:assert/strict';
import test from 'node:test';

import { buildWidgetCatalog, widgetPage, type WidgetSlotEntry } from '../components/widget-host/widget-catalog';

const entry = (key: string, slot: string, options: WidgetSlotEntry['options'] = {}): WidgetSlotEntry =>
  ({ registrationId: `p:${key}`, pluginId: '@timon/x', key, slot, options });

test('a widget is filed under the page it is at home on', () => {
  const catalog = buildWidgetCatalog([], [
    entry('clock', 'cockpit.widget', { zone: 'gauche' }),
    entry('git', 'chat.right.widget'),
    entry('tasks', 'cockpit.widget', { zone: 'agents.right.widget' }),
    entry('bell', 'topbar.widget'),
    entry('nav', 'sidebar.left.widget'),
  ]);
  assert.deepEqual(catalog.map(widgetPage), ['cockpit', 'chat', 'agents', 'topbar', 'sidebars']);
});

test('the sentence and the catalogue name reach the catalogue entry', () => {
  const [card, bare] = buildWidgetCatalog([], [
    entry('chat', 'cockpit.widget', { title: 'Alice', catalogTitle: 'Agent chat', description: 'Chat with Alice.' }),
    entry('bare', 'cockpit.widget', { title: 'Bare' }),
  ]);
  assert.equal(card!.title, 'Alice', 'the card keeps the title the user gave it');
  assert.equal(card!.catalogTitle, 'Agent chat');
  assert.equal(card!.description, 'Chat with Alice.');
  assert.equal(bare!.catalogTitle, undefined);
  assert.equal(bare!.description, undefined);
});
