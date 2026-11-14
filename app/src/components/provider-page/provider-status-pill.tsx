'use client';

import type { ReactElement } from 'react';
import { statusTone, type ProviderStatus, type StatusTone } from '@/lib/provider-overview';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/** The one family of pastilles: green ready, yellow action needed, red blocked, grey switched off. */
const DOT: Readonly<Record<StatusTone, string>> = {
  ready: 'bg-emerald-500',
  action: 'bg-amber-500',
  blocked: 'bg-destructive',
  off: 'bg-muted-foreground/50',
};

/** The pastille alone, for a section's own state line (a token stored, missing, unreadable). */
export function ToneDot({ tone }: { tone: StatusTone }): ReactElement {
  return <span aria-hidden data-tone={tone} className={cn('inline-block size-2 shrink-0 rounded-full', DOT[tone])} />;
}

/** A provider's status line: its pastille and its words, the same on the list and on its page. */
export function ProviderStatusPill({ status, className }: { status: ProviderStatus; className?: string }): ReactElement {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground', className)} data-provider-status={status}>
      <ToneDot tone={statusTone(status)} />
      <span className="truncate">{t(`providerStatus.${status}`)}</span>
    </span>
  );
}
