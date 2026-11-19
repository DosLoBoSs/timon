'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { sseOn } from '@/lib/sse-stream';
import { isPending, listProposals, type ForgeProposal } from './forge-proposals-api';

/**
 * The proposals waiting for a person in `projects`. The daemon raises a
 * notification with each proposal and closes it once published or discarded,
 * so `notifications_changed` is the signal to read them again. A project the
 * reader may not manage answers a refusal: it simply has none here.
 */
export function useForgeProposals(projects: readonly string[]): { pending: ForgeProposal[]; reload: () => void } {
  const [pending, setPending] = useState<ForgeProposal[]>([]);
  const key = [...new Set(projects)].sort().join('\n');
  const latest = useRef(0);

  const reload = useCallback(() => {
    const ask = ++latest.current;
    const slugs = key ? key.split('\n') : [];
    void Promise.all(slugs.map((slug) => listProposals(slug))).then((answers) => {
      if (ask !== latest.current) return;
      setPending(answers.flatMap((out) => (out.ok ? out.value.filter(isPending) : [])));
    });
  }, [key]);

  useEffect(() => {
    reload();
    return sseOn('notifications_changed', () => reload());
  }, [reload]);

  return { pending, reload };
}
