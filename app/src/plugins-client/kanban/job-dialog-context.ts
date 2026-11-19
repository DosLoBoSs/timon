'use client';

/** What a `kanban.job.dialog` occupant reads: the job and its gestures (`job-dialog.tsx`). */

import { createContext, useContext } from 'react';
import type { Landing } from './landing-api';

export type JobDialogValue = {
  /** The job, its `links` included when the daemon sends them. */
  landing: Landing;
  close: () => void;
  /** Closes the dialog and opens the idea, when the screen can show one. */
  openTodo: ((id: number) => void) | null;
  /** Closes the dialog and opens the mission's conversation. */
  openMission: (missionId: string) => void;
};

export const JobDialogContext = createContext<JobDialogValue | null>(null);

/** The job a `kanban.job.dialog` occupant paints, and its gestures. */
export function useJobDialog(): JobDialogValue | null {
  return useContext(JobDialogContext);
}
