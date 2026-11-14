'use client';

/**
 * Settings › AI models › Providers, the own category of `@timon/backends`:
 * the providers list, or the page of one provider when the address names it
 * (`provider=<id>`, `lib/settings-navigation.ts`). The same parameter a refused
 * launch's card opens Settings with, so that card lands on its provider's page.
 *
 * Painted at the viewer's level (`lib/provider-access.ts`): `full` gets every
 * section, the on/off switch and the editing below the list; `accounts` the
 * list read only and, on a page, the Connection section alone, with its own
 * subscription accounts; `none` has no tab, and a pasted link reads a refusal.
 */
import type { ReactElement } from 'react';
import { useSearchParams } from 'next/navigation';
import { ProviderPage } from '@/components/provider-page/provider-page';
import { useProviderAccess } from '@/hooks/use-me';
import { PROVIDER_PARAM } from '@/lib/providers';
import { useProviderNavigation } from '@/lib/settings-navigation';
import { t } from '@/lib/i18n';
import { BackendsSettings } from './backends-settings';
import { ProviderActivation } from './provider-activation';
import { ProvidersList } from './providers-list';

export function ProvidersSettings(): ReactElement {
  // Null outside the App Router (a test, a surface mounted elsewhere): the list.
  const requested = useSearchParams()?.get(PROVIDER_PARAM) ?? null;
  const navigation = useProviderNavigation();
  const access = useProviderAccess();
  if (access === null) return <p className="pt-4 text-[13px] text-muted-foreground">{t('common.loading')}</p>;
  if (access === 'none') return <p className="pt-4 text-[13px] text-muted-foreground" data-providers-hidden>{t('providerList.hidden')}</p>;
  const full = access === 'full';
  if (requested) {
    return (
      <ProviderPage requested={requested} onBack={navigation.back} onCanonical={navigation.show}
        {...(full ? { HeaderAction: ProviderActivation } : { sections: 'connection' as const })} />
    );
  }
  if (full) return <BackendsSettings onOpenProvider={navigation.open} />;
  return (
    <div className="pt-4">
      <p className="max-w-3xl text-[13px] leading-relaxed text-muted-foreground">{t('providerList.ownAccountsIntro')}</p>
      <div className="mt-5 max-w-3xl">
        <ProvidersList onOpen={navigation.open} readOnly />
      </div>
    </div>
  );
}
