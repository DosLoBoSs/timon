'use client';

/**
 * One provider's row: logo, name, its one status line, "Update available" and
 * a chevron to its page. Shared by the providers list of Settings › AI models
 * and the onboarding's "Your AIs" step, and a slot (`providers.row`) so a
 * plugin can replace it on both at once: `ProviderRow` is the host that holds
 * the provider and the gestures, `ProductProviderRow` the product's occupant,
 * which reads the host's context like any replacement.
 */
import type { ReactElement, ReactNode } from 'react';
import { ArrowUpCircle, ChevronRight } from 'lucide-react';
import { BrandMark } from '@/components/brand-mark';
import { ProviderStatusPill } from '@/components/provider-page/provider-status-pill';
import { SlotSingle, useSlotEntries } from '@/lib/plugin-host/render';
import { PROVIDER_ROW_SLOT } from '@/lib/plugin-host/slots';
import type { ProviderOverview } from '@/lib/provider-overview';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { ProviderRowProvider, useProviderRow, type ProviderRowMode, type ProviderRowValue } from './provider-row-context';

export function ProviderRow({ provider, onOpen = null, action = null, mode = 'settings' }: {
  provider: ProviderOverview;
  onOpen?: (() => void) | null;
  action?: ReactNode;
  mode?: ProviderRowMode;
}): ReactElement {
  // Not memoized: `action` is an element its host builds on every render, so a memo would never hit.
  const value: ProviderRowValue = { mode, provider, status: provider.status, open: onOpen, action };
  // An empty slot (a page the bundled halves do not reach) still gets the product's row.
  const claimed = useSlotEntries(PROVIDER_ROW_SLOT).length > 0;
  return (
    <ProviderRowProvider value={value}>
      {claimed ? <SlotSingle name={PROVIDER_ROW_SLOT} /> : <ProductProviderRow />}
    </ProviderRowProvider>
  );
}

/** The product's row, as the default occupant of `providers.row`. Takes no props: it reads the host. */
export function ProductProviderRow(): ReactElement | null {
  const row = useProviderRow();
  if (!row) return null;
  const { provider, status, open, action } = row;
  const body = (
    <>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/60">
        <BrandMark icon={provider.icon ?? undefined} brand={provider.brand ?? undefined} className="size-4" />
      </span>
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="block truncate text-[13px] font-medium">{provider.name}</span>
        <ProviderStatusPill status={status} className="flex" />
      </span>
      {provider.updateAvailable ? <UpdateAvailable /> : null}
    </>
  );
  return (
    <div className="flex min-w-0 items-center gap-2" data-provider-row={provider.id}>
      {open ? (
        <button type="button" onClick={open} aria-label={t('providerList.open', { name: provider.name })}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-muted/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
          {body}
          <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-3 px-2 py-2">{body}</div>
      )}
      {action ? <div className="flex shrink-0 items-center pr-2">{action}</div> : null}
    </div>
  );
}

/** A yellow chip: an update is an action waiting, in the one family of pastilles. */
function UpdateAvailable({ className }: { className?: string }): ReactElement {
  return (
    <span data-provider-update
      className={cn('inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400', className)}>
      <ArrowUpCircle aria-hidden className="size-3" />
      {t('providerList.updateAvailable')}
    </span>
  );
}
