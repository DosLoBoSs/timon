'use client';

/**
 * The own-settings section of a provider page (`settings.provider.section`,
 * key `settings`): how the provider reads in the model selectors (name and
 * picture) and, for one the user added by hand, where it is reached — protocol,
 * address and key — folded under Advanced, since they are set once when adding
 * it. A provider plugin's own settings (the long-lived Claude token…) are its
 * sections, registered right after this one (`order` 400 to 500).
 *
 * The key is write-only, as everywhere: the daemon never sends it back, so the
 * field is empty and typing one replaces the stored key.
 */
import { useId, useState, type ReactElement } from 'react';
import { CheckCircle2, ChevronRight, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { confirmAction } from '@/components/confirm-dialog/confirm-dialog-context';
import { ProviderSection } from '@/components/provider-page/provider-section';
import { useProviderPage } from '@/components/provider-page/provider-page-context';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  destinationHost, outcomeMessage, settingsErrorKey, settingsPayload, testPayload,
  type BackendForm, type CustomBackend, type TestOutcome,
} from './form';
import { PictoPanel } from './picto-panel';
import { backendErrorText, CUSTOM_API, patchBackend, useBackendDraft, useProviderBackends, type ProtocolOption } from './provider-backends';
import { FIELD, HINT, LABEL } from './type-scale';

type Verdict = ReturnType<typeof outcomeMessage>;

const TONE_CLASS: Readonly<Record<Verdict['tone'], string>> = {
  ok: 'text-emerald-600 dark:text-emerald-400',
  warn: 'text-amber-600 dark:text-amber-400',
  error: 'text-destructive',
};

export function ProviderSettingsSection(): ReactElement | null {
  const page = useProviderPage();
  const { backends, protocols, reload } = useProviderBackends(page?.provider.backends.map((backend) => backend.id) ?? []);
  if (!page || backends.length === 0) return null;
  const saved = async (): Promise<void> => {
    await reload();
    await page.refresh();
  };
  return (
    <ProviderSection title={t('providerPage.settings.title')} description={t('providerPage.settings.description')}>
      <div className="space-y-6">
        {backends.map((backend) => (
          <BackendSettings key={backend.id} backend={backend} protocols={protocols} titled={backends.length > 1}
            onSaved={saved} onRemoved={page.back} />
        ))}
      </div>
    </ProviderSection>
  );
}

/** A provider added by hand whose file Timon wrote: its connection is the user's to change. */
function connectionOf(draft: BackendForm): boolean {
  return (!draft.origin || draft.origin === 'file') && draft.connectionEditable !== false;
}

function BackendSettings({ backend, protocols, titled, onSaved, onRemoved }: {
  backend: CustomBackend;
  protocols: readonly ProtocolOption[];
  titled: boolean;
  onSaved: () => Promise<void>;
  onRemoved: () => void;
}): ReactElement {
  const { draft, patch, dirty, reset, settle } = useBackendDraft(backend, settingsPayload);
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const id = useId();
  const connection = connectionOf(draft);
  const host = connection ? destinationHost(draft.baseUrl) : null;

  const edit = (next: Partial<BackendForm>): void => {
    setVerdict(null);
    patch(next);
  };

  const save = async (): Promise<void> => {
    const problem = settingsErrorKey(draft);
    if (problem) { toast.error(t(problem)); return; }
    setBusy(true);
    try {
      await patchBackend(backend.id, settingsPayload(draft));
      settle();
      toast.success(t('providerPage.settings.saved'));
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // Unchanged connection: the daemon tests the saved address with the stored key, which this screen never holds.
  const test = async (): Promise<void> => {
    const problem = settingsErrorKey(draft);
    if (problem) { toast.error(t(problem)); return; }
    const unchanged = !draft.key.trim() && draft.baseUrl.trim() === (backend.baseUrl ?? '') && draft.protocol === backend.protocol;
    setBusy(true);
    try {
      const res = await fetch(`${CUSTOM_API}/test`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, cache: 'no-store',
        body: JSON.stringify(unchanged ? { id: backend.id } : testPayload(draft)),
      });
      if (!res.ok) throw new Error(await backendErrorText(res));
      setVerdict(outcomeMessage(await res.json() as TestOutcome));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    const name = draft.name || backend.id;
    if (!(await confirmAction({ title: t('backendsSettings.confirmRemove', { name }), confirmLabel: t('confirmDialog.remove'), destructive: true }))) return;
    setBusy(true);
    try {
      const res = await fetch(`${CUSTOM_API}/${encodeURIComponent(backend.id)}`, { method: 'DELETE', cache: 'no-store' });
      if (!res.ok) throw new Error(await backendErrorText(res));
      onRemoved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4" data-provider-settings={backend.id}>
      {titled ? <p className={cn(LABEL, 'm-0')}>{backend.label}</p> : null}
      <div className="space-y-1.5">
        <Label className={LABEL} htmlFor={`${id}-name`}>{t('providerPage.settings.name')}</Label>
        <Input className={cn(FIELD, 'max-w-sm')} id={`${id}-name`} value={draft.name} autoComplete="off"
          onChange={(event) => edit({ name: event.target.value })} />
      </div>
      <div className="space-y-1.5">
        <span className={cn(LABEL, 'block')}>{t('backendsSettings.fields.picto')}</span>
        <PictoPanel value={{ icon: draft.icon, brand: draft.brand }} onChange={(picto) => edit(picto)} />
      </div>

      {connection ? (
        <div className="space-y-3">
          <button type="button" aria-expanded={advanced} aria-controls={`${id}-advanced`} onClick={() => setAdvanced(!advanced)}
            className="-ml-1 flex items-center gap-1 rounded px-1 text-[13px] font-medium hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
            <ChevronRight aria-hidden className={cn('size-3.5 transition-transform', advanced && 'rotate-90')} />
            {t('providerPage.settings.advanced')}
          </button>
          {advanced ? (
            <div id={`${id}-advanced`} className="space-y-4 rounded-md bg-background/60 p-3">
              <p className={cn(HINT, 'm-0')}>{t('providerPage.settings.advancedHint')}</p>
              <fieldset className="space-y-1.5">
                <legend className={LABEL}>{t('backendsSettings.fields.protocol')}</legend>
                <div className="flex flex-wrap gap-4 pt-1.5">
                  {(['anthropic', 'openai-responses'] as const).map((protocol) => {
                    const installed = protocols.find((option) => option.protocol === protocol)?.installed ?? true;
                    return (
                      <label key={protocol} className={cn('flex items-center gap-2 text-[13px]', !installed && 'opacity-50')}>
                        <input type="radio" name={`${id}-protocol`} className="accent-primary" checked={draft.protocol === protocol}
                          onChange={() => (installed ? edit({ protocol }) : toast.error(t('backendsSettings.errors.protocolUnavailable')))} />
                        {t(`backendsSettings.protocols.${protocol}`)}
                      </label>
                    );
                  })}
                </div>
                <p className={HINT}>{t(`backendsSettings.protocolHints.${draft.protocol}`)}</p>
              </fieldset>
              <div className="space-y-1.5">
                <Label className={LABEL} htmlFor={`${id}-url`}>{t('backendsSettings.fields.baseUrl')}</Label>
                <Input className={FIELD} id={`${id}-url`} type="url" inputMode="url" autoComplete="off" value={draft.baseUrl}
                  onChange={(event) => edit({ baseUrl: event.target.value })} />
                {host ? <p className={HINT}>{t('backendsSettings.destinationNotice', { host })}</p> : null}
              </div>
              <div className="space-y-1.5">
                <Label className={LABEL} htmlFor={`${id}-key`}>{t('backendsSettings.fields.key')}</Label>
                <Input className={FIELD} id={`${id}-key`} type="password" autoComplete="off" value={draft.key}
                  onChange={(event) => edit({ key: event.target.value })} />
                <p className={HINT}>{t('backendsSettings.keyHintEdit')}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void test()}>
                  {verdict?.tone === 'ok' ? <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" aria-hidden /> : null}
                  {t('backendsSettings.testButton')}
                </Button>
                {verdict ? <span role="status" className={cn('text-xs', TONE_CLASS[verdict.tone])}>{t(verdict.key, verdict.vars)}</span> : null}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {dirty ? <>
          <Button size="sm" disabled={busy} onClick={() => void save()}>{t('backendsSettings.save')}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setVerdict(null); reset(); }}>{t('common.cancel')}</Button>
        </> : null}
        {draft.origin === 'file' ? (
          <Button type="button" size="sm" variant="ghost" className="ml-auto text-destructive hover:text-destructive" disabled={busy}
            onClick={() => void remove()}>
            <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {t('providerPage.settings.remove')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
