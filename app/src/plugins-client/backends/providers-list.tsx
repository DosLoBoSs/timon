'use client';

/**
 * Settings › AI models › Providers: the default provider on top, then every
 * provider in two groups — "Connected" (a mission can run on it now) and
 * "Other providers" — with a search, one "Check" for every source, and the
 * picker's order in a "Reorder" mode. A row opens the provider's page, where
 * it is also switched on or off: the row stays one target, one status line.
 * "Add a provider" opens the page that offers the catalog or an endpoint.
 *
 * The daemon decides what a provider is and its status (the overview, at the
 * viewer's level of the screen): this list reads it and paints it.
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { ArrowUpDown, Check, Plus, RefreshCw, Search } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BrandMark } from '@/components/brand-mark';
import { ProviderRow } from '@/components/provider-list/provider-row';
import { HostSignInAction } from '@/components/provider-cli/host-sign-in-action';
import { hostSignInOffer } from '@/lib/host-sign-in';
import type { Setting } from '@/components/settings/settings-row';
import { fetchProvidersOverview, type ProviderOverview, type ProvidersOverview } from '@/lib/provider-overview';
import { defaultChoices, groupProviders, verifyProviders } from '@/lib/provider-list';
import { apiErrorMessage } from '@/lib/api-error';
import { sseOn } from '@/lib/sse-stream';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { ProvidersReorder } from './providers-reorder';

type Loaded =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; overview: ProvidersOverview };

/** Events after which what the daemon says of a provider may have changed. */
const REFRESH_ON = ['backends_changed', 'plugins_changed'] as const;

const PREFERRED_KEY = 'TIMON_PREFERRED_BACKEND';
/** The selector's "let Timon choose" entry; never a backend id (those are slugs). */
const AUTO = '__auto__';

export function ProvidersList({ onOpen, onAdd, readOnly = false }: {
  /** Opens the page of one provider (`useProviderNavigation().open`). */
  onOpen: (id: string) => void;
  /** Opens the "Add a provider" page (`useProviderNavigation().add`). */
  onAdd?: () => void;
  /** The own-accounts level: the list and its search, without the default provider, Reorder or Check. */
  readOnly?: boolean;
}): ReactElement {
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [query, setQuery] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [reordering, setReordering] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoaded({ kind: 'ready', overview: await fetchProvidersOverview() });
    } catch (error) {
      setLoaded({ kind: 'failed', message: (error as Error).message });
    }
  }, []);

  useEffect(() => {
    void load();
    const offs = REFRESH_ON.map((kind) => sseOn(kind, () => { void load(); }));
    return () => { for (const off of offs) off(); };
  }, [load]);

  const verify = useCallback(async () => {
    setVerifying(true);
    try {
      const { failed } = await verifyProviders();
      if (failed.length) toast.error(t('providerList.verify.partial', { count: failed.length }), { description: failed.join('\n') });
      else toast.success(t('providerList.verify.done'));
    } finally {
      setVerifying(false);
      await load();
    }
  }, [load]);

  if (loaded.kind === 'loading') return <p className="m-0 text-[13px] text-muted-foreground">{t('common.loading')}</p>;
  if (loaded.kind === 'failed') return <p role="alert" className="m-0 text-[13px] text-destructive">{loaded.message}</p>;

  const { providers } = loaded.overview;
  return (
    <div className="space-y-6" data-providers-list>
      {readOnly ? null : <DefaultProvider overview={loaded.overview} onSaved={load} />}

      <div className="flex flex-wrap items-center gap-2">
        {reordering ? (
          <h4 className="m-0 flex-1 text-sm font-semibold">{t('providerList.reorder.title')}</h4>
        ) : (
          <div className="relative min-w-48 max-w-sm flex-1">
            <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)}
              placeholder={t('providerList.search')} aria-label={t('providerList.search')} className="h-8 pl-8 text-[13px]" />
          </div>
        )}
        {readOnly ? null : <>
          <Button type="button" size="sm" variant={reordering ? 'default' : 'ghost'} className="h-8 gap-1.5" onClick={() => setReordering((on) => !on)}>
            {reordering ? <Check aria-hidden className="size-3.5" /> : <ArrowUpDown aria-hidden className="size-3.5" />}
            {t(reordering ? 'providerList.reorder.done' : 'providerList.reorder.start')}
          </Button>
          <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5" disabled={verifying} onClick={() => void verify()}>
            <RefreshCw aria-hidden className={cn('size-3.5', verifying && 'animate-spin')} />
            {t('providerList.verify.button')}
          </Button>
          {onAdd && !reordering ? (
            <Button type="button" size="sm" className="h-8 gap-1.5" onClick={onAdd} data-add-provider-button>
              <Plus aria-hidden className="size-3.5" />
              {t('providerAdd.title')}
            </Button>
          ) : null}
        </>}
      </div>

      {reordering && !readOnly ? <ProvidersReorder onChanged={() => void load()} /> : (
        <ProviderGroups providers={providers} query={query} onOpen={onOpen} onChanged={() => void load()} />
      )}
    </div>
  );
}

function ProviderGroups({ providers, query, onOpen, onChanged }: {
  providers: readonly ProviderOverview[];
  query: string;
  onOpen: (id: string) => void;
  onChanged: () => void;
}): ReactElement {
  const groups = useMemo(() => groupProviders(providers, query), [providers, query]);
  if (providers.length === 0) return <p className="m-0 text-[13px] text-muted-foreground">{t('providerList.empty')}</p>;
  if (groups.connected.length === 0 && groups.others.length === 0) {
    return <p className="m-0 text-[13px] text-muted-foreground">{t('providerList.noMatch', { query: query.trim() })}</p>;
  }
  return (
    <div className="space-y-6">
      <ProviderGroup id="connected" title={t('providerList.groups.connected')} providers={groups.connected} onOpen={onOpen} onChanged={onChanged} />
      <ProviderGroup id="others" title={t('providerList.groups.others')} providers={groups.others} onOpen={onOpen} onChanged={onChanged} />
    </div>
  );
}

function ProviderGroup({ id, title, providers, onOpen, onChanged }: {
  id: string;
  title: string;
  providers: readonly ProviderOverview[];
  onOpen: (id: string) => void;
  onChanged: () => void;
}): ReactElement | null {
  if (providers.length === 0) return null;
  const heading = `providers-group-${id}`;
  return (
    <section aria-labelledby={heading} data-provider-group={id} className="space-y-2">
      <h4 id={heading} className="m-0 text-xs font-medium text-muted-foreground">
        {title} <span className="tabular-nums">{providers.length}</span>
      </h4>
      <ul className="m-0 flex list-none flex-col gap-0.5 rounded-xl bg-muted p-1">
        {providers.map((provider) => (
          <li key={provider.id}>
            <ProviderRow provider={provider} onOpen={() => onOpen(provider.id)}
              action={hostSignInOffer(provider.connection.host) ? <HostSignInAction host={provider.connection.host} name={provider.name} onDone={onChanged} /> : null} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The provider a mission runs on when nothing names one: the same setting as
 * Settings › Auto switch (`TIMON_PREFERRED_BACKEND`). "Automatic" leaves the
 * choice to Timon, and says which provider that is now.
 */
function DefaultProvider({ overview, onSaved }: { overview: ProvidersOverview; onSaved: () => Promise<void> }): ReactElement {
  const [setting, setSetting] = useState<Setting | null>(null);
  const [saving, setSaving] = useState(false);

  const read = useCallback(async () => {
    const res = await fetch('/api/ui/settings', { cache: 'no-store' }).catch(() => null);
    if (!res?.ok) return;
    const body = await res.json() as { settings?: Setting[] };
    setSetting(body.settings?.find((row) => row.key === PREFERRED_KEY) ?? null);
  }, []);
  useEffect(() => { void read(); }, [read]);

  const choices = useMemo(() => defaultChoices(overview.providers), [overview.providers]);
  const current = String(setting?.value ?? '');
  const value = current && choices.some((choice) => choice.backend === current) ? current : AUTO;
  const locked = setting?.source === 'env' || setting?.source === 'config';
  const resolved = choices.find((choice) => choice.backend === overview.defaultBackend)?.label ?? null;

  const save = async (next: string) => {
    setSaving(true);
    try {
      const res = await fetch('/api/ui/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: PREFERRED_KEY, value: next === AUTO ? null : next }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(apiErrorMessage(err, t('settingsPage.saveError')));
        return;
      }
      await read();
      await onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-labelledby="providers-default" data-default-provider
      className="flex flex-col gap-3 rounded-xl bg-muted px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-8">
      <div className="min-w-0 flex-1 space-y-0.5">
        <h4 id="providers-default" className="m-0 text-sm font-semibold">{t('providerList.default.title')}</h4>
        <p className="m-0 max-w-[60ch] text-xs leading-relaxed text-muted-foreground">
          {locked ? t(setting?.source === 'config' ? 'settingsPage.definedInConfig' : 'settingsPage.forcedByEnv') : t('providerList.default.hint')}
        </p>
      </div>
      <Select value={value} disabled={!setting || locked || saving} onValueChange={(next) => void save(next)}>
        <SelectTrigger className="h-9 w-72 max-w-full text-[12.5px]" aria-label={t('providerList.default.title')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={AUTO}>
            {resolved ? t('providerList.default.autoNamed', { name: resolved }) : t('providerList.default.auto')}
          </SelectItem>
          {choices.map((choice) => (
            <SelectItem key={choice.backend} value={choice.backend}>
              <span className="flex items-center gap-2">
                <BrandMark icon={choice.icon ?? undefined} brand={choice.brand ?? undefined} className="size-4" />
                {choice.label}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </section>
  );
}
