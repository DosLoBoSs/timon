'use client';

/**
 * Settings › AI models › Providers, the own category of `@timon/backends`:
 * the providers list, or the page of one provider when the address names it
 * (`provider=<id>`, `lib/settings-navigation.ts`). The same parameter a refused
 * launch's card opens Settings with, so that card lands on its provider's page.
 */
import type { ReactElement } from 'react';
import { useSearchParams } from 'next/navigation';
import { ProviderPage } from '@/components/provider-page/provider-page';
import { PROVIDER_PARAM } from '@/lib/providers';
import { useProviderNavigation } from '@/lib/settings-navigation';
import { BackendsSettings } from './backends-settings';

export function ProvidersSettings(): ReactElement {
  // Null outside the App Router (a test, a surface mounted elsewhere): the list.
  const requested = useSearchParams()?.get(PROVIDER_PARAM) ?? null;
  const navigation = useProviderNavigation();
  if (requested) return <ProviderPage requested={requested} onBack={navigation.back} onCanonical={navigation.show} />;
  return <BackendsSettings />;
}
