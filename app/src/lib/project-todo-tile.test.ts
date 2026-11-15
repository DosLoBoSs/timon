import assert from 'node:assert/strict';
import test from 'node:test';
import type { ClientRealtime } from './plugin-host/realtime';

type Idee = { id: number; status: string; urgency: string | null; project?: string | null };

/**
 * The daemon's answer, as `GET /api/project-todo` writes it: rows of the
 * requested status and types, capped at `limit` (200 by default), with counts
 * that are not. A fake that sent every row would hide the very bug of a tile
 * counting what it received.
 */
function daemon(url: string, items: readonly Idee[]): Response {
  const q = new URL(url, 'http://localhost').searchParams;
  const status = q.get('status');
  const types = q.get('urgency')?.split(',') ?? null;
  const limit = Number(q.get('limit') ?? 200);
  const key = (i: Idee) => i.urgency ?? 'none';
  const keys = ['critical', 'bug', 'minor', 'idea', 'none'];
  const zero = () => Object.fromEntries(keys.map((k) => [k, 0])) as Record<string, number>;
  const counts = {
    byStatus: { open: 0, done: 0, promoted: 0 } as Record<string, number>,
    byUrgency: { open: zero(), done: zero(), promoted: zero() } as Record<string, Record<string, number>>,
  };
  for (const i of items) {
    counts.byUrgency[i.status]![key(i)]! += 1;
    if (!types || types.includes(key(i))) counts.byStatus[i.status]! += 1;
  }
  const matching = items.filter((i) => (!status || status === 'all' || i.status === status) && (!types || types.includes(key(i))));
  return Response.json({ items: matching.slice(0, limit), counts, truncated: matching.length > limit });
}

/**
 * La règle dure de « Project TO DO » : sans projet résolu, il ne liste RIEN.
 *
 * C'est le seul invariant de comportement du volet 4/4, et il tient à un
 * booléen. Une tuile qui retomberait sur le carnet entier montrerait les idées
 * de tous les AUTRES projets sous un en-tête qui en promet un — rien au build
 * ne le dirait, d'où ce test.
 */
async function monterTuile(scope: unknown, appels: string[], realtime: ClientRealtime = {
  subscribe: () => () => {},
}, items: Idee[] = [], opts: { layout?: unknown; editing?: boolean } = {}) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('self', dom.window);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  install('fetch', async (input: string) => {
    // The display options live in a layout scope, not in the notebook.
    if (String(input).startsWith('/api/ui/layout')) return Response.json({ layout: opts.layout ?? null });
    appels.push(String(input));
    return daemon(String(input), items);
  });
  const { ProjectTodoTile } = await import('../plugins-client/kanban/project-todo-tile');
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => {
    root.render(React.createElement(ProjectTodoTile, {
      scope, titre: 'Project TO DO', poignee: null, realtime, editing: opts.editing ?? false,
    } as never));
  });
  return { React, root, dom };
}

test('sans projet résolu, « Project TO DO » n\'appelle rien et le dit', async () => {
  const appels: string[] = [];
  const { React, root } = await monterTuile({ kind: 'project', slug: null }, appels);
  assert.deepEqual(appels, [], 'aucun appel : pas même le carnet entier');
  assert.match(document.body.textContent!, /Choose a project/);
  // Le geste de saisie attend le projet : une idée créée là serait sans projet,
  // donc invisible de la tuile qui l'a créée.
  const ajout = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Add');
  assert.equal(ajout?.disabled, true, 'le bouton de la popup attend le projet');
  assert.ok(!document.querySelector('input'), 'plus de saisie en ligne : tout passe par la popup');
  await React.act(async () => { root.unmount(); });
});

test('avec un projet, la liste est filtrée sur lui', async () => {
  const appels: string[] = [];
  const { React, root } = await monterTuile({ kind: 'project', slug: 'timon' }, appels);
  assert.deepEqual(appels, ['/api/ui/project-todo?status=open&project=timon&limit=500']);
  const ajout = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Add');
  assert.equal(ajout?.disabled, false);
  await React.act(async () => { root.unmount(); });
});

test('la tuile générale liste tout le carnet', async () => {
  const appels: string[] = [];
  const { React, root } = await monterTuile({ kind: 'all' }, appels);
  assert.deepEqual(appels, ['/api/ui/project-todo?status=open&limit=500']);
  await React.act(async () => { root.unmount(); });
});


test('realtime reloads the scoped tile and unsubscribes on unmount', async (t) => {
  let handler: ((payload: unknown) => void) | undefined;
  let unsubscribed = false;
  const appels: string[] = [];
  const { React, root } = await monterTuile({ kind: 'project', slug: 'timon' }, appels, {
    subscribe(topic, listener) {
      assert.equal(topic, 'project-todo.changed');
      handler = listener;
      return () => { unsubscribed = true; };
    },
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await React.act(async () => {
    handler?.({ id: 1 });
    handler?.({ id: 2 });
    t.mock.timers.tick(150);
  });
  assert.deepEqual(appels, Array(2).fill('/api/ui/project-todo?status=open&project=timon&limit=500'));
  handler?.({ id: 3 });
  await React.act(async () => { root.unmount(); });
  assert.equal(unsubscribed, true);
  t.mock.timers.tick(150);
  assert.equal(appels.length, 2);
});

test('type chips narrow the list, Open/Done count the selected types', async () => {
  const idee = (id: number, text: string, urgency: string | null, status = 'open') => ({
    id, text, urgency, status, project: 'timon', author: null, notes: null, progress: null,
  });
  const { React, root } = await monterTuile({ kind: 'project', slug: 'timon' }, [], undefined, [
    idee(1, 'crash au démarrage', 'bug'),
    idee(2, 'mode sombre', 'idea'),
    idee(3, 'sans étiquette', null),
    idee(4, 'vieux bug', 'bug', 'done'),
  ]);
  const lignes = () => Array.from(document.querySelectorAll('li')).map((li) => li.textContent);
  // A type chip shows icon + count: its label lives in `aria-label` / `title`.
  const puce = (label: string) => Array.from(document.querySelectorAll('[role=group] button'))
    .find((b) => (b.getAttribute('aria-label') ?? b.textContent)?.startsWith(label)) as HTMLButtonElement;
  assert.equal(lignes().length, 3, 'no chip pressed: every open idea');
  // The id is how agents name an idea in their reports (« #209 »): each line shows it.
  assert.deepEqual(lignes().map((l) => l!.match(/#\d+/)?.[0]), ['#1', '#2', '#3']);
  assert.ok(!puce('Critical'), 'a type absent from the view gets no chip');
  assert.equal(puce('Bug').getAttribute('aria-label'), 'Bug — 1');
  assert.equal(puce('Bug').title, 'Bug');
  assert.equal(puce('No type').getAttribute('aria-label'), 'No type — 1');
  const barreTypes = document.querySelector('[role=group][aria-label="Filter by type"]')!;
  assert.doesNotMatch(barreTypes.textContent!, /Bug|Idea|No type/, 'no label text in the type row');

  await React.act(async () => { puce('Bug').click(); });
  assert.equal(puce('Bug').getAttribute('aria-pressed'), 'true');
  assert.equal(lignes().length, 1);
  assert.match(lignes()[0]!, /crash au démarrage/);
  assert.match(puce('Open').textContent!, /1$/);
  assert.match(puce('Done').textContent!, /1$/);

  await React.act(async () => { puce('No type').click(); });
  assert.equal(lignes().length, 2, 'chips add up');

  await React.act(async () => { puce('Bug').click(); puce('No type').click(); puce('Idea').click(); });
  await React.act(async () => { puce('Done').click(); });
  assert.match(document.body.textContent!, /No idea of this type/);
  const tout = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Show all types')!;
  await React.act(async () => { tout.click(); });
  assert.equal(lignes().length, 1);
  assert.match(lignes()[0]!, /vieux bug/);
  await React.act(async () => { root.unmount(); });
});

test('number and author are grey badges, each one can be hidden per widget', async () => {
  const idee = { id: 203, text: 'skill plugin', urgency: 'idea', status: 'open', project: 'timon', author: 'user', notes: null, progress: null };
  const ligne = () => document.querySelector('li')!.textContent!;
  const options = () => document.querySelector('button[aria-label="Display options"]');

  let tuile = await monterTuile({ kind: 'project', slug: 'timon' }, [], undefined, [idee]);
  await tuile.React.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  assert.match(ligne(), /#203/);
  // The cockpit signs an idea `user`, shown as « You » (todoAuthorLabel).
  assert.match(ligne(), /You/);
  assert.equal(options(), null, 'the options only show while the layout is edited');
  await tuile.React.act(async () => { tuile.root.unmount(); });

  tuile = await monterTuile({ kind: 'project', slug: 'timon' }, [], undefined, [idee], {
    editing: true,
    // Hidden for « Project TO DO » only: the other widget's setting does not apply here.
    layout: { v: 1, project: { showId: false, showAuthor: false }, all: { showId: true, showAuthor: true } },
  });
  await tuile.React.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  assert.doesNotMatch(ligne(), /#203/);
  assert.doesNotMatch(ligne(), /You/);
  assert.ok(options(), 'edit mode offers the display options');
  await tuile.React.act(async () => { tuile.root.unmount(); });
});

test('past one page of open ideas, Done still counts and opens the done ones', async () => {
  // The bug seen on a real notebook: 221 open ideas and 737 done showed
  // « Open 200 · Done 0 », the button greyed out.
  const idees: Idee[] = [
    ...Array.from({ length: 221 }, (_, n) => ({ id: n + 1, status: 'open', urgency: n < 21 ? 'bug' : null, project: 'timon' })),
    ...Array.from({ length: 737 }, (_, n) => ({ id: 1000 + n, status: 'done', urgency: null, project: 'timon' })),
  ].map((i) => ({ ...i, text: `idée ${i.id}`, author: null, notes: null, progress: null }));
  const appels: string[] = [];
  const { React, root } = await monterTuile({ kind: 'project', slug: 'timon' }, appels, undefined, idees);
  const bouton = (label: string) => Array.from(document.querySelectorAll('[role=group] button'))
    .find((b) => (b.getAttribute('aria-label') ?? b.textContent)?.startsWith(label)) as HTMLButtonElement;
  assert.match(bouton('Open').textContent!, /221$/);
  assert.match(bouton('Done').textContent!, /737$/);
  assert.equal(bouton('Done').disabled, false);
  assert.equal(document.querySelectorAll('li').length, 221);

  await React.act(async () => { bouton('Done').click(); });
  assert.equal(appels.at(-1), '/api/ui/project-todo?status=done&project=timon&limit=500');
  assert.equal(document.querySelectorAll('li').length, 500);
  assert.match(document.body.textContent!, /Showing the latest 500 of 737/);

  // A chip narrows on the daemon's side, and the segments follow it.
  await React.act(async () => { bouton('Open').click(); });
  await React.act(async () => { bouton('Bug').click(); });
  assert.equal(appels.at(-1), '/api/ui/project-todo?status=open&project=timon&urgency=bug&limit=500');
  assert.equal(document.querySelectorAll('li').length, 21);
  assert.match(bouton('Open').textContent!, /21$/);
  assert.match(bouton('Done').textContent!, /0$/);
  await React.act(async () => { root.unmount(); });
});
