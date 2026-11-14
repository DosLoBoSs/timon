'use client';

/**
 * Settings › AI models › Providers › Add a provider › Catalog: the agents of
 * the official ACP registry, with a search and one state line each. An agent
 * installed here becomes a provider of the list, with its page. What a
 * provider plugin may run is reviewed on that page (its Program section).
 *
 * Superadmin only, and the daemon is what enforces it: a refused read shows
 * its reason. The registry is a third-party CDN: it is read when the catalog
 * is chosen, and nothing is downloaded before a click that names it.
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { AlertTriangle, CheckCircle2, ChevronRight, Copy, Download, KeyRound, RefreshCw, Search, ShieldCheck, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { TonePill } from '@/components/provider-page/provider-status-pill';
import {
  acpAction, acpStateLine, fetchAcpAuthMethods, fetchAcpRegistry, installAcpAgent, orderAuthMethods, removeAcpAgent,
  type AcpAgent, type AcpAuthMethod, type AcpRegistry,
} from '@/lib/providers';
import { filterAcpAgents } from '@/lib/provider-list';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/** The provider id the daemon's overview gives an installed catalogue agent (`provider-overview.ts`). */
export function catalogProviderId(agentId: string): string {
  return `catalog:${agentId}`;
}

export function ProviderCatalog({ onOpen }: {
  /** Opens the page of the provider an installed agent became. */
  onOpen: (providerId: string) => void;
}): ReactElement {
  const [registry, setRegistry] = useState<AcpRegistry | null>(null);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  // An ACP agent whose build carries no checksum, waiting for the person's explicit go.
  const [unverified, setUnverified] = useState<AcpAgent | null>(null);
  // Sign-in methods by agent, read on a click: asking starts the agent's program on the daemon.
  const [signIns, setSignIns] = useState<Record<string, AcpAuthMethod[]>>({});

  const loadRegistry = useCallback(async (refresh = false) => {
    setRegistryError(null);
    setRefreshing(refresh);
    try { setRegistry(await fetchAcpRegistry(refresh)); } catch (err) { setRegistryError((err as Error).message); } finally { setRefreshing(false); }
  }, []);

  useEffect(() => { void loadRegistry(); }, [loadRegistry]);

  const agents = useMemo(() => filterAcpAgents(registry?.agents ?? [], query), [registry, query]);

  const run = async (key: string, work: () => Promise<void>): Promise<void> => {
    setBusy(key);
    try { await work(); } catch (err) { toast.error((err as Error).message); } finally { setBusy(null); }
  };

  const install = (agent: AcpAgent, acceptUnverified: boolean): Promise<void> => run(`install:${agent.id}`, async () => {
    const wasInstalled = agent.installed !== null;
    await installAcpAgent(agent.id, acceptUnverified);
    setUnverified(null);
    toast.success(t(wasInstalled ? 'providersSettings.acp.updated' : 'providersSettings.acp.installed', { name: agent.name }));
    await loadRegistry();
  });

  const toggleSignIn = (agent: AcpAgent): Promise<void> => {
    if (signIns[agent.id]) {
      setSignIns(({ [agent.id]: _shown, ...rest }) => rest);
      return Promise.resolve();
    }
    return run(`auth:${agent.id}`, async () => {
      const methods = await fetchAcpAuthMethods(agent.id);
      setSignIns((current) => ({ ...current, [agent.id]: orderAuthMethods(methods) }));
    });
  };

  const remove = (agent: AcpAgent): Promise<void> => run(`remove:${agent.id}`, async () => {
    setSignIns(({ [agent.id]: _gone, ...rest }) => rest);
    await removeAcpAgent(agent.id);
    toast.success(t('providersSettings.acp.removed', { name: agent.name }));
    await loadRegistry();
  });

  return (
    <section className="space-y-3" aria-labelledby="providers-catalog-title" data-provider-catalog>
      <div className="space-y-1">
        <h4 id="providers-catalog-title" className="m-0 text-sm font-semibold">{t('providersSettings.acp.title')}</h4>
        <p className="m-0 max-w-[70ch] text-xs leading-relaxed text-muted-foreground">{t('providersSettings.acp.description')}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 max-w-sm flex-1">
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder={t('providersSettings.acp.search')} aria-label={t('providersSettings.acp.search')} className="h-8 pl-8 text-[13px]" />
        </div>
        <Button type="button" size="sm" variant="ghost" className="h-8 gap-1.5" disabled={busy !== null || refreshing} onClick={() => void loadRegistry(true)}>
          <RefreshCw aria-hidden className={cn('size-3.5', refreshing && 'animate-spin')} />
          {t('providersSettings.acp.refresh')}
        </Button>
      </div>
      {registry?.stale && <p className="m-0 text-xs text-amber-700 dark:text-amber-300">{t('providersSettings.acp.stale')}</p>}
      {registryError && <p className="m-0 text-xs text-destructive" role="alert">{registryError}</p>}
      {!registry && !registryError && <p className="m-0 text-[13px] text-muted-foreground">{t('common.loading')}</p>}
      {registry && registry.agents.length === 0 && <p className="m-0 text-[13px] text-muted-foreground">{t('providersSettings.acp.empty')}</p>}
      {registry && registry.agents.length > 0 && agents.length === 0 && (
        <p className="m-0 text-[13px] text-muted-foreground">{t('providersSettings.acp.noMatch', { query: query.trim() })}</p>
      )}
      {agents.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-0.5 rounded-xl bg-card p-1 shadow-elev-1">
          {agents.map((agent) => (
            <CatalogRow
              key={agent.id}
              agent={agent}
              busy={busy}
              signIn={signIns[agent.id] ?? null}
              onInstall={() => (agent.integrity === 'none' ? setUnverified(agent) : void install(agent, false))}
              onOpen={() => onOpen(catalogProviderId(agent.id))}
              onSignIn={() => void toggleSignIn(agent)}
              onRemove={() => void remove(agent)}
            />
          ))}
        </ul>
      )}

      <Dialog open={unverified !== null} onOpenChange={(open) => { if (!open && busy === null) setUnverified(null); }}>
        <DialogContent className="sm:max-w-lg">
          {unverified && (
            <>
              <DialogHeader>
                <DialogTitle>{t('providersSettings.acp.confirmTitle', { name: unverified.name })}</DialogTitle>
                <DialogDescription>{t('providersSettings.acp.confirmBody')}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="ghost" disabled={busy !== null} onClick={() => setUnverified(null)}>{t('providersSettings.cancel')}</Button>
                <Button variant="destructive" disabled={busy !== null} onClick={() => void install(unverified, true)}>
                  {t('providersSettings.acp.confirmAction')}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function CatalogRow({
  agent, busy, signIn, onInstall, onOpen, onSignIn, onRemove,
}: {
  agent: AcpAgent; busy: string | null; signIn: AcpAuthMethod[] | null;
  onInstall: () => void; onOpen: () => void; onSignIn: () => void; onRemove: () => void;
}): ReactElement {
  const action = acpAction(agent);
  const line = acpStateLine(agent);
  const working = busy === `install:${agent.id}`;
  const asking = busy === `auth:${agent.id}`;
  const runnable = agent.installed !== null && agent.installed.state === 'ok';
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg px-3 py-2.5" data-catalog-agent={agent.id}>
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="m-0 truncate text-[13px] font-medium">{agent.name}</p>
        <TonePill tone={line.tone} className="flex" data-catalog-state={line.key.split('.').pop() ?? ''}>{t(line.key, line.vars)}</TonePill>
        {agent.supported && agent.description ? <p className="m-0 truncate text-[11px] text-muted-foreground">{agent.description}</p> : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1">
        {action !== 'none' && (
          <Button size="sm" className="h-7 gap-1.5 text-xs" disabled={busy !== null} onClick={onInstall}>
            {action === 'verify' ? <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> : <Download className="h-3.5 w-3.5" aria-hidden />}
            {working ? t('providersSettings.acp.installing') : t(`providersSettings.acp.${action}`)}
          </Button>
        )}
        {runnable && (
          <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" disabled={busy !== null} aria-expanded={signIn !== null} onClick={onSignIn}>
            <KeyRound className="h-3.5 w-3.5" aria-hidden />
            {asking
              ? t('providersSettings.acp.signIn.loading', { name: agent.name })
              : t(signIn ? 'providersSettings.acp.signIn.hide' : 'providersSettings.acp.signIn.show')}
          </Button>
        )}
        {agent.installed && (
          <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" disabled={busy !== null} onClick={onRemove}>
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
            {t('providersSettings.acp.remove')}
          </Button>
        )}
        {runnable && (
          <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" disabled={busy !== null} onClick={onOpen}>
            {t('providersSettings.acp.open')}
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          </Button>
        )}
      </div>
      {signIn && <SignInMethods agentName={agent.name} methods={signIn} />}
    </li>
  );
}

/** What the agent said about its sign-in: the suggested method first, and every method billed per token marked. */
function SignInMethods({ agentName, methods }: { agentName: string; methods: AcpAuthMethod[] }): ReactElement {
  if (methods.length === 0) {
    return <p className="m-0 basis-full text-xs text-muted-foreground">{t('providersSettings.acp.signIn.none', { name: agentName })}</p>;
  }
  const anyBilled = methods.some((m) => m.billedPerToken);
  const allBilled = methods.every((m) => m.billedPerToken);
  const copy = (command: string): void => {
    void navigator.clipboard?.writeText(command).then(() => toast.success(t('providersSettings.acp.signIn.copied')), () => undefined);
  };
  return (
    <div className="basis-full space-y-2 pt-1">
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {methods.map((method) => (
          <li key={method.id} className="space-y-1 rounded-md bg-muted/50 px-2.5 py-2 text-xs">
            <p className="m-0 flex flex-wrap items-center gap-2">
              <span className="font-medium">{method.name}</span>
              {method.recommended && (
                <Badge variant="outline" className="gap-1 border-emerald-500/40 text-emerald-800 dark:text-emerald-300">
                  <CheckCircle2 className="h-3 w-3" aria-hidden />{t('providersSettings.acp.signIn.recommended')}
                </Badge>
              )}
              {method.billedPerToken && (
                <Badge variant="outline" className="gap-1 border-amber-500/40 text-amber-800 dark:text-amber-300">
                  <AlertTriangle className="h-3 w-3" aria-hidden />{t('providersSettings.acp.signIn.billed')}
                </Badge>
              )}
            </p>
            {method.description && <p className="m-0 text-muted-foreground">{method.description}</p>}
            {method.recommended && method.command && (
              <div className="space-y-1">
                <p className="m-0 text-muted-foreground">{t('providersSettings.acp.signIn.terminal')}</p>
                <div className="flex items-start gap-2">
                  {/* code-font: a command to copy into a terminal */}
                  <code className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1 font-mono text-[11px]">{method.command}</code>
                  <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-xs" onClick={() => copy(method.command ?? '')}>
                    <Copy className="h-3.5 w-3.5" aria-hidden />{t('providersSettings.acp.signIn.copy')}
                  </Button>
                </div>
              </div>
            )}
            {method.recommended && !method.command && (
              <p className="m-0 text-muted-foreground">{t('providersSettings.acp.signIn.agentStep', { name: agentName })}</p>
            )}
          </li>
        ))}
      </ul>
      {anyBilled && (
        <p className="m-0 text-xs leading-relaxed text-amber-800 dark:text-amber-300">
          {t(allBilled ? 'providersSettings.acp.signIn.allBilled' : 'providersSettings.acp.signIn.billedNote', { name: agentName })}
        </p>
      )}
    </div>
  );
}
