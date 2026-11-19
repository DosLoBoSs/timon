'use client';

/**
 * The host of a Kanban job's dialog (`kanban.job.dialog`): the Jobs widget,
 * the landing badge of a TO DO idea and the Pull requests widget open the same
 * one. It hands the occupant the job and its gestures through `useJobDialog()`;
 * the occupant draws the window, so a plugin that takes the slot repaints the
 * dialog everywhere at once.
 *
 * The gestures (read the checks again, ask for a repair) belong to the host:
 * it keeps the job fresh in the window and hands it back to the screen that
 * opened it (`onChange`), so its row shows the same counter.
 *
 * The product's dialog is painted directly while only its registered fallback
 * holds the slot, as `TodoFormModal` does: the fallback is a chunk loaded on
 * demand, and the dialog must not wait for it.
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { toast } from 'sonner';
import { SlotSingle, useSlotEntries } from '@/lib/plugin-host/render';
import { JOB_DIALOG_SLOT } from '@/lib/plugin-host/slots';
import { chatMissionHref } from '@/lib/chat-island-params';
import { t } from '@/lib/i18n';
import { requestNavigation } from '@/lib/navigate-proposals';
import { ProductJobDialog } from './landing-preview-dialog';
import { JobDialogContext, type JobDialogValue } from './job-dialog-context';
import { refreshLandingChecks, type Landing, type RepairKind } from './landing-api';
import { askRepair } from './landing-repair';

export function JobDialog({ landing, onClose, openTodo = null, onChange }: {
  landing: Landing;
  onClose: () => void;
  openTodo?: ((id: number) => void) | null;
  /** The job as the daemon last answered it, after a gesture of the window. */
  onChange?: (landing: Landing) => void;
}): ReactElement {
  const [current, setCurrent] = useState(landing);
  const [busy, setBusy] = useState<JobDialogValue['busy']>(null);
  useEffect(() => { setCurrent(landing); }, [landing]);

  const update = useCallback((fresh: Landing) => {
    setCurrent(fresh);
    onChange?.(fresh);
  }, [onChange]);

  const refresh = useCallback(async () => {
    setBusy('refresh');
    const out = await refreshLandingChecks(current.id);
    setBusy(null);
    if (out.ok) update(out.value);
    else toast.error(t('landings.refresh'), { description: out.message });
  }, [current.id, update]);

  const repair = useCallback(async (kind: RepairKind) => {
    setBusy(kind);
    const fresh = await askRepair(current, kind);
    setBusy(null);
    if (fresh) update(fresh);
    return fresh !== null;
  }, [current, update]);

  const value = useMemo<JobDialogValue>(() => ({
    landing: current,
    busy,
    refresh,
    repair,
    close: onClose,
    openTodo: openTodo ? (id) => { onClose(); openTodo(id); } : null,
    openMission: (missionId) => { onClose(); requestNavigation(chatMissionHref(missionId)); },
  }), [current, busy, refresh, repair, onClose, openTodo]);
  const occupant = useSlotEntries(JOB_DIALOG_SLOT)[0];
  return (
    <JobDialogContext.Provider value={value}>
      {occupant && !occupant.fallback ? <SlotSingle name={JOB_DIALOG_SLOT} /> : <ProductJobDialog />}
    </JobDialogContext.Provider>
  );
}
