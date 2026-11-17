import assert from 'node:assert/strict';
import test from 'node:test';

import { LEGACY_LAYOUT_KEY, loadLayout, saveLayout } from './ui-layout-store';
import {
  ajouterOnglet,
  basculerMasquee,
  poserMasquee,
  choisirOnglet,
  ongletActif,
  ongletsDe,
  retirerOnglet,
  zoneDeColonne,
  colonnesDefaut,
  coteDe,
  estMasquee,
  inverserColonnes,
  ioColonnes,
  lireColonnes,
  zoneDuCote,
  CHAT_COLUMNS_SCOPE,
  ajouterSeconde,
  detacherSeconde,
  largeurDe,
  planifierRails,
  poserLargeur,
  secondeDe,
  FIL_MIN,
  LARGEUR_MAX,
  LARGEUR_MIN,
  type ChatColumns,
} from '../components/chat/chat-columns';

const LEFT = 'chat.left.widget';
const RIGHT = 'chat.right.widget';
const KNOWN = [LEFT, RIGHT] as const;

test('rien de stocké : les colonnes sont dans leur ordre déclaré', () => {
  const c = lireColonnes(null, KNOWN);
  assert.deepEqual(c, { ordre: [LEFT, RIGHT], masquees: [] });
  assert.deepEqual(c, colonnesDefaut(KNOWN));
});

test('inverser change le côté des deux colonnes', () => {
  const c = inverserColonnes(colonnesDefaut(KNOWN));
  assert.equal(coteDe(c, LEFT), 'right');
  assert.equal(coteDe(c, RIGHT), 'left');
  assert.equal(zoneDuCote(c, 'left'), RIGHT);
  assert.equal(zoneDuCote(c, 'right'), LEFT);
});

test('inverser deux fois revient à l’ordre d’origine', () => {
  const c = colonnesDefaut(KNOWN);
  assert.deepEqual(inverserColonnes(inverserColonnes(c)), c);
});

test('le repli suit la zone, pas le côté : inverser ne déplie rien', () => {
  const folded = basculerMasquee(colonnesDefaut(KNOWN), LEFT);
  const inverse = inverserColonnes(folded);
  assert.equal(estMasquee(inverse, LEFT), true);
  assert.equal(estMasquee(inverse, RIGHT), false);
  // La colonne repliée est maintenant celle de droite.
  assert.equal(coteDe(inverse, LEFT), 'right');
});

test('masquer puis démasquer rend l’état d’origine', () => {
  const c = colonnesDefaut(KNOWN);
  assert.deepEqual(basculerMasquee(basculerMasquee(c, RIGHT), RIGHT), c);
});

test('une colonne repliée garde sa place dans l’ordre', () => {
  const c = basculerMasquee(colonnesDefaut(KNOWN), LEFT);
  assert.deepEqual(c.ordre, [LEFT, RIGHT]);
});

test('un ordre inversé se relit tel quel', () => {
  const stored = inverserColonnes(basculerMasquee(colonnesDefaut(KNOWN), RIGHT));
  const reread = lireColonnes(JSON.parse(JSON.stringify(stored)), KNOWN);
  assert.deepEqual(reread, stored);
});

test('une zone inconnue du stockage est ignorée', () => {
  const c = lireColonnes({ ordre: ['chat.disparue', RIGHT], masquees: ['chat.disparue'] }, KNOWN);
  assert.deepEqual(c.ordre, [RIGHT, LEFT]);
  assert.deepEqual(c.masquees, []);
});

test('une zone connue absente du stockage revient à sa place déclarée', () => {
  const c = lireColonnes({ ordre: [RIGHT] }, KNOWN);
  assert.deepEqual(c.ordre, [RIGHT, LEFT]);
});

test('un doublon de stockage ne compte qu’une fois', () => {
  const c = lireColonnes({ ordre: [RIGHT, RIGHT, LEFT], masquees: [LEFT, LEFT] }, KNOWN);
  assert.deepEqual(c.ordre, [RIGHT, LEFT]);
  assert.deepEqual(c.masquees, [LEFT]);
});

test('une valeur illisible retombe sur les défauts au lieu de casser', () => {
  for (const raw of [undefined, 42, 'nope', [], { ordre: 'gauche', masquees: 7 }]) {
    assert.deepEqual(lireColonnes(raw, KNOWN), colonnesDefaut(KNOWN));
  }
});

test('une zone hors colonnes n’a pas de côté : le chrome ne réserve rien', () => {
  assert.equal(coteDe(colonnesDefaut(KNOWN), 'cockpit.widget'), null);
});

test('les mutations ne modifient pas la valeur reçue', () => {
  const c: ChatColumns = colonnesDefaut(KNOWN);
  const copy = JSON.parse(JSON.stringify(c)) as ChatColumns;
  inverserColonnes(c);
  basculerMasquee(c, LEFT);
  assert.deepEqual(c, copy);
});

test('une seule colonne déclarée : elle est à gauche, rien à droite', () => {
  const c = colonnesDefaut([LEFT]);
  assert.equal(coteDe(c, LEFT), 'left');
  assert.equal(zoneDuCote(c, 'right'), null);
});

// ── Onglets : une colonne alterne entre plusieurs zones de widgets.

test('sans onglet, une colonne affiche sa propre zone', () => {
  const c = colonnesDefaut(KNOWN);
  assert.deepEqual(ongletsDe(c, RIGHT), [RIGHT]);
  assert.equal(ongletActif(c, RIGHT), RIGHT);
});

test('ouvrir un onglet l’affiche, sous la colonne qui l’a ouvert', () => {
  const c = ajouterOnglet(colonnesDefaut(KNOWN), RIGHT, 'a');
  assert.deepEqual(ongletsDe(c, RIGHT), [RIGHT, `${RIGHT}#a`]);
  assert.equal(ongletActif(c, RIGHT), `${RIGHT}#a`);
  assert.deepEqual(ongletsDe(c, LEFT), [LEFT]);
  assert.equal(zoneDeColonne(`${RIGHT}#a`), RIGHT);
  assert.equal(zoneDeColonne(RIGHT), RIGHT);
});

test('un suffixe déjà pris, vide ou une colonne inconnue ne créent rien', () => {
  const c = ajouterOnglet(colonnesDefaut(KNOWN), RIGHT, 'a');
  assert.deepEqual(ajouterOnglet(c, RIGHT, 'a'), c);
  assert.deepEqual(ajouterOnglet(c, RIGHT, ''), c);
  assert.deepEqual(ajouterOnglet(c, 'chat.ailleurs', 'b'), c);
});

test('choisir un onglet le montre, revenir au premier efface le choix', () => {
  const opened = ajouterOnglet(colonnesDefaut(KNOWN), RIGHT, 'a');
  const first = choisirOnglet(opened, RIGHT, RIGHT);
  assert.equal(ongletActif(first, RIGHT), RIGHT);
  assert.equal(first.actifs, undefined);
  assert.equal(ongletActif(choisirOnglet(first, RIGHT, `${RIGHT}#a`), RIGHT), `${RIGHT}#a`);
  // L'onglet d'une autre colonne n'est pas un choix possible ici.
  assert.equal(ongletActif(choisirOnglet(first, RIGHT, `${LEFT}#a`), RIGHT), RIGHT);
});

test('fermer l’onglet affiché montre celui qui le précédait', () => {
  let c = ajouterOnglet(colonnesDefaut(KNOWN), RIGHT, 'a');
  c = ajouterOnglet(c, RIGHT, 'b');
  c = retirerOnglet(c, RIGHT, `${RIGHT}#b`);
  assert.equal(ongletActif(c, RIGHT), `${RIGHT}#a`);
  c = retirerOnglet(c, RIGHT, `${RIGHT}#a`);
  assert.equal(ongletActif(c, RIGHT), RIGHT);
  // Revenue à un seul onglet, la colonne retrouve sa forme d'avant les onglets.
  assert.deepEqual(c, colonnesDefaut(KNOWN));
});

test('le premier onglet ne se ferme pas : il est la colonne', () => {
  const c = ajouterOnglet(colonnesDefaut(KNOWN), RIGHT, 'a');
  assert.deepEqual(retirerOnglet(c, RIGHT, RIGHT), c);
});

test('inverser et replier gardent les onglets de chaque colonne', () => {
  let c = ajouterOnglet(colonnesDefaut(KNOWN), RIGHT, 'a');
  c = ajouterOnglet(c, LEFT, 'b');
  c = choisirOnglet(c, LEFT, LEFT);
  const after = basculerMasquee(inverserColonnes(c), RIGHT);
  assert.deepEqual(after.onglets, c.onglets);
  assert.deepEqual(after.actifs, c.actifs);
  assert.equal(ongletActif(after, RIGHT), `${RIGHT}#a`);
});

test('des onglets se relisent tels quels', () => {
  let c = ajouterOnglet(colonnesDefaut(KNOWN), RIGHT, 'a');
  c = ajouterOnglet(c, RIGHT, 'b');
  c = choisirOnglet(c, RIGHT, `${RIGHT}#a`);
  assert.deepEqual(lireColonnes(JSON.parse(JSON.stringify(c)), KNOWN), c);
});

test('un onglet stocké sous la mauvaise colonne ou illisible est ignoré', () => {
  const c = lireColonnes({
    ordre: [LEFT, RIGHT],
    onglets: { [RIGHT]: [`${LEFT}#x`, `${RIGHT}#`, 7, `${RIGHT}#ok`, `${RIGHT}#ok`], 'chat.disparue': ['chat.disparue#a'] },
    actifs: { [RIGHT]: `${RIGHT}#inconnu`, [LEFT]: 3 },
  }, KNOWN);
  assert.deepEqual(ongletsDe(c, RIGHT), [RIGHT, `${RIGHT}#ok`]);
  assert.equal(ongletActif(c, RIGHT), RIGHT);
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
  const inverse = inverserColonnes(colonnesDefaut(KNOWN));

  assert.equal(await saveLayout(inverse, ioColonnes({ fetchImpl: daemon.fetchImpl })), true);
  const out = await loadLayout(ioColonnes({ fetchImpl: daemon.fetchImpl }));

  assert.equal(out.ok, true);
  assert.deepEqual(lireColonnes(out.raw, KNOWN), inverse);
  assert.deepEqual([...daemon.store.keys()], [CHAT_COLUMNS_SCOPE], 'le cockpit n’est pas touché');
});

test('le layout laissé au navigateur n’est jamais repris comme ordre de colonnes', async () => {
  const daemon = fakeDaemon();
  const cockpit = [{ id: 'agenda', rail: 'gauche', rang: 0, hauteur: 200 }];
  const storage = {
    getItem: (k: string) => (k === LEGACY_LAYOUT_KEY ? JSON.stringify(cockpit) : null),
    removeItem: () => { throw new Error('la migration du cockpit ne doit pas courir ici'); },
  };

  const out = await loadLayout(ioColonnes({ fetchImpl: daemon.fetchImpl, storage }));

  assert.deepEqual(out, { raw: null, ok: true, migrated: false });
  assert.equal(daemon.store.size, 0, 'rien n’a été écrit sur le scope des colonnes');
});

test('daemon injoignable : la lecture le dit, et rien n’est écrit', async () => {
  const fetchImpl = async () => { throw new Error('réseau coupé'); };
  const out = await loadLayout(ioColonnes({ fetchImpl }));
  assert.deepEqual(out, { raw: null, ok: false, migrated: false });
  // C’est ce `ok: false` que le hook garde : sans lui, les défauts seraient
  // sauvés par-dessus un ordre qu’on a seulement échoué à lire.
  assert.deepEqual(lireColonnes(out.raw, KNOWN), colonnesDefaut(KNOWN));
});

test('largeur : absente = défaut, posée = bornée, null = retour au défaut', () => {
  const c = lireColonnes(null, KNOWN);
  assert.equal(largeurDe(c, RIGHT, 300), 300);
  const large = poserLargeur(c, RIGHT, 455.4);
  assert.equal(largeurDe(large, RIGHT, 300), 455);
  assert.equal(largeurDe(poserLargeur(c, RIGHT, 10), RIGHT, 300), LARGEUR_MIN);
  assert.equal(largeurDe(poserLargeur(c, RIGHT, 99999), RIGHT, 300), LARGEUR_MAX);
  const reset = poserLargeur(large, RIGHT, null);
  assert.equal(reset.largeurs, undefined, 'back to the default, the stored value regains its old shape');
});

test('largeur : une valeur stockée illisible ou hors colonnes est ignorée', () => {
  const c = lireColonnes({ largeurs: { [RIGHT]: 'large', [LEFT]: 5000, 'chat.disparue': 400 } }, KNOWN);
  assert.deepEqual(c.largeurs, { [LEFT]: LARGEUR_MAX });
});

test('deuxième colonne : un onglet montré à côté, sans changer l’onglet affiché', () => {
  const c = choisirOnglet(ajouterOnglet(lireColonnes(null, KNOWN), RIGHT, 'a'), RIGHT, RIGHT);
  const s = ajouterSeconde(c, RIGHT, 'b');
  assert.equal(secondeDe(s, RIGHT), `${RIGHT}#b`);
  assert.deepEqual(ongletsDe(s, RIGHT), [RIGHT, `${RIGHT}#a`, `${RIGHT}#b`], 'une entrée d’onglet par colonne');
  assert.equal(ongletActif(s, RIGHT), RIGHT);
  assert.equal(secondeDe(s, LEFT), null);
  assert.deepEqual(ajouterSeconde(s, RIGHT, 'c'), s, 'une seule deuxième colonne par côté');
});

test('deuxième colonne : la détacher la laisse en onglet, la fermer l’oublie avec sa largeur', () => {
  const s = poserLargeur(ajouterSeconde(lireColonnes(null, KNOWN), LEFT, 'b'), `${LEFT}#b`, 400);
  const detached = detacherSeconde(s, LEFT);
  assert.equal(secondeDe(detached, LEFT), null);
  assert.deepEqual(ongletsDe(detached, LEFT), [LEFT, `${LEFT}#b`]);
  const closed = retirerOnglet(s, LEFT, `${LEFT}#b`);
  assert.equal(closed.secondes, undefined);
  assert.equal(closed.largeurs, undefined);
});

test('deuxième colonne : relue telle quelle, ignorée si elle ne nomme pas un onglet', () => {
  const s = ajouterSeconde(lireColonnes(null, KNOWN), RIGHT, 'b');
  assert.deepEqual(lireColonnes(JSON.parse(JSON.stringify(s)), KNOWN), s);
  const forged = lireColonnes({ ...s, secondes: { [RIGHT]: `${LEFT}#b`, [LEFT]: 4 } }, KNOWN);
  assert.equal(forged.secondes, undefined);
});

test('inverser garde la deuxième colonne et les largeurs de chaque zone', () => {
  const s = poserLargeur(ajouterSeconde(lireColonnes(null, KNOWN), RIGHT, 'b'), RIGHT, 500);
  const inv = inverserColonnes(s);
  assert.deepEqual(inv.secondes, s.secondes);
  assert.deepEqual(inv.largeurs, s.largeurs);
});

test('plan : gouttière d’origine à gauche, poignée dégagée à droite, aux largeurs par défaut', () => {
  const plan = planifierRails(1400, { largeur: 280, premiere: true, seconde: null }, { largeur: 300, premiere: true, seconde: null });
  assert.equal(plan.gauche?.gouttiere, 312);
  assert.equal(plan.droite?.gouttiere, 328, 'clears the handle past the column edge');
  assert.equal(plan.marge, 1400 - FIL_MIN - 640);
});

test('plan : assez de place, les deux colonnes de chaque côté sont posées', () => {
  const plan = planifierRails(3000, { largeur: 300, premiere: true, seconde: 300 }, { largeur: 300, premiere: true, seconde: 400 });
  assert.equal(plan.droite?.seconde, 400);
  assert.equal(plan.droite?.decalageSeconde, 312);
  assert.equal(plan.droite?.gouttiere, 16 + 300 + 12 + 400 + 12);
  assert.equal(plan.gauche?.secondeRepliee, false);
});

test('plan : trop étroit, la deuxième colonne du côté le plus large se replie d’abord', () => {
  const g = { largeur: 300, premiere: true, seconde: 300 };
  const d = { largeur: 300, premiere: true, seconde: 400 };
  // Room for one second column, not two.
  const plan = planifierRails(FIL_MIN + 644 + 328, g, d);
  assert.equal(plan.droite?.seconde, null);
  assert.equal(plan.droite?.secondeRepliee, true);
  assert.equal(plan.gauche?.seconde, 300);
});

test('plan : une deuxième colonne seule (la colonne vide) prend le bord, et se replie dans la colonne', () => {
  const alone = planifierRails(3000, null, { largeur: 300, premiere: false, seconde: 350 });
  assert.equal(alone.droite?.premiere, null);
  assert.equal(alone.droite?.decalageSeconde, 0);
  assert.equal(alone.droite?.gouttiere, 378);
  const foldedBack = planifierRails(FIL_MIN + 330, null, { largeur: 300, premiere: false, seconde: 350 });
  assert.equal(foldedBack.droite?.premiere, 300, 'its tab folds back into the column, which shows again');
  assert.equal(foldedBack.droite?.seconde, null);
});

test('plan : plus étroit encore, les largeurs rétrécissent sans passer sous le minimum', () => {
  const plan = planifierRails(FIL_MIN + 700, { largeur: 500, premiere: true, seconde: null }, { largeur: 500, premiere: true, seconde: null });
  assert.ok((plan.gauche?.premiere ?? 0) < 500);
  assert.ok((plan.gauche?.premiere ?? 0) >= LARGEUR_MIN);
  assert.ok((plan.gauche?.gouttiere ?? 0) + (plan.droite?.gouttiere ?? 0) <= 700);
  const minuscule = planifierRails(FIL_MIN + 100, { largeur: 500, premiere: true, seconde: null }, null);
  assert.equal(minuscule.gauche?.premiere, LARGEUR_MIN);
  assert.equal(minuscule.marge, 0);
});

test('plan : largeur pas encore mesurée, tout est posé tel que demandé', () => {
  const plan = planifierRails(0, { largeur: 300, premiere: true, seconde: 300 }, null);
  assert.equal(plan.gauche?.seconde, 300);
  assert.equal(plan.marge, Number.POSITIVE_INFINITY);
});

test('a tab name survives every mutation, leaves with its tab, and is bounded', async () => {
  const { ajouterOnglet, lireColonnes, nommerOnglet, retirerOnglet, inverserColonnes, NOM_ONGLET_MAX } = await import('../components/chat/chat-columns');
  const zones = ['chat.left.widget', 'chat.right.widget'];
  let c = ajouterOnglet(lireColonnes(null, zones), 'chat.right.widget', 'k1');
  c = nommerOnglet(c, 'chat.right.widget#k1', '  Ops\n  board ');
  assert.equal(c.noms?.['chat.right.widget#k1'], 'Ops board');
  c = inverserColonnes(c);
  assert.equal(c.noms?.['chat.right.widget#k1'], 'Ops board', 'another mutation keeps the name');
  assert.deepEqual(lireColonnes(JSON.parse(JSON.stringify(c)), zones).noms, { 'chat.right.widget#k1': 'Ops board' });
  assert.equal(nommerOnglet(c, 'chat.left.widget', 'x'.repeat(60)).noms?.['chat.left.widget']?.length, NOM_ONGLET_MAX);
  assert.equal(nommerOnglet(c, 'chat.right.widget#k1', null).noms, undefined, 'an unnamed column writes no field');
  assert.equal(retirerOnglet(c, 'chat.right.widget', 'chat.right.widget#k1').noms, undefined, 'a closed tab takes its name along');
  assert.equal(lireColonnes({ noms: { 'chat.left.widget#ghost': 'x' } }, zones).noms, undefined);
});

// TODO #647 : un clic rejoué sur l’écriture d’une autre fenêtre garde son sens.
test('replier une colonne déjà repliée ailleurs la laisse repliée', () => {
  const c = colonnesDefaut(KNOWN);
  const folded = poserMasquee(c, LEFT, true);
  assert.equal(estMasquee(folded, LEFT), true);
  assert.equal(poserMasquee(folded, LEFT, true), folded);
  assert.deepEqual(poserMasquee(folded, LEFT, false), c);
});

test('a column resized with its mirror: both move by the same amount, held by the first bound', async () => {
  const { largeursJumelees, LARGEUR_MIN } = await import('../components/chat/chat-columns');
  // Room for 200px more in all: two columns growing at once share it.
  assert.deepEqual(largeursJumelees(300, 500, 500, { largeur: 300, max: 500 }), { largeur: 400, jumelle: 400 });
  assert.deepEqual(largeursJumelees(300, 340, 500, { largeur: 280, max: 480 }), { largeur: 340, jumelle: 320 }, 'an asymmetry is kept, not erased');
  // Shrinking stops at the floor of whichever reaches it first.
  assert.deepEqual(largeursJumelees(300, 100, 500, { largeur: LARGEUR_MIN + 20, max: 500 }), { largeur: 280, jumelle: LARGEUR_MIN });
});

test('the reading column width is stored clamped, and null gives it back to the room', async () => {
  const { poserFil, lireColonnes, FIL_LECTURE_MIN, FIL_LECTURE_MAX } = await import('../components/chat/chat-columns');
  const zones = ['chat.left.widget', 'chat.right.widget'];
  const base = lireColonnes({}, zones);
  assert.equal(base.fil, undefined);
  assert.equal(poserFil(base, 900).fil, 900);
  assert.equal(poserFil(base, 10).fil, FIL_LECTURE_MIN);
  assert.equal(poserFil(base, 99999).fil, FIL_LECTURE_MAX);
  assert.equal(poserFil(poserFil(base, 900), null).fil, undefined);
  // Read back from storage, and dropped when unreadable.
  assert.equal(lireColonnes({ fil: 1000 }, zones).fil, 1000);
  assert.equal(lireColonnes({ fil: 'wide' }, zones).fil, undefined);
});
