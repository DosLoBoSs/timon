import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { mergeSegments, readResults } from './stt-transcript';

const res = (segments: Array<[string, boolean]>) =>
  segments.map(([transcript, isFinal]) => ({ 0: { transcript }, isFinal }));

test('segments disjoints : simple concaténation', () => {
  assert.equal(mergeSegments(['ok je fais', 'un test de voix']), 'ok je fais un test de voix');
});

test('moteur qui réécrit la phrase entière : une seule copie', () => {
  const steps = ['ok', 'ok je', 'ok je fais', 'ok je fais un nouveau test de voix'];
  assert.equal(mergeSegments(steps), 'ok je fais un nouveau test de voix');
});

test('la ponctuation et la casse ne cassent pas la détection de réécriture', () => {
  assert.equal(mergeSegments(['ok je', 'OK, je fais.']), 'OK, je fais.');
});

test('relivraison à l’identique ignorée', () => {
  assert.equal(mergeSegments(['bonjour Alice', 'bonjour Alice']), 'bonjour Alice');
});

test('segment déjà contenu en fin de texte ignoré', () => {
  assert.equal(mergeSegments(['ok je fais un test', 'un test']), 'ok je fais un test');
});

test('recouvrement partiel : seule la queue inédite est collée', () => {
  assert.equal(
    mergeSegments(['ok je fais un test', 'un test de voix']),
    'ok je fais un test de voix',
  );
});

test('entrées vides ignorées', () => {
  assert.equal(mergeSegments(['', null, '  ', 'ok', undefined]), 'ok');
});

test('readResults sépare définitif et provisoire, sans doublon', () => {
  const r = readResults(
    res([
      ['ok', true],
      ['ok je fais', true],
      ['ok je fais un', false],
    ]),
  );
  assert.equal(r.final, 'ok je fais');
  assert.equal(r.interim, 'ok je fais un');
});

test('readResults lit tous les résultats, pas seulement les derniers', () => {
  const r = readResults(
    res([
      ['bonjour', true],
      ['comment ça va', false],
    ]),
  );
  assert.equal(r.final, 'bonjour');
  assert.equal(r.interim, 'comment ça va');
});

test('le texte envoyé à l’agent ne répète aucun mot', () => {
  const settled = 'ok je fais';
  const session = 'ok je fais un nouveau test de voix pour voir comment ça marche';
  const sent = mergeSegments([settled, session]);
  assert.equal(sent, session);
});
