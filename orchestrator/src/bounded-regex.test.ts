import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileBoundedRegex, SlowRegexError } from './bounded-regex.js';

/** Backtracks for minutes on a line without `!`: what a careless declaration could hold. */
const CATASTROPHIC = '(.*.*)*!$';
const LINE = 'listening on http://127.0.0.1:4096\n';

test('matches like RegExp: test, first group, whole match, no match', () => {
  assert.equal(compileBoundedRegex('^whsec_').test('whsec_abc'), true);
  assert.equal(compileBoundedRegex('^whsec_').test('sk_abc'), false);
  assert.equal(compileBoundedRegex('listening on (http://[^\\s]+)').firstGroup(LINE), 'http://127.0.0.1:4096');
  assert.equal(compileBoundedRegex('listening').firstGroup(LINE), 'listening');
  assert.equal(compileBoundedRegex('(nope)?listening').firstGroup(LINE), 'listening', 'a group that took no part gives the whole match');
  assert.equal(compileBoundedRegex('never').firstGroup(LINE), null);
  assert.equal(compileBoundedRegex('(?<=on )http').test(LINE), true, 'lookarounds stay allowed');
  assert.equal(compileBoundedRegex('^LISTEN', 'i').test(LINE), true);
});

test('a pattern that is not a regular expression throws a SyntaxError of this realm', () => {
  assert.throws(() => compileBoundedRegex('('), SyntaxError);
});

test('a backtracking pattern is interrupted, and the matcher still works after it', () => {
  const re = compileBoundedRegex(CATASTROPHIC, '', 50);
  const started = Date.now();
  assert.throws(() => re.test(LINE), (error: unknown) => error instanceof SlowRegexError && error.timeoutMs === 50);
  assert.throws(() => re.firstGroup(LINE), SlowRegexError);
  // A generous margin: the point is "interrupted", not a timing benchmark on a loaded machine.
  assert.ok(Date.now() - started < 10_000, 'interrupted instead of running for minutes');
  assert.equal(re.test('done!'), true);
});
