/**
 * The highlights of the update window, read out of the offer's plain-text
 * notes: the bullets of `### Highlights`, without Markdown marks, five at
 * most; nothing when the maintainer wrote no such section.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HIGHLIGHT_MAX, releaseHighlights } from './update-highlights';

test('the bullets of ### Highlights, up to the next heading, in their order', () => {
  const notes = '### Highlights\n- Updates install from the app\n* A notice card\n+ Faster boot\n\n### Added\n- Not a highlight\n';
  assert.deepEqual(releaseHighlights(notes), ['Updates install from the app', 'A notice card', 'Faster boot']);
});

test('anywhere in the section, CRLF or not, heading in any case', () => {
  const notes = '### Added\r\n- Other\r\n\r\n### highlights\r\n- One\r\n- Two\r\n';
  assert.deepEqual(releaseHighlights(notes), ['One', 'Two']);
});

test('no section, an empty one, or no notes: no highlights', () => {
  assert.deepEqual(releaseHighlights('### Added\n- Something\n'), []);
  assert.deepEqual(releaseHighlights('### Highlights\n\n### Added\n- Something\n'), []);
  assert.deepEqual(releaseHighlights(''), []);
  assert.deepEqual(releaseHighlights(null), []);
});

test('plain text: links keep their words, emphasis and code their content', () => {
  const notes = '### Highlights\n- **Install** from the [update window](https://docs.timon-ai.com/x), with `pkexec`\n- An _italic_ word and snake_case_names stay\n';
  assert.deepEqual(releaseHighlights(notes), [
    'Install from the update window, with pkexec',
    'An italic word and snake_case_names stay',
  ]);
});

test('a wrapped bullet is one highlight; five at most; a long one is cut', () => {
  const many = Array.from({ length: 7 }, (_, i) => `- Item ${i + 1}`).join('\n');
  assert.deepEqual(releaseHighlights(`### Highlights\n- First half\n  and its end\n${many}`).slice(0, 2), ['First half and its end', 'Item 1']);
  assert.equal(releaseHighlights(`### Highlights\n${many}`).length, 5);
  const [long] = releaseHighlights(`### Highlights\n- ${'word '.repeat(80)}`);
  assert.equal(long?.length, HIGHLIGHT_MAX);
  assert.ok(long?.endsWith('…'));
});
