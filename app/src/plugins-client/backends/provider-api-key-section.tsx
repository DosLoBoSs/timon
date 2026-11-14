'use client';

/**
 * The API key section of a provider page (`settings.provider.section`, key
 * `apiKey`): one row per key the provider's backends read (`LLMTR_API_KEY`…),
 * saying whether the vault holds it, with "Add a key" or "Replace" opening a
 * small dialog. Write-only like the vault: a saved key is replaced, never
 * shown. Everything else about the entry (its grants, another scope, deleting
 * it) stays in Settings › Secrets, which the row's menu opens.
 *
 * Painted only for a provider that expects a key.
 */
import { useState, type ReactElement } from 'react';
import { KeyRound } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { ProviderSection, ProviderSettingRow } from '@/components/provider-page/provider-section';
import { useProviderPage } from '@/components/provider-page/provider-page-context';
import { TonePill } from '@/components/provider-page/provider-status-pill';
import { refreshBackendCatalog } from '@/lib/backends';
import type { ProviderOverview } from '@/lib/provider-overview';
import { saveProviderSecret } from '@/lib/provider-secret';
import { useSettingsNavigation } from '@/lib/settings-navigation';
import { t } from '@/lib/i18n';
import { SecretValueDialog } from './secret-value-dialog';

/** Whether the section has anything to show for this provider. */
export function expectsApiKey(provider: Pick<ProviderOverview, 'secret'>): boolean {
  return provider.secret.required || provider.secret.names.length > 0;
}

export function ApiKeySection(): ReactElement | null {
  const page = useProviderPage();
  const navigation = useSettingsNavigation();
  if (!page || !expectsApiKey(page.provider)) return null;
  const { provider } = page;
  const { secret } = provider;
  const backendIds = provider.backends.map((backend) => backend.id);
  const openSecrets = <DropdownMenuItem onSelect={() => navigation.select({ category: 'secrets', tab: 'vault' })}>{t('providerPage.apiKey.openSecrets')}</DropdownMenuItem>;
  return (
    <ProviderSection title={t('providerPage.apiKey.title')}>
      {secret.names.length === 0 ? (
        <ProviderSettingRow
          data-api-key={secret.present ? 'present' : 'absent'}
          title={t(secret.present ? 'providerPage.apiKey.present' : 'providerPage.apiKey.absent')}
          status={t('providerPage.apiKey.environment')}
          menu={openSecrets}
        />
      ) : secret.names.map((name) => (
        <KeyRow key={name} name={name} present={secret.present} backendIds={backendIds} onSaved={page.refresh} menu={openSecrets} />
      ))}
    </ProviderSection>
  );
}

function KeyRow({ name, present, backendIds, onSaved, menu }: {
  name: string;
  present: boolean;
  backendIds: readonly string[];
  onSaved: () => Promise<void>;
  menu: ReactElement;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const save = async (value: string): Promise<void> => {
    try {
      await saveProviderSecret(name, value, backendIds);
    } catch (error) {
      toast.error((error as Error).message);
      throw error;
    }
    toast.success(t('providerPage.apiKey.saved', { name }));
    // A key decides which backends a picker may offer.
    refreshBackendCatalog();
    await onSaved();
  };
  return (
    <>
    <ProviderSettingRow
      data-api-key={present ? 'present' : 'absent'}
      data-api-key-name={name}
      title={t(present ? 'providerPage.apiKey.present' : 'providerPage.apiKey.absent')}
      status={<TonePill tone={present ? 'ready' : 'action'} className="flex">{t('providerPage.apiKey.entry', { name })}</TonePill>}
      action={(
        <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => setOpen(true)}>
          <KeyRound aria-hidden className="size-3.5" />
          {t(present ? 'providerPage.apiKey.replace' : 'providerPage.apiKey.add')}
        </Button>
      )}
      menu={menu}
    />
    <SecretValueDialog
        open={open}
        onOpenChange={setOpen}
        title={t(present ? 'providerPage.apiKey.replaceTitle' : 'providerPage.apiKey.addTitle')}
        description={t('providerPage.apiKey.description')}
        label={name}
        placeholder={t(present ? 'providerPage.apiKey.replacePlaceholder' : 'providerPage.apiKey.placeholder')}
        submitLabel={t('providerPage.apiKey.save')}
        onSubmit={save}
      />
    </>
  );
}
