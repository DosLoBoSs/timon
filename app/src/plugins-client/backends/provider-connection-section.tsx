'use client';

/**
 * The Connection section of a provider page (`settings.provider.section`,
 * key `connection`): whether this computer is signed in to the provider, the
 * button that signs it in (the gesture of the provider cards), and the
 * subscription accounts of THIS provider with every gesture of the former
 * "Subscription accounts" tab — add, sign in, rename, assign, delete.
 *
 * Painted only when there is something to say: a sign-in command, a known
 * sign-in state, or backends that take accounts. The order accounts are tried
 * in stays where it is set, Settings › AI models › Auto switch.
 */
import { useState, type ReactElement } from 'react';
import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ProviderSignIn, runSignInCommand } from '@/components/provider-cli/provider-cli-cards';
import { ProviderSection } from '@/components/provider-page/provider-section';
import { useProviderPage } from '@/components/provider-page/provider-page-context';
import { ToneDot } from '@/components/provider-page/provider-status-pill';
import { BackendAccountsList } from '@/components/settings/backend-accounts-settings';
import { fetchProviderClis } from '@/lib/provider-clis';
import type { ProviderOverview } from '@/lib/provider-overview';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/** Whether the section has anything to show for this provider. */
export function hasConnection(provider: Pick<ProviderOverview, 'connection'>): boolean {
  const { connection } = provider;
  return connection.signInCommand !== null || connection.signedIn !== null || connection.acceptsAccounts;
}

export function ConnectionSection(): ReactElement | null {
  const page = useProviderPage();
  const [checking, setChecking] = useState(false);
  if (!page || !hasConnection(page.provider)) return null;
  const { provider } = page;
  const { connection } = provider;

  // Asking the CLIs again refreshes the daemon's sign-in verdicts; the page then reads them.
  const checkAgain = async (): Promise<void> => {
    setChecking(true);
    try {
      await fetchProviderClis().catch(() => null);
      await page.refresh();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setChecking(false);
    }
  };

  const command = connection.signInCommand;
  const known = connection.signedIn;
  return (
    <ProviderSection
      title={t('providerPage.connection.title')}
      description={t('providerPage.connection.description')}
      actions={command !== null || known !== null ? (
        <Button type="button" size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" disabled={checking} onClick={() => void checkAgain()}>
          <RefreshCw className={cn('size-3.5', checking && 'animate-spin')} aria-hidden />
          {t('providerPage.connection.checkAgain')}
        </Button>
      ) : undefined}
    >
      <div className="space-y-5">
        {(command !== null || known !== null) && (
          <div className="space-y-2" data-connection="computer">
            {known !== null && (
              <p className="m-0 inline-flex items-center gap-1.5 text-[13px]" data-signed-in={String(known)}>
                <ToneDot tone={known ? 'ready' : 'action'} />
                {known ? t('providerPage.connection.signedIn') : t('providerPage.connection.signedOut')}
              </p>
            )}
            {command !== null && known !== true && (
              <ProviderSignIn
                command={command}
                then={connection.signInThen}
                label={t('providerPage.connection.connect')}
                onSignIn={() => runSignInCommand(command)}
              />
            )}
          </div>
        )}
        {connection.acceptsAccounts && (
          <div className="space-y-2" data-connection="accounts">
            <div className="space-y-0.5">
              <h5 className="m-0 text-[13px] font-medium">{t('providerPage.connection.accounts.title')}</h5>
              <p className="m-0 max-w-[65ch] text-xs leading-relaxed text-muted-foreground">{t('providerPage.connection.accounts.description')}</p>
            </div>
            <BackendAccountsList backends={provider.backends.map((backend) => backend.id)} onChanged={() => void page.refresh()} />
          </div>
        )}
      </div>
    </ProviderSection>
  );
}
