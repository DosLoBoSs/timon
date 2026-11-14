'use client';

/**
 * Settings › AI models › Providers, the own category of `@timon/backends`:
 * the providers list, the page of one provider when the address names it
 * (`provider=<id>`, `lib/settings-navigation.ts`), or the "Add a provider"
 * page (`add-provider=[catalog|endpoint]`). The same parameter a refused
 * launch's card opens Settings with, so that card lands on its provider's page.
 */
import type { ReactElement } from 'react';
import { useSearchParams } from 'next/navigation';
import { ProviderPage } from '@/components/provider-page/provider-page';
import { ADD_PROVIDER_PARAM, PROVIDER_PARAM, addProviderChoice } from '@/lib/providers';
import { useProviderNavigation } from '@/lib/settings-navigation';
import { AddProvider } from './add-provider';
import { BackendsSettings } from './backends-settings';
import { ProviderActivation } from './provider-activation';

export function ProvidersSettings(): ReactElement {
  // Null outside the App Router (a test, a surface mounted elsewhere): the list.
  const params = useSearchParams();
  const requested = params?.get(PROVIDER_PARAM) ?? null;
  const adding = params?.get(ADD_PROVIDER_PARAM) ?? null;
  const navigation = useProviderNavigation();
  if (requested) return <ProviderPage requested={requested} onBack={navigation.back} onCanonical={navigation.show} HeaderAction={ProviderActivation} />;
  if (adding !== null) {
    return <AddProvider choice={addProviderChoice(adding)} onChoose={navigation.choose} onBack={navigation.back} onAdded={navigation.show} />;
  }
  return <BackendsSettings onOpenProvider={navigation.open} onAddProvider={navigation.add} />;
}
