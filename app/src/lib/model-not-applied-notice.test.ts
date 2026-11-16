import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelNotAppliedNotice } from './model-not-applied-notice';

test('says which model was asked, why it was refused, and which one runs', () => {
  const notice = modelNotAppliedNotice({
    backend: 'opencode', requested_model: 'anthropic/sonnet', active_model: 'opencode/flint-40b-free', model_reason: 'Method not found.',
  });
  assert.ok(notice);
  assert.match(notice, /opencode/);
  assert.match(notice, /anthropic\/sonnet/);
  assert.match(notice, /opencode\/flint-40b-free/);
  assert.match(notice, /Method not found/);
  assert.doesNotMatch(notice, /found\.\./);
});

test('an unknown running model reads as the agent default', () => {
  const notice = modelNotAppliedNotice({ backend: 'hermes', requested_model: 'x', model_reason: 'no' });
  assert.ok(notice);
  assert.match(notice, /default/);
});

test('a refused thinking level is said, alone or after the model', () => {
  const alone = modelNotAppliedNotice({ backend: 'opencode', requested_effort: 'high', effort_reason: 'invalid option' });
  assert.ok(alone);
  assert.match(alone, /high/);
  assert.doesNotMatch(alone, /model \?/);
  const both = modelNotAppliedNotice({
    backend: 'opencode', requested_model: 'b', active_model: 'a', model_reason: 'no', requested_effort: 'high', effort_reason: 'no',
  });
  assert.ok(both);
  assert.match(both, /b.*high/);
});

test('a torn payload says nothing rather than a sentence of question marks', () => {
  assert.equal(modelNotAppliedNotice({}), null);
  const long = modelNotAppliedNotice({ requested_model: 'b', model_reason: `line one\nline two ${'a'.repeat(2000)}` });
  assert.ok(long);
  assert.match(long, /line one line two/);
  assert.ok(long.length < 700);
});
