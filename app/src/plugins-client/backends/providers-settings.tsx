'use client';

/**
 * Settings › AI models › Providers, the own category of `@timon/backends`:
 * the providers list, the page of one provider when the address names it
 * (`provider=<id>`, `lib/settings-navigation.ts`), or the "Add a provider"
 * page (`add-provider=[catalog|endpoint]`). The same parameter a refused
 * launch's card opens Settings with, so that card lands on its provider's page.
 *
 * Painted at the viewer's level (`lib/provider-access.ts`): `full` gets every
 * section and the on/off switch of a page, the default provider, Reorder,
 * Check and "Add a provider" on the list; `accounts` the list read only and,
 * on a page, the Connection section alone, with its own subscription
 * accounts; `none` has no tab, and a pasted link reads a refusal.
 */
import type { ReactElement } from 'react';
import { useSearchParams } from 'next/navigation';
import { ProviderPage } from '@/components/provider-page/provider-page';
import { useProviderAccess } from '@/hooks/use-me';
import { ADD_PROVIDER_PARAM, PROVIDER_PARAM, addProviderChoice } from '@/lib/providers';
import { useProviderNavigation } from '@/lib/settings-navigation';
import { t } from '@/lib/i18n';
import { AddProvider } from './add-provider';
import { ProviderActivation } from './provider-activation';
import { ProvidersList } from './providers-list';

export function ProvidersSettings(): ReactElement {
  // Null outside the App Router (a test, a surface mounted elsewhere): the list.
  const params = useSearchParams();
  const requested = params?.get(PROVIDER_PARAM) ?? null;
  const adding = params?.get(ADD_PROVIDER_PARAM) ?? null;
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
  // Adding a provider edits the shared configuration: the full level only.
  if (full && adding !== null) {
    return <AddProvider choice={addProviderChoice(adding)} onChoose={navigation.choose} onBack={navigation.back} onAdded={navigation.show} />;
  }
  return (
    <div className="pt-4">
      <p className="max-w-3xl text-[13px] leading-relaxed text-muted-foreground">{t(full ? 'backendsSettings.intro' : 'providerList.ownAccountsIntro')}</p>
      <div className="mt-5 max-w-3xl">
        {full ? <ProvidersList onOpen={navigation.open} onAdd={navigation.add} /> : <ProvidersList onOpen={navigation.open} readOnly />}
      </div>
    </div>
  );
}
