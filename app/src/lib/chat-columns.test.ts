import assert from 'node:assert/strict';
import test from 'node:test';

import { LEGACY_LAYOUT_KEY, loadLayout, saveLayout } from './ui-layout-store';
import {
  addTab,
  toggleCollapsed,
  setCollapsed,
  selectTab,
  activeTab,
  tabsOf,
  removeTab,
  columnZoneOf,
  defaultColumns,
  sideOf,
  isCollapsed,
  swapColumns,
  columnsIo,
  readColumns,
  zoneOfSide,
  CHAT_COLUMNS_SCOPE,
  addSecond,
  detachSecond,
  widthOf,
  planRails,
  setWidth,
  secondOf,
  THREAD_MIN,
  WIDTH_MAX,
  WIDTH_MIN,
  type ChatColumns,
} from '../components/chat/chat-columns';

const LEFT = 'chat.left.widget';
const RIGHT = 'chat.right.widget';
const KNOWN = [LEFT, RIGHT] as const;

test('rien de stocké : les colonnes sont dans leur ordre déclaré', () => {
  const c = readColumns(null, KNOWN);
  assert.deepEqual(c, { ordre: [LEFT, RIGHT], masquees: [] });
  assert.deepEqual(c, defaultColumns(KNOWN));
});

test('inverser change le côté des deux colonnes', () => {
  const c = swapColumns(defaultColumns(KNOWN));
  assert.equal(sideOf(c, LEFT), 'right');
  assert.equal(sideOf(c, RIGHT), 'left');
  assert.equal(zoneOfSide(c, 'left'), RIGHT);
  assert.equal(zoneOfSide(c, 'right'), LEFT);
});

test('inverser deux fois revient à l’ordre d’origine', () => {
  const c = defaultColumns(KNOWN);
  assert.deepEqual(swapColumns(swapColumns(c)), c);
});

test('le repli suit la zone, pas le côté : inverser ne déplie rien', () => {
  const folded = toggleCollapsed(defaultColumns(KNOWN), LEFT);
  const inverse = swapColumns(folded);
  assert.equal(isCollapsed(inverse, LEFT), true);
  assert.equal(isCollapsed(inverse, RIGHT), false);
  // La colonne repliée est maintenant celle de droite.
  assert.equal(sideOf(inverse, LEFT), 'right');
});

test('masquer puis démasquer rend l’état d’origine', () => {
  const c = defaultColumns(KNOWN);
  assert.deepEqual(toggleCollapsed(toggleCollapsed(c, RIGHT), RIGHT), c);
});

test('une colonne repliée garde sa place dans l’ordre', () => {
  const c = toggleCollapsed(defaultColumns(KNOWN), LEFT);
  assert.deepEqual(c.ordre, [LEFT, RIGHT]);
});

test('un ordre inversé se relit tel quel', () => {
  const stored = swapColumns(toggleCollapsed(defaultColumns(KNOWN), RIGHT));
  const reread = readColumns(JSON.parse(JSON.stringify(stored)), KNOWN);
  assert.deepEqual(reread, stored);
});

test('une zone inconnue du stockage est ignorée', () => {
  const c = readColumns({ ordre: ['chat.disparue', RIGHT], masquees: ['chat.disparue'] }, KNOWN);
  assert.deepEqual(c.ordre, [RIGHT, LEFT]);
  assert.deepEqual(c.masquees, []);
});

test('une zone connue absente du stockage revient à sa place déclarée', () => {
  const c = readColumns({ ordre: [RIGHT] }, KNOWN);
  assert.deepEqual(c.ordre, [RIGHT, LEFT]);
});

test('un doublon de stockage ne compte qu’une fois', () => {
  const c = readColumns({ ordre: [RIGHT, RIGHT, LEFT], masquees: [LEFT, LEFT] }, KNOWN);
  assert.deepEqual(c.ordre, [RIGHT, LEFT]);
  assert.deepEqual(c.masquees, [LEFT]);
});

test('une valeur illisible retombe sur les défauts au lieu de casser', () => {
  for (const raw of [undefined, 42, 'nope', [], { ordre: 'gauche', masquees: 7 }]) {
    assert.deepEqual(readColumns(raw, KNOWN), defaultColumns(KNOWN));
  }
});

test('une zone hors colonnes n’a pas de côté : le chrome ne réserve rien', () => {
  assert.equal(sideOf(defaultColumns(KNOWN), 'cockpit.widget'), null);
});

test('les mutations ne modifient pas la valeur reçue', () => {
  const c: ChatColumns = defaultColumns(KNOWN);
  const copy = JSON.parse(JSON.stringify(c)) as ChatColumns;
  swapColumns(c);
  toggleCollapsed(c, LEFT);
  assert.deepEqual(c, copy);
});

test('une seule colonne déclarée : elle est à gauche, rien à droite', () => {
  const c = defaultColumns([LEFT]);
  assert.equal(sideOf(c, LEFT), 'left');
  assert.equal(zoneOfSide(c, 'right'), null);
});

// ── Onglets : une colonne alterne entre plusieurs zones de widgets.

test('sans onglet, une colonne affiche sa propre zone', () => {
  const c = defaultColumns(KNOWN);
  assert.deepEqual(tabsOf(c, RIGHT), [RIGHT]);
  assert.equal(activeTab(c, RIGHT), RIGHT);
});

test('ouvrir un onglet l’affiche, sous la colonne qui l’a ouvert', () => {
  const c = addTab(defaultColumns(KNOWN), RIGHT, 'a');
  assert.deepEqual(tabsOf(c, RIGHT), [RIGHT, `${RIGHT}#a`]);
  assert.equal(activeTab(c, RIGHT), `${RIGHT}#a`);
  assert.deepEqual(tabsOf(c, LEFT), [LEFT]);
  assert.equal(columnZoneOf(`${RIGHT}#a`), RIGHT);
  assert.equal(columnZoneOf(RIGHT), RIGHT);
});

test('un suffixe déjà pris, vide ou une colonne inconnue ne créent rien', () => {
  const c = addTab(defaultColumns(KNOWN), RIGHT, 'a');
  assert.deepEqual(addTab(c, RIGHT, 'a'), c);
  assert.deepEqual(addTab(c, RIGHT, ''), c);
  assert.deepEqual(addTab(c, 'chat.ailleurs', 'b'), c);
});

test('choisir un onglet le montre, revenir au premier efface le choix', () => {
  const opened = addTab(defaultColumns(KNOWN), RIGHT, 'a');
  const first = selectTab(opened, RIGHT, RIGHT);
  assert.equal(activeTab(first, RIGHT), RIGHT);
  assert.equal(first.actifs, undefined);
  assert.equal(activeTab(selectTab(first, RIGHT, `${RIGHT}#a`), RIGHT), `${RIGHT}#a`);
  // L'onglet d'une autre colonne n'est pas un choix possible ici.
  assert.equal(activeTab(selectTab(first, RIGHT, `${LEFT}#a`), RIGHT), RIGHT);
});

test('fermer l’onglet affiché montre celui qui le précédait', () => {
  let c = addTab(defaultColumns(KNOWN), RIGHT, 'a');
  c = addTab(c, RIGHT, 'b');
  c = removeTab(c, RIGHT, `${RIGHT}#b`);
  assert.equal(activeTab(c, RIGHT), `${RIGHT}#a`);
  c = removeTab(c, RIGHT, `${RIGHT}#a`);
  assert.equal(activeTab(c, RIGHT), RIGHT);
  // Revenue à un seul onglet, la colonne retrouve sa forme d'avant les onglets.
  assert.deepEqual(c, defaultColumns(KNOWN));
});

test('le premier onglet ne se ferme pas : il est la colonne', () => {
  const c = addTab(defaultColumns(KNOWN), RIGHT, 'a');
  assert.deepEqual(removeTab(c, RIGHT, RIGHT), c);
});

test('inverser et replier gardent les onglets de chaque colonne', () => {
  let c = addTab(defaultColumns(KNOWN), RIGHT, 'a');
  c = addTab(c, LEFT, 'b');
  c = selectTab(c, LEFT, LEFT);
  const after = toggleCollapsed(swapColumns(c), RIGHT);
  assert.deepEqual(after.onglets, c.onglets);
  assert.deepEqual(after.actifs, c.actifs);
  assert.equal(activeTab(after, RIGHT), `${RIGHT}#a`);
});

test('des onglets se relisent tels quels', () => {
  let c = addTab(defaultColumns(KNOWN), RIGHT, 'a');
  c = addTab(c, RIGHT, 'b');
  c = selectTab(c, RIGHT, `${RIGHT}#a`);
  assert.deepEqual(readColumns(JSON.parse(JSON.stringify(c)), KNOWN), c);
});

test('un onglet stocké sous la mauvaise colonne ou illisible est ignoré', () => {
  const c = readColumns({
    ordre: [LEFT, RIGHT],
    onglets: { [RIGHT]: [`${LEFT}#x`, `${RIGHT}#`, 7, `${RIGHT}#ok`, `${RIGHT}#ok`], 'chat.disparue': ['chat.disparue#a'] },
    actifs: { [RIGHT]: `${RIGHT}#inconnu`, [LEFT]: 3 },
  }, KNOWN);
  assert.deepEqual(tabsOf(c, RIGHT), [RIGHT, `${RIGHT}#ok`]);
  assert.equal(activeTab(c, RIGHT), RIGHT);
  assert.equal(c.actifs, undefined);
  assert.deepEqual(Object.keys(c.onglets ?? {}), [RIGHT]);
});

// ── Persistance : les colonnes voyagent par `ui_layout`, sur leur propre scope.

/** Un daemon en mémoire, une valeur par scope. */
function fakeDaemon() {
  const store = new Map<string, unknown>();
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const scope = new URL(url, 'http://x').searchParams.get('scope') ?? 'cockpit';
    if ((init?.method ?? 'GET') === 'GET') {
      return new Response(JSON.stringify({ scope, layout: store.get(scope) ?? null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    store.set(scope, JSON.parse(String(init?.body)).layout);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  return { fetchImpl, store };
}

test('un ordre inversé survit à l’aller-retour par le daemon', async () => {
  const daemon = fakeDaemon();
  const inverse = swapColumns(defaultColumns(KNOWN));

  assert.equal(await saveLayout(inverse, columnsIo({ fetchImpl: daemon.fetchImpl })), true);
  const out = await loadLayout(columnsIo({ fetchImpl: daemon.fetchImpl }));

  assert.equal(out.ok, true);
  assert.deepEqual(readColumns(out.raw, KNOWN), inverse);
  assert.deepEqual([...daemon.store.keys()], [CHAT_COLUMNS_SCOPE], 'le cockpit n’est pas touché');
});

test('le layout laissé au navigateur n’est jamais repris comme ordre de colonnes', async () => {
  const daemon = fakeDaemon();
  const cockpit = [{ id: 'agenda', rail: 'gauche', rang: 0, hauteur: 200 }];
  const storage = {
    getItem: (k: string) => (k === LEGACY_LAYOUT_KEY ? JSON.stringify(cockpit) : null),
    removeItem: () => { throw new Error('la migration du cockpit ne doit pas courir ici'); },
  };

  const out = await loadLayout(columnsIo({ fetchImpl: daemon.fetchImpl, storage }));

  assert.deepEqual(out, { raw: null, ok: true, migrated: false });
  assert.equal(daemon.store.size, 0, 'rien n’a été écrit sur le scope des colonnes');
});

test('daemon injoignable : la lecture le dit, et rien n’est écrit', async () => {
  const fetchImpl = async () => { throw new Error('réseau coupé'); };
  const out = await loadLayout(columnsIo({ fetchImpl }));
  assert.deepEqual(out, { raw: null, ok: false, migrated: false });
  // C’est ce `ok: false` que le hook garde : sans lui, les défauts seraient
  // sauvés par-dessus un ordre qu’on a seulement échoué à lire.
  assert.deepEqual(readColumns(out.raw, KNOWN), defaultColumns(KNOWN));
});

test('largeur : absente = défaut, posée = bornée, null = retour au défaut', () => {
  const c = readColumns(null, KNOWN);
  assert.equal(widthOf(c, RIGHT, 300), 300);
  const large = setWidth(c, RIGHT, 455.4);
  assert.equal(widthOf(large, RIGHT, 300), 455);
  assert.equal(widthOf(setWidth(c, RIGHT, 10), RIGHT, 300), WIDTH_MIN);
  assert.equal(widthOf(setWidth(c, RIGHT, 99999), RIGHT, 300), WIDTH_MAX);
  const reset = setWidth(large, RIGHT, null);
  assert.equal(reset.largeurs, undefined, 'back to the default, the stored value regains its old shape');
});

test('largeur : une valeur stockée illisible ou hors colonnes est ignorée', () => {
  const c = readColumns({ largeurs: { [RIGHT]: 'large', [LEFT]: 5000, 'chat.disparue': 400 } }, KNOWN);
  assert.deepEqual(c.largeurs, { [LEFT]: WIDTH_MAX });
});

test('deuxième colonne : un onglet montré à côté, sans changer l’onglet affiché', () => {
  const c = selectTab(addTab(readColumns(null, KNOWN), RIGHT, 'a'), RIGHT, RIGHT);
  const s = addSecond(c, RIGHT, 'b');
  assert.equal(secondOf(s, RIGHT), `${RIGHT}#b`);
  assert.deepEqual(tabsOf(s, RIGHT), [RIGHT, `${RIGHT}#a`, `${RIGHT}#b`], 'une entrée d’onglet par colonne');
  assert.equal(activeTab(s, RIGHT), RIGHT);
  assert.equal(secondOf(s, LEFT), null);
  assert.deepEqual(addSecond(s, RIGHT, 'c'), s, 'une seule deuxième colonne par côté');
});

test('deuxième colonne : la détacher la laisse en onglet, la fermer l’oublie avec sa largeur', () => {
  const s = setWidth(addSecond(readColumns(null, KNOWN), LEFT, 'b'), `${LEFT}#b`, 400);
  const detached = detachSecond(s, LEFT);
  assert.equal(secondOf(detached, LEFT), null);
  assert.deepEqual(tabsOf(detached, LEFT), [LEFT, `${LEFT}#b`]);
  const closed = removeTab(s, LEFT, `${LEFT}#b`);
  assert.equal(closed.secondes, undefined);
  assert.equal(closed.largeurs, undefined);
});

test('deuxième colonne : relue telle quelle, ignorée si elle ne nomme pas un onglet', () => {
  const s = addSecond(readColumns(null, KNOWN), RIGHT, 'b');
  assert.deepEqual(readColumns(JSON.parse(JSON.stringify(s)), KNOWN), s);
  const forged = readColumns({ ...s, secondes: { [RIGHT]: `${LEFT}#b`, [LEFT]: 4 } }, KNOWN);
  assert.equal(forged.secondes, undefined);
});

test('inverser garde la deuxième colonne et les largeurs de chaque zone', () => {
  const s = setWidth(addSecond(readColumns(null, KNOWN), RIGHT, 'b'), RIGHT, 500);
  const inv = swapColumns(s);
  assert.deepEqual(inv.secondes, s.secondes);
  assert.deepEqual(inv.largeurs, s.largeurs);
});

test('plan : gouttière d’origine à gauche, poignée dégagée à droite, aux largeurs par défaut', () => {
  const plan = planRails(1400, { width: 280, first: true, second: null }, { width: 300, first: true, second: null });
  assert.equal(plan.left?.gutter, 312);
  assert.equal(plan.right?.gutter, 328, 'clears the handle past the column edge');
  assert.equal(plan.slack, 1400 - THREAD_MIN - 640);
});

test('plan : assez de place, les deux colonnes de chaque côté sont posées', () => {
  const plan = planRails(3000, { width: 300, first: true, second: 300 }, { width: 300, first: true, second: 400 });
  assert.equal(plan.right?.second, 400);
  assert.equal(plan.right?.secondOffset, 312);
  assert.equal(plan.right?.gutter, 16 + 300 + 12 + 400 + 12);
  assert.equal(plan.left?.secondFolded, false);
});

test('plan : trop étroit, la deuxième colonne du côté le plus large se replie d’abord', () => {
  const g = { width: 300, first: true, second: 300 };
  const d = { width: 300, first: true, second: 400 };
  // Room for one second column, not two.
  const plan = planRails(THREAD_MIN + 644 + 328, g, d);
  assert.equal(plan.right?.second, null);
  assert.equal(plan.right?.secondFolded, true);
  assert.equal(plan.left?.second, 300);
});

test('plan : une deuxième colonne seule (la colonne vide) prend le bord, et se replie dans la colonne', () => {
  const alone = planRails(3000, null, { width: 300, first: false, second: 350 });
  assert.equal(alone.right?.first, null);
  assert.equal(alone.right?.secondOffset, 0);
  assert.equal(alone.right?.gutter, 378);
  const foldedBack = planRails(THREAD_MIN + 330, null, { width: 300, first: false, second: 350 });
  assert.equal(foldedBack.right?.first, 300, 'its tab folds back into the column, which shows again');
  assert.equal(foldedBack.right?.second, null);
});

test('plan : plus étroit encore, les largeurs rétrécissent sans passer sous le minimum', () => {
  const plan = planRails(THREAD_MIN + 700, { width: 500, first: true, second: null }, { width: 500, first: true, second: null });
  assert.ok((plan.left?.first ?? 0) < 500);
  assert.ok((plan.left?.first ?? 0) >= WIDTH_MIN);
  assert.ok((plan.left?.gutter ?? 0) + (plan.right?.gutter ?? 0) <= 700);
  const minuscule = planRails(THREAD_MIN + 100, { width: 500, first: true, second: null }, null);
  assert.equal(minuscule.left?.first, WIDTH_MIN);
  assert.equal(minuscule.slack, 0);
});

test('plan : largeur pas encore mesurée, tout est posé tel que demandé', () => {
  const plan = planRails(0, { width: 300, first: true, second: 300 }, null);
  assert.equal(plan.left?.second, 300);
  assert.equal(plan.slack, Number.POSITIVE_INFINITY);
});

test('a tab name survives every mutation, leaves with its tab, and is bounded', async () => {
  const { addTab, readColumns, nameTab, removeTab, swapColumns, TAB_NAME_MAX } = await import('../components/chat/chat-columns');
  const zones = ['chat.left.widget', 'chat.right.widget'];
  let c = addTab(readColumns(null, zones), 'chat.right.widget', 'k1');
  c = nameTab(c, 'chat.right.widget#k1', '  Ops\n  board ');
  assert.equal(c.noms?.['chat.right.widget#k1'], 'Ops board');
  c = swapColumns(c);
  assert.equal(c.noms?.['chat.right.widget#k1'], 'Ops board', 'another mutation keeps the name');
  assert.deepEqual(readColumns(JSON.parse(JSON.stringify(c)), zones).noms, { 'chat.right.widget#k1': 'Ops board' });
  assert.equal(nameTab(c, 'chat.left.widget', 'x'.repeat(60)).noms?.['chat.left.widget']?.length, TAB_NAME_MAX);
  assert.equal(nameTab(c, 'chat.right.widget#k1', null).noms, undefined, 'an unnamed column writes no field');
  assert.equal(removeTab(c, 'chat.right.widget', 'chat.right.widget#k1').noms, undefined, 'a closed tab takes its name along');
  assert.equal(readColumns({ noms: { 'chat.left.widget#ghost': 'x' } }, zones).noms, undefined);
});

// TODO #647 : un clic rejoué sur l’écriture d’une autre fenêtre garde son sens.
test('replier une colonne déjà repliée ailleurs la laisse repliée', () => {
  const c = defaultColumns(KNOWN);
  const folded = setCollapsed(c, LEFT, true);
  assert.equal(isCollapsed(folded, LEFT), true);
  assert.equal(setCollapsed(folded, LEFT, true), folded);
  assert.deepEqual(setCollapsed(folded, LEFT, false), c);
});

test('a column resized with its mirror: both move by the same amount, held by the first bound', async () => {
  const { pairedWidths, WIDTH_MIN } = await import('../components/chat/chat-columns');
  // Room for 200px more in all: two columns growing at once share it.
  assert.deepEqual(pairedWidths(300, 500, 500, { width: 300, max: 500 }), { width: 400, twin: 400 });
  assert.deepEqual(pairedWidths(300, 340, 500, { width: 280, max: 480 }), { width: 340, twin: 320 }, 'an asymmetry is kept, not erased');
  // Shrinking stops at the floor of whichever reaches it first.
  assert.deepEqual(pairedWidths(300, 100, 500, { width: WIDTH_MIN + 20, max: 500 }), { width: 280, twin: WIDTH_MIN });
});

test('the reading column width is stored clamped, and null gives it back to the room', async () => {
  const { setThreadWidth, readColumns, THREAD_READING_MIN, THREAD_READING_MAX } = await import('../components/chat/chat-columns');
  const zones = ['chat.left.widget', 'chat.right.widget'];
  const base = readColumns({}, zones);
  assert.equal(base.fil, undefined);
  assert.equal(setThreadWidth(base, 900).fil, 900);
  assert.equal(setThreadWidth(base, 10).fil, THREAD_READING_MIN);
  assert.equal(setThreadWidth(base, 99999).fil, THREAD_READING_MAX);
  assert.equal(setThreadWidth(setThreadWidth(base, 900), null).fil, undefined);
  // Read back from storage, and dropped when unreadable.
  assert.equal(readColumns({ fil: 1000 }, zones).fil, 1000);
  assert.equal(readColumns({ fil: 'wide' }, zones).fil, undefined);
});
