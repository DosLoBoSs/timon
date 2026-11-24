'use client';

/**
 * "Allow for this agent" (TODO #1162): a path the mission fence refused, as a
 * card in the mission's conversation, with the folder the daemon offers to
 * open and the two answers.
 *
 * The thread paints the SLOT `chat.fence`, not this card: the product
 * occupies it by default (`fallback`, client half of `@timon/missions`) and a
 * plugin that declares the slot takes its place. The host
 * (`ChatFenceGrantSlot`) owns the card's state and the two gestures; the
 * occupant reads them with `useFenceGrant()` and only draws. A replacement
 * changes the dressing, never what an accord does: the answer goes from the
 * person's session to the daemon, which checks the folder again, adds it to
 * the agent's extra folders and relaunches the mission.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactElement } from 'react';
import { Check, FolderLock, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiErrorMessage } from '@/lib/api-error';
import { answerFenceGrant, type FenceGrantView } from '@/lib/fence-grant';
import { t } from '@/lib/i18n';
import { SlotSingle } from '@/lib/plugin-host/render';
import { CHAT_FENCE_GRANT_SLOT } from '@/lib/plugin-host/slots';
import { cn } from '@/lib/utils';

/** What a `chat.fence` occupant is rendered for, and the only two gestures it has. */
export type FenceGrantValue = {
  grant: FenceGrantView;
  busy: boolean;
  highlighted: boolean;
  /** Opens the folder to the agent and relaunches the mission. Resolves true once the daemon recorded it. */
  allow: () => Promise<boolean>;
  /** Closes the card; nothing is opened. */
  refuse: () => Promise<boolean>;
};

const FenceGrantContext = createContext<FenceGrantValue | null>(null);

/** Readable by a plugin that takes the slot. `null` outside a fence card. */
export function useFenceGrant(): FenceGrantValue | null {
  return useContext(FenceGrantContext);
}

export function ChatFenceGrantSlot({ grant, highlighted = false }: { grant: FenceGrantView; highlighted?: boolean }): ReactElement {
  // The answer given here: the resolution event catches up a moment later.
  const [fresh, setFresh] = useState<FenceGrantView | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = fresh && fresh.id === grant.id && grant.status === 'pending' ? fresh : grant;

  const answer = useCallback(async (decision: 'allow' | 'refuse'): Promise<boolean> => {
    if (busy || shown.status !== 'pending') return false;
    setBusy(true);
    try {
      const outcome = await answerFenceGrant(shown, decision);
      if (!outcome.ok) {
        toast.error(outcome.status === 0 ? t('fenceGrant.failed') : apiErrorMessage(outcome.body, t('fenceGrant.failed')));
        return false;
      }
      setFresh(outcome.view);
      if (decision === 'allow' && outcome.view.status === 'allowed' && outcome.view.relaunched === false) {
        toast.warning(t('fenceGrant.relaunchFailed'));
      }
      return true;
    } finally {
      setBusy(false);
    }
  }, [busy, shown]);

  const allow = useCallback(() => answer('allow'), [answer]);
  const refuse = useCallback(() => answer('refuse'), [answer]);
  const value = useMemo<FenceGrantValue>(
    () => ({ grant: shown, busy, highlighted, allow, refuse }),
    [shown, busy, highlighted, allow, refuse],
  );
  return (
    <FenceGrantContext.Provider value={value}>
      <SlotSingle name={CHAT_FENCE_GRANT_SLOT} />
    </FenceGrantContext.Provider>
  );
}

/** The product's occupant of `chat.fence`. Takes no props: everything comes from `useFenceGrant()`. */
export function FenceGrantCard(): ReactElement | null {
  const ctx = useFenceGrant();
  if (!ctx) return null;
  const { grant, busy, highlighted, allow, refuse } = ctx;
  const open = grant.status === 'pending';
  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-xl rounded-tl-sm border bg-card px-3.5 py-3 text-[13px] shadow-elev-1 transition-[border-color,box-shadow] duration-200 dark:bg-surface-2',
        open ? 'border-[hsl(var(--warning)/0.5)]' : grant.status === 'allowed' ? 'border-[hsl(var(--success)/0.5)]' : 'border-border',
        highlighted && 'ring-2 ring-[hsl(var(--warning))] shadow-[0_0_28px_hsl(var(--warning)/0.55)]',
      )}
      data-fence-grant={grant.status}
    >
      <div className="flex min-w-0 items-start gap-2 [overflow-wrap:anywhere]">
        <FolderLock className="mt-0.5 size-3.5 shrink-0 text-[hsl(var(--warning))]" aria-hidden />
        <span className="text-[12.5px] text-foreground/90">
          {t('fenceGrant.title', { stage: grant.stage, mechanism: grant.mechanism, access: grant.access, path: grant.display })}
        </span>
      </div>
      {open ? (
        <>
          <p className="font-medium [overflow-wrap:anywhere]">
            {t('fenceGrant.question', { agent: grant.agent, mode: grant.folder.mode, folder: grant.folder.display })}
          </p>
          <p className="text-[11.5px] text-muted-foreground">{t('fenceGrant.detail')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" className="h-7 gap-1.5" disabled={busy} onClick={() => void allow()} data-decision="allow">
              <Check className="size-3" />
              {t('fenceGrant.allow')}
            </Button>
            <Button type="button" size="sm" variant="outline" className="h-7 gap-1.5 text-muted-foreground" disabled={busy} onClick={() => void refuse()} data-decision="refuse">
              <X className="size-3" />
              {t('fenceGrant.refuse')}
            </Button>
          </div>
        </>
      ) : (
        <span
          className={cn(
            'flex w-fit max-w-full items-center gap-1 rounded px-2 py-0.5 text-[11px] [overflow-wrap:anywhere]',
            grant.status === 'allowed' ? 'bg-[hsl(var(--success)/0.08)] text-[hsl(var(--success))]' : 'bg-muted text-muted-foreground',
          )}
          data-fence-grant-state={grant.status}
        >
          {grant.status === 'allowed' ? <Check className="size-3 shrink-0" /> : <X className="size-3 shrink-0" />}
          {grant.status === 'allowed'
            ? t('fenceGrant.state.allowed', { folder: grant.folder.display, agent: grant.agent })
            : t('fenceGrant.state.refused')}
        </span>
      )}
    </div>
  );
}
