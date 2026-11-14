'use client';

/**
 * The common sections of a provider page, as the default entries of
 * `settings.provider.section` (`components/provider-page/provider-sections.ts`).
 *
 * Mostly empty for now: each paints nothing until the step of the providers
 * redesign that fills it (Connection and API key, Program, own settings and
 * Models). Registered already so the page's order, and a plugin's way of
 * taking the place of one of them, are fixed before their content lands.
 *
 * One exception: a refused launch's card opens the page of its provider, and
 * the program that provider waits to run must be authorizable from there. So
 * the Program section already offers that review — and only that — until the
 * full section absorbs it.
 */
import { useState, type ComponentType, type ReactElement } from 'react';
import { ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ProviderSection } from '@/components/provider-page/provider-section';
import { useProviderPage } from '@/components/provider-page/provider-page-context';
import type { ProviderSectionKey } from '@/components/provider-page/provider-sections';
import { fetchProviders, providerToAuthorize, type ProviderPlugin } from '@/lib/providers';
import { t } from '@/lib/i18n';
import { ProviderAuthorizeDialog } from './provider-authorize-dialog';

const Empty: ComponentType = () => null;

function ProgramSection(): ReactElement | null {
  const page = useProviderPage();
  const [reviewing, setReviewing] = useState<ProviderPlugin | null>(null);
  const [busy, setBusy] = useState(false);

  const pluginId = page?.provider.pluginId ?? null;
  const waiting = page !== null && pluginId !== null
    && page.provider.programs.some((program) => program.authorization === 'authorize');
  if (!page || !pluginId || !waiting) return null;

  // The dialog shows what the daemon resolves at the click, never what the overview read earlier.
  const review = async (): Promise<void> => {
    setBusy(true);
    try {
      const target = providerToAuthorize(await fetchProviders(), pluginId);
      if (target) setReviewing(target);
      else await page.refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ProviderSection
        title={t('providerPage.program.title')}
        description={t('providerPage.program.waiting')}
        actions={(
          <Button size="sm" className="h-7 gap-1.5 text-xs" disabled={busy} onClick={() => void review()}>
            <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
            {t('providersSettings.plugins.authorize')}
          </Button>
        )}
      />
      <ProviderAuthorizeDialog provider={reviewing} onClose={() => setReviewing(null)} onAuthorized={page.refresh} />
    </>
  );
}

export const COMMON_PROVIDER_SECTIONS: Readonly<Record<ProviderSectionKey, ComponentType>> = {
  connection: Empty,
  apiKey: Empty,
  program: ProgramSection,
  settings: Empty,
  models: Empty,
};
