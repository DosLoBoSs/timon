'use client';

/**
 * Settings › AI models › Providers › Add a provider: two ways, chosen first.
 * The catalog installs an agent of the official ACP registry; a compatible
 * endpoint is a service reached at an address the user gives. Either way the
 * new provider joins the list, and its page is where it is set up next.
 *
 * The daemon decides who may add one (a superadmin signed in to the app): a
 * refused read shows its reason here.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { CheckCircle2, Globe, LayoutGrid, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Breadcrumb } from '@/components/provider-page/provider-page';
import type { AddProviderChoice } from '@/lib/providers';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { blankForm, type CustomBackend } from './form';
import { EndpointFields, MANAGE_API, VerdictLine, errorText, useEndpointDraft, type ProtocolOption } from './endpoint-form';
import { ProviderCatalog } from './provider-catalog';

/** The provider id the daemon's overview gives a provider the user added (`provider-overview.ts`). */
export function endpointProviderId(backendId: string): string {
  return `user:${backendId}`;
}

const CHOICES: readonly { id: AddProviderChoice; Icon: LucideIcon }[] = [
  { id: 'catalog', Icon: LayoutGrid },
  { id: 'endpoint', Icon: Globe },
];

export function AddProvider({ choice, onChoose, onBack, onAdded }: {
  /** The way chosen, `null` before a choice. */
  choice: AddProviderChoice | null;
  onChoose: (choice: AddProviderChoice) => void;
  onBack: () => void;
  /** Opens the page of the provider just added. */
  onAdded: (providerId: string) => void;
}): ReactElement {
  return (
    <div className="max-w-3xl space-y-6" data-add-provider={choice ?? ''}>
      <Breadcrumb name={t('providerAdd.title')} onBack={onBack} />
      <div className="space-y-1">
        <h3 className="m-0 text-base font-semibold">{t('providerAdd.title')}</h3>
        <p className="m-0 max-w-[70ch] text-[13px] leading-relaxed text-muted-foreground">{t('providerAdd.intro')}</p>
      </div>
      <div role="radiogroup" aria-label={t('providerAdd.title')} className="grid gap-3 sm:grid-cols-2">
        {CHOICES.map(({ id, Icon }) => {
          const selected = choice === id;
          return (
            <button key={id} type="button" role="radio" aria-checked={selected} data-add-choice={id} onClick={() => onChoose(id)}
              className={cn(
                'flex items-start gap-3 rounded-xl bg-card p-4 text-left shadow-elev-1 hover:bg-muted/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary',
                selected && 'ring-2 ring-primary',
              )}>
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/60">
                <Icon aria-hidden className="size-4" />
              </span>
              <span className="min-w-0 space-y-0.5">
                <span className="block text-[13px] font-semibold">{t(`providerAdd.choices.${id}.title`)}</span>
                <span className="block text-xs leading-relaxed text-muted-foreground">{t(`providerAdd.choices.${id}.body`)}</span>
              </span>
            </button>
          );
        })}
      </div>
      {choice === 'catalog' ? <ProviderCatalog onOpen={onAdded} /> : null}
      {choice === 'endpoint' ? <AddEndpoint onAdded={onAdded} onBack={onBack} /> : null}
    </div>
  );
}

/** The compatible endpoint's form, the same one the list's editor used to open for "Add". */
function AddEndpoint({ onAdded, onBack }: { onAdded: (providerId: string) => void; onBack: () => void }): ReactElement {
  const [protocols, setProtocols] = useState<ProtocolOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const draft = useEndpointDraft((created: CustomBackend | null) => {
    if (created) onAdded(endpointProviderId(created.id));
    else onBack();
  });
  const { open } = draft;

  useEffect(() => {
    open(blankForm());
    // Which protocols this computer can run, read once: a missing one is offered greyed out.
    let gone = false;
    void (async () => {
      try {
        const res = await fetch(MANAGE_API, { cache: 'no-store' });
        if (!res.ok) throw new Error(await errorText(res));
        const body = await res.json() as { protocols?: ProtocolOption[] };
        if (!gone) setProtocols(body.protocols ?? []);
      } catch (err) {
        if (!gone) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { gone = true; };
    // `open` is a fresh closure each render; the draft is opened once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) return <p role="alert" className="m-0 text-[13px] text-destructive">{error}</p>;
  const form = draft.form;
  if (!form) return <p className="m-0 text-[13px] text-muted-foreground">{t('common.loading')}</p>;
  return (
    <form className="space-y-4" aria-labelledby="add-endpoint-title" data-add-endpoint
      onSubmit={(event) => { event.preventDefault(); void draft.save(); }}>
      <div className="space-y-1">
        <h4 id="add-endpoint-title" className="m-0 text-sm font-semibold">{t('providerAdd.choices.endpoint.title')}</h4>
        <p className="m-0 max-w-[70ch] text-xs leading-relaxed text-muted-foreground">{t('providerAdd.endpoint.hint')}</p>
      </div>
      <div className="rounded-xl bg-card p-4 shadow-elev-1">
        <EndpointFields form={form} protocols={protocols} patch={draft.patch} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="secondary" disabled={draft.busy} onClick={() => void draft.test()}>
          {draft.verdict?.tone === 'ok' ? <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" /> : null}
          {t('backendsSettings.testButton')}
        </Button>
        <Button type="submit" size="sm" disabled={draft.busy}>{t('providerAdd.endpoint.submit')}</Button>
        <VerdictLine verdict={draft.verdict} />
      </div>
    </form>
  );
}
