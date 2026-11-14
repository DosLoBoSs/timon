'use client';

/**
 * The API key section of a provider page (`settings.provider.section`, key
 * `apiKey`): whether the vault holds the key this provider's backends read
 * (`LLMTR_API_KEY`…), and a field to write it. Write-only like the vault: the
 * field starts empty, a saved key is replaced, never shown. Everything else
 * about the entry (its grants, another scope, deleting it) stays in
 * Settings › Secrets, which the section links to.
 *
 * Painted only for a provider that expects a key.
 */
import { useState, type FormEvent, type ReactElement } from 'react';
import { KeyRound } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ProviderSection } from '@/components/provider-page/provider-section';
import { useProviderPage } from '@/components/provider-page/provider-page-context';
import { ToneDot } from '@/components/provider-page/provider-status-pill';
import { refreshBackendCatalog } from '@/lib/backends';
import type { ProviderOverview } from '@/lib/provider-overview';
import { saveProviderSecret } from '@/lib/provider-secret';
import { useSettingsNavigation } from '@/lib/settings-navigation';
import { t } from '@/lib/i18n';

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
  return (
    <ProviderSection
      title={t('providerPage.apiKey.title')}
      description={t('providerPage.apiKey.description')}
      actions={(
        <Button type="button" size="sm" variant="ghost" className="h-7 gap-1.5 text-xs"
          onClick={() => navigation.select({ category: 'secrets', tab: 'vault' })}>
          <KeyRound className="size-3.5" aria-hidden />
          {t('providerPage.apiKey.openSecrets')}
        </Button>
      )}
    >
      <div className="space-y-3">
        <p className="m-0 inline-flex items-center gap-1.5 text-[13px]" data-api-key={secret.present ? 'present' : 'absent'}>
          <ToneDot tone={secret.present ? 'ready' : 'action'} />
          {secret.present ? t('providerPage.apiKey.present') : t('providerPage.apiKey.absent')}
        </p>
        {secret.names.length === 0
          ? <p className="m-0 text-xs leading-relaxed text-muted-foreground">{t('providerPage.apiKey.environment')}</p>
          : secret.names.map((name) => (
            <KeyField key={name} name={name} present={secret.present} backendIds={backendIds} onSaved={page.refresh} />
          ))}
      </div>
    </ProviderSection>
  );
}

function KeyField({ name, present, backendIds, onSaved }: {
  name: string;
  present: boolean;
  backendIds: readonly string[];
  onSaved: () => Promise<void>;
}): ReactElement {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (value.trim() === '') return;
    setBusy(true);
    try {
      await saveProviderSecret(name, value.trim(), backendIds);
      // The value leaves the page's state as soon as the vault has it.
      setValue('');
      toast.success(t('providerPage.apiKey.saved', { name }));
      // A key decides which backends a picker may offer.
      refreshBackendCatalog();
      await onSaved();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="flex flex-col gap-1.5" onSubmit={(event) => void submit(event)} data-api-key-name={name}>
      <label className="text-xs font-medium" htmlFor={`provider-key-${name}`}>{name}</label>
      <div className="flex gap-2">
        <Input
          id={`provider-key-${name}`}
          type="password"
          autoComplete="off"
          spellCheck={false}
          className="h-8 text-[13px]"
          value={value}
          placeholder={present ? t('providerPage.apiKey.replacePlaceholder') : t('providerPage.apiKey.placeholder')}
          onChange={(event) => setValue(event.target.value)}
        />
        <Button type="submit" size="sm" className="h-8 shrink-0" disabled={busy || value.trim() === ''}>
          {present ? t('providerPage.apiKey.replace') : t('providerPage.apiKey.save')}
        </Button>
      </div>
    </form>
  );
}
