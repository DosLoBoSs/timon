'use client';

/**
 * The provider cards in the onboarding (`mode: 'onboarding'`): each AI CLI is
 * the providers list's own row (`ProviderRow`, slot `providers.row`) — logo,
 * name, one status line — with ONE gesture at its end. A CLI not on the
 * machine gets "Install and sign in": the vendor's installer runs, and its
 * sign-in starts by itself once the daemon finds the new program. Nothing
 * else: no path, no authorization, no token, no version. Only a gesture that
 * did not go through (an install that failed, a command Timon could not copy)
 * opens a line under its row, with what to run by hand.
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { ExternalLink, Loader2, LogIn, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CommandToRun } from '@/components/command-to-run';
import { ProviderRow } from '@/components/provider-list/provider-row';
import { onboardingProvider, providerCliState, type InstallJob, type ProviderCli } from '@/lib/provider-clis';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useProviderCliCards, type ProviderCliSignInOutcome } from './provider-cli-context';

/** Rows drawn while the daemon looks: the list's length is not known yet. */
const SEARCH_ROWS = 3;

type Outcomes = Readonly<Record<string, ProviderCliSignInOutcome>>;

export function ProviderCliRows(): ReactElement | null {
  const host = useProviderCliCards();
  // A sign-in happens in a terminal and a browser: coming back to this window is the moment to look again.
  const [awaiting, setAwaiting] = useState(false);
  const [outcomes, setOutcomes] = useState<Outcomes>({});
  // The CLIs whose install was started with "Install and sign in": their sign-in follows the install.
  const [chained, setChained] = useState<ReadonlySet<string>>(() => new Set());
  const refresh = host?.refresh;
  const hostSignIn = host?.signIn;
  const hostInstall = host?.install;

  useEffect(() => {
    if (!awaiting || !refresh) return;
    const again = (): void => {
      if (document.visibilityState === 'hidden') return;
      void refresh();
    };
    window.addEventListener('focus', again);
    document.addEventListener('visibilitychange', again);
    return () => {
      window.removeEventListener('focus', again);
      document.removeEventListener('visibilitychange', again);
    };
  }, [awaiting, refresh]);

  const signIn = useCallback((name: string): void => {
    if (!hostSignIn) return;
    setAwaiting(true);
    void hostSignIn(name).then((outcome) => setOutcomes((prev) => ({ ...prev, [name]: outcome })));
  }, [hostSignIn]);

  const installThenSignIn = useCallback(async (name: string): Promise<void> => {
    if (!hostInstall) return;
    await hostInstall(name);
    // Marked once the new job is in the host: an earlier failed job must not end the chain at once.
    setChained((prev) => new Set(prev).add(name));
  }, [hostInstall]);

  const backends = host?.backends ?? null;
  const jobs = host?.jobs;
  useEffect(() => {
    if (!backends || !jobs || chained.size === 0) return;
    const done: string[] = [];
    for (const name of chained) {
      const job = jobs[name];
      if (job?.state === 'running') continue;
      if (job?.state === 'failed') { done.push(name); continue; }
      const cli = backends.find((entry) => entry.name === name);
      // The installer ended; the list is read again just after: wait until it shows the program.
      if (!cli?.path) continue;
      done.push(name);
      if (providerCliState(cli) !== 'ready') signIn(name);
    }
    if (done.length > 0) {
      setChained((prev) => {
        const next = new Set(prev);
        for (const name of done) next.delete(name);
        return next;
      });
    }
  }, [backends, jobs, chained, signIn]);

  if (!host) return null;
  if (host.unavailable) return <p className="text-center text-sm text-muted-foreground">{t('providerClis.unavailable')}</p>;
  return (
    <div className="flex w-full min-h-0 flex-col items-center gap-2">
      <div className="w-full min-h-0 overflow-y-auto rounded-2xl bg-card p-1.5 text-left shadow-elev-2" data-provider-rows>
        {host.backends
          ? host.backends.map((cli) => (
            <OnboardingProviderRow
              key={cli.name}
              cli={cli}
              job={host.jobs[cli.name] ?? null}
              chained={chained.has(cli.name)}
              outcome={outcomes[cli.name] ?? null}
              onInstall={() => void installThenSignIn(cli.name)}
              onSignIn={() => signIn(cli.name)}
            />
          ))
          : Array.from({ length: SEARCH_ROWS }, (_, i) => <SearchRow key={i} />)}
      </div>
      {host.backends && (
        <Button type="button" size="sm" variant="ghost" className="h-7 gap-1.5 text-xs text-muted-foreground" disabled={host.busy || host.disabled} onClick={() => void host.refresh()}>
          <RefreshCw className={cn('size-3.5', host.busy && 'animate-spin')} aria-hidden />
          {t('providerClis.retry')}
        </Button>
      )}
    </div>
  );
}

function SearchRow(): ReactElement {
  return (
    <div className="flex items-center gap-3 rounded-xl p-2.5" aria-hidden>
      <span className="size-8 shrink-0 animate-pulse rounded-lg bg-muted" />
      <span className="h-2.5 w-28 animate-pulse rounded-full bg-muted" />
      <span className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-full bg-muted px-3 text-xs font-medium text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />{t('providerClis.rows.searching')}
      </span>
    </div>
  );
}

function OnboardingProviderRow({ cli, job, chained, outcome, onInstall, onSignIn }: {
  cli: ProviderCli;
  job: InstallJob | null;
  /** Its sign-in starts once the install ends. */
  chained: boolean;
  outcome: ProviderCliSignInOutcome | null;
  onInstall: () => void;
  onSignIn: () => void;
}): ReactElement {
  const host = useProviderCliCards();
  const state = providerCliState(cli);
  const running = job?.state === 'running';
  const failed = job?.state === 'failed' ? job : null;
  const canInstall = cli.installable && !cli.unsupportedVersion && state === 'missing';
  const blocked = !host || host.disabled || running;
  const manual = failed?.result?.command ?? cli.installCommand;
  const signingIn = state === 'signIn' || state === 'bundled';

  let action: ReactElement | null = null;
  if (running || (chained && state === 'missing')) {
    action = (
      <span role="status" className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full bg-muted px-3 text-xs font-medium text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />{t('providerClis.installing')}
      </span>
    );
  } else if (signingIn) {
    action = (
      <Button type="button" size="sm" variant="secondary" className="gap-1.5" disabled={blocked} onClick={onSignIn}>
        <LogIn className="size-3.5" aria-hidden />{t('providerClis.signIn')}
      </Button>
    );
  } else if (canInstall) {
    action = (
      <Button type="button" size="sm" variant="secondary" disabled={blocked} onClick={onInstall}>
        {t('providerClis.rows.installAndSignIn')}
      </Button>
    );
  } else if (state === 'missing' && cli.installDocs) {
    action = (
      <a href={cli.installDocs} target="_blank" rel="noreferrer noopener" className="inline-flex h-8 items-center gap-1 whitespace-nowrap rounded-md bg-secondary px-3 text-xs font-medium text-secondary-foreground hover:bg-secondary/80">
        {t('providerClis.install')}<ExternalLink className="size-3" aria-hidden />
      </a>
    );
  }

  return (
    <section aria-label={cli.label} data-state={running ? 'installing' : state} className="rounded-xl transition-colors hover:bg-muted/50">
      <ProviderRow provider={onboardingProvider(cli)} mode="onboarding" action={action} />
      {cli.unsupportedVersion && (
        <p className="pb-2 pl-[52px] pr-2 text-xs text-amber-700 dark:text-amber-300">{t('providerClis.unsupportedVersion', { name: cli.label, version: cli.version ?? '' })}</p>
      )}
      {failed && (
        <div className="space-y-1 pb-2 pl-[52px] pr-2">
          <p role="alert" className="whitespace-pre-wrap break-words text-xs text-destructive">{failed.result?.reason ?? t('providerClis.failed')}</p>
          {manual && <CommandToRun command={manual} label={t('providerClis.manual')} />}
        </div>
      )}
      {outcome && signingIn && (
        <div className="space-y-1 pb-2 pl-[52px] pr-2">
          <p role="status" className="text-xs text-muted-foreground">
            {t(`providerClis.rows.signInOutcome.${outcome}`)}
            {cli.signInThen && outcome !== 'failed' ? ` ${t('providerClis.signInThen', { command: cli.signInThen })}` : null}
          </p>
          {/* Shown only when Timon could not hand the command over: the person runs it by hand. */}
          {outcome === 'failed' && (
            <CommandToRun command={cli.signInCommand} label={cli.signInThen ? t('providerClis.signInThen', { command: cli.signInThen }) : t('providerClis.rows.signInCommand')} />
          )}
        </div>
      )}
    </section>
  );
}
