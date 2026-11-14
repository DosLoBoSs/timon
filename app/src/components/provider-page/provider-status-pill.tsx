'use client';

import type { ReactElement, ReactNode } from 'react';
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

/** A pastille and its words: every state a provider page shows reads the same way. */
export function TonePill({ tone, children, className, ...data }: {
  tone: StatusTone;
  children: ReactNode;
  className?: string;
  [data: `data-${string}`]: string;
}): ReactElement {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground', className)} data-tone={tone} {...data}>
      <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', DOT[tone])} />
      <span className="truncate">{children}</span>
    </span>
  );
}

/** A provider's status line: its pastille and its words, the same on the list and on its page. */
export function ProviderStatusPill({ status, className }: { status: ProviderStatus; className?: string }): ReactElement {
  return (
    <TonePill tone={statusTone(status)} className={className} data-provider-status={status}>
      {t(`providerStatus.${status}`)}
    </TonePill>
  );
}
