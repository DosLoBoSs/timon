'use client';

/**
 * The page of one provider (Settings › AI models › Providers › <name>): a
 * breadcrumb back to the list, the header every provider shares, then the
 * sections of the `settings.provider.section` slot — the product's common ones
 * and those of the plugin that brings this provider (`provider-sections.ts`).
 *
 * The daemon decides what a provider is and what it may show, at the viewer's
 * level of the screen (`lib/provider-access.ts`): this page reads its overview
 * and paints it; `sections: 'connection'` keeps the Connection section alone.
 */
import { useCallback, useEffect, useMemo, useState, type ComponentType, type ReactElement, type ReactNode } from 'react';
import { AlertTriangle, ChevronRight } from 'lucide-react';
import { BrandMark } from '@/components/brand-mark';
import { PluginBoundary } from '@/lib/plugin-host/plugin-boundary';
import { useSlotEntries } from '@/lib/plugin-host/render';
import { fetchProvidersOverview, resolveProviderId, type ProvidersOverview } from '@/lib/provider-overview';
import { sseOn } from '@/lib/sse-stream';
import { t } from '@/lib/i18n';
import { ProviderPageProvider, type ProviderPageValue } from './provider-page-context';
import { PROVIDER_SECTION_SLOT, sectionsFor } from './provider-sections';
import { ProviderStatusPill } from './provider-status-pill';

type Loaded =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; overview: ProvidersOverview };

/** Events after which what the daemon says of a provider may have changed. */
const REFRESH_ON = ['backends_changed', 'plugins_changed'] as const;

export function ProviderPage({ requested, onBack, onCanonical, HeaderAction, sections = 'all' }: {
  /** What `provider=` names: a provider id, or the plugin or backend id an older link carries. */
  requested: string;
  onBack: () => void;
  /** The provider's own id, when `requested` named it otherwise: the host rewrites the address. */
  onCanonical?: (id: string) => void;
  /** Painted at the right of the header, inside the page's context (the host's on/off switch). */
  HeaderAction?: ComponentType;
  /** `connection`: the Connection section alone (the own-accounts level), whoever paints it. */
  sections?: 'all' | 'connection';
}): ReactElement {
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });

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

  const provider = loaded.kind === 'ready' ? resolveProviderId(loaded.overview.providers, requested) : null;

  // A refused launch's card names the plugin; the page's address names the provider.
  const canonical = provider && provider.id !== requested ? provider.id : null;
  useEffect(() => {
    if (canonical) onCanonical?.(canonical);
  }, [canonical, onCanonical]);

  const value = useMemo<ProviderPageValue | null>(() => (provider && loaded.kind === 'ready'
    ? { provider, status: provider.status, defaultBackend: loaded.overview.defaultBackend, refresh: load, back: onBack }
    : null), [provider, loaded, load, onBack]);

  return (
    <div className="max-w-3xl space-y-6" data-provider-page={provider?.id ?? requested}>
      <Breadcrumb name={provider?.name ?? null} onBack={onBack} />
      {loaded.kind === 'loading' ? <p className="m-0 text-[13px] text-muted-foreground">{t('common.loading')}</p> : null}
      {loaded.kind === 'failed' ? <p role="alert" className="m-0 text-[13px] text-destructive">{loaded.message}</p> : null}
      {loaded.kind === 'ready' && !value ? <p className="m-0 text-[13px] text-muted-foreground">{t('providerPage.notFound')}</p> : null}
      {value ? (
        <ProviderPageProvider value={value}>
          <ProviderHeader value={value} action={HeaderAction ? <HeaderAction /> : null} />
          <ProviderSections pluginId={value.provider.pluginId} only={sections === 'connection' ? 'connection' : null} />
        </ProviderPageProvider>
      ) : null}
    </div>
  );
}

/** "Providers › <where you are>": the way back to the list, shared by the pages under it. */
export function Breadcrumb({ name, onBack }: { name: string | null; onBack: () => void }): ReactElement {
  return (
    <nav aria-label={t('providerPage.breadcrumb')} className="flex min-w-0 items-center gap-1 text-[13px]">
      <button type="button" onClick={onBack}
        className="rounded px-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
        {t('providerPage.root')}
      </button>
      {name ? <>
        <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span aria-current="page" className="min-w-0 truncate font-medium">{name}</span>
      </> : null}
    </nav>
  );
}

/**
 * Why a blocked provider cannot run, as the daemon says it of its backends (a
 * file it could not read, a protocol nobody brings…): nothing else on the page
 * would say it. Only the full level receives reasons; they may name a key,
 * never a value.
 */
function blockedReasons(value: ProviderPageValue): string[] {
  if (value.status !== 'blocked') return [];
  const reasons = value.provider.backends.flatMap((backend) => (!backend.active && !backend.disabled && backend.reason ? [backend.reason] : []));
  return [...new Set(reasons)];
}

function ProviderHeader({ value, action }: { value: ProviderPageValue; action: ReactNode }): ReactElement {
  const { provider } = value;
  const reasons = blockedReasons(value);
  return (
    <>
    <header className="flex items-center gap-4">
      <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-muted/60">
        <BrandMark icon={provider.icon ?? undefined} brand={provider.brand ?? undefined} className="size-7" />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <h3 className="m-0 truncate text-base font-semibold">{provider.name}</h3>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <ProviderStatusPill status={value.status} />
          {provider.isDefault ? <span className="text-xs text-muted-foreground">{t('providerPage.default')}</span> : null}
          {provider.agentCount !== undefined
            ? <span className="text-xs tabular-nums text-muted-foreground">{t('providerPage.agents', { count: provider.agentCount })}</span>
            : null}
        </div>
      </div>
      {action}
    </header>
    {reasons.map((reason) => (
      <p key={reason} className="m-0 flex items-start gap-1.5 text-xs text-destructive" data-provider-reason>
        <AlertTriangle aria-hidden className="mt-px size-3.5 shrink-0" />
        <span>{reason}</span>
      </p>
    ))}
    </>
  );
}

/** The slot's entries for this provider, each in its own boundary: a failing section never takes the page down. */
function ProviderSections({ pluginId, only }: { pluginId: string | null; only: string | null }): ReactElement {
  const entries = useSlotEntries(PROVIDER_SECTION_SLOT);
  const sections = useMemo(
    () => sectionsFor(entries, pluginId).filter((entry) => only === null || entry.key === only),
    [entries, pluginId, only],
  );
  return (
    // A section with nothing to say renders nothing: its empty wrapper leaves no gap.
    <div className="flex flex-col gap-6 [&>:empty]:hidden">
      {sections.map(({ id, pluginId: owner, key, Component }) => (
        <div key={id} data-provider-section={key ?? owner}>
          <PluginBoundary pluginId={owner}><Component /></PluginBoundary>
        </div>
      ))}
    </div>
  );
}
