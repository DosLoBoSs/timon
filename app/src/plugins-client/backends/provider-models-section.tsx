'use client';

/**
 * The Models section of a provider page (`settings.provider.section`, key
 * `models`): what the provider serves, which of those the model selectors
 * offer, and the editor of each model — label, picture, context window and,
 * for a provider added by hand, how it thinks.
 *
 * One editor per backend of the provider, each with its own draft and Save:
 * a plugin that brings several backends keeps their lists apart, as the
 * selector does.
 */
import { useState, type ReactElement } from 'react';
import { Search } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ProviderSection } from '@/components/provider-page/provider-section';
import { useProviderPage } from '@/components/provider-page/provider-page-context';
import { t } from '@/lib/i18n';
import { modelsErrorKey, modelsPayload, type CustomBackend } from './form';
import { ModelEditor } from './model-editor';
import { patchBackend, useBackendDraft, useProviderBackends, type ProtocolOption } from './provider-backends';
import { HINT } from './type-scale';

export function ProviderModelsSection(): ReactElement | null {
  const page = useProviderPage();
  const { backends, protocols, reload } = useProviderBackends(page?.provider.backends.map((backend) => backend.id) ?? []);
  const [query, setQuery] = useState('');
  if (!page || backends.length === 0) return null;

  const saved = async (): Promise<void> => {
    await reload();
    await page.refresh();
  };

  return (
    <ProviderSection
      title={t('providerPage.models.title')}
      description={t('providerPage.models.description')}
      actions={(
        <label className="relative flex items-center">
          <Search aria-hidden className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground" />
          <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)}
            aria-label={t('providerPage.models.search')} placeholder={t('providerPage.models.search')}
            className="h-7 w-48 pl-7 text-xs md:text-xs" />
        </label>
      )}
    >
      <div className="space-y-6">
        {backends.map((backend) => (
          <BackendModels key={backend.id} backend={backend} protocols={protocols} query={query}
            titled={backends.length > 1} onSaved={saved} />
        ))}
      </div>
    </ProviderSection>
  );
}

function BackendModels({ backend, protocols, query, titled, onSaved }: {
  backend: CustomBackend;
  protocols: readonly ProtocolOption[];
  query: string;
  /** Several backends on one page: each list says whose it is. */
  titled: boolean;
  onSaved: () => Promise<void>;
}): ReactElement {
  const { draft, patch, dirty, reset, settle } = useBackendDraft(backend, modelsPayload);
  const [busy, setBusy] = useState(false);
  const shown = draft.models.filter((model) => !model.hidden).length;
  const handMade = !draft.origin || draft.origin === 'file';

  const save = async (): Promise<void> => {
    const problem = modelsErrorKey(draft.models);
    if (problem) { toast.error(t(problem)); return; }
    setBusy(true);
    try {
      await patchBackend(backend.id, modelsPayload(draft));
      settle();
      toast.success(t('providerPage.models.saved'));
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2" data-provider-models={backend.id}>
      <p className={HINT} data-models-count>{t('providerPage.models.count', { shown, total: draft.models.length })}</p>
      <ModelEditor
        label={titled ? backend.label : null}
        models={draft.models}
        defaultModel={draft.defaultModel}
        savedSlugs={draft.savedSlugs}
        query={query}
        onChange={patch}
        // Thinking is set by hand only on a provider the user added: a built-in one declares its own levels.
        thinkingControls={handMade ? protocols.find((option) => option.protocol === draft.protocol)?.thinkingControls ?? ['levels'] : null}
      />
      {dirty ? (
        <div className="flex items-center gap-2 pt-1">
          <Button size="sm" disabled={busy} onClick={() => void save()}>{t('backendsSettings.save')}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={reset}>{t('common.cancel')}</Button>
        </div>
      ) : null}
    </div>
  );
}
