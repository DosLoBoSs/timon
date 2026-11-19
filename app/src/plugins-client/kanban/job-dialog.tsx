'use client';

/**
 * The host of a Kanban job's dialog (`kanban.job.dialog`): the Jobs widget,
 * the landing badge of a TO DO idea and the Pull requests widget open the same
 * one. It hands the occupant the job and its gestures through `useJobDialog()`
 * and keeps the frame; a plugin that takes the slot repaints the dialog
 * everywhere at once.
 *
 * The product's dialog is painted directly while only its registered fallback
 * holds the slot, as `TodoFormModal` does: the fallback is a chunk loaded on
 * demand, and the dialog must not wait for it.
 */

import { useMemo, type ReactElement } from 'react';
import { SlotSingle, useSlotEntries } from '@/lib/plugin-host/render';
import { JOB_DIALOG_SLOT } from '@/lib/plugin-host/slots';
import { chatMissionHref } from '@/lib/chat-island-params';
import { requestNavigation } from '@/lib/navigate-proposals';
import { ProductJobDialog } from './landing-preview-dialog';
import { JobDialogContext, type JobDialogValue } from './job-dialog-context';
import type { Landing } from './landing-api';

export function JobDialog({ landing, onClose, openTodo = null }: {
  landing: Landing;
  onClose: () => void;
  openTodo?: ((id: number) => void) | null;
}): ReactElement {
  const value = useMemo<JobDialogValue>(() => ({
    landing,
    close: onClose,
    openTodo: openTodo ? (id) => { onClose(); openTodo(id); } : null,
    openMission: (missionId) => { onClose(); requestNavigation(chatMissionHref(missionId)); },
  }), [landing, onClose, openTodo]);
  const occupant = useSlotEntries(JOB_DIALOG_SLOT)[0];
  return (
    <JobDialogContext.Provider value={value}>
      {occupant && !occupant.fallback ? <SlotSingle name={JOB_DIALOG_SLOT} /> : <ProductJobDialog />}
    </JobDialogContext.Provider>
  );
}
