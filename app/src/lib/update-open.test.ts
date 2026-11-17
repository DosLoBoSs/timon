/** The one door into "update now": the last flow registered opens, its removal gives the place back. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openUpdateDialog, provideUpdateDialog, resetUpdateDialogForTests } from './update-open';

test('nothing registered: openUpdateDialog says so', () => {
  resetUpdateDialogForTests();
  assert.equal(openUpdateDialog(), false);
});

test('the last flow registered opens; removing it gives the place back', () => {
  resetUpdateDialogForTests();
  const opened: string[] = [];
  const removeCard = provideUpdateDialog(() => { opened.push('card'); });
  const removeWindow = provideUpdateDialog(() => { opened.push('window'); });
  assert.equal(openUpdateDialog(), true);
  removeWindow();
  removeWindow();
  assert.equal(openUpdateDialog(), true);
  removeCard();
  assert.equal(openUpdateDialog(), false);
  assert.deepEqual(opened, ['window', 'card']);
});
