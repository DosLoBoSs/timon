'use client';

/**
 * The one gesture a provider's row offers for its host sign-in, when Timon can
 * keep it (TODO #426): "Sign in" while nothing is signed in, a long-lived
 * token once a terminal session runs without one, nothing otherwise. Each
 * opens the page-and-code dialog; the rest (go back to the terminal's session,
 * renew, remove) lives on the provider's page.
 */
import { useState, type ReactElement } from 'react';
import { KeyRound, LogIn } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { hostSignInOffer, type HostFlowKind, type HostSignInView } from '@/lib/host-sign-in';
import { t } from '@/lib/i18n';
import { HostSignInDialog } from './host-sign-in-dialog';

export function HostSignInAction({ host, name, onDone }: {
  host: HostSignInView | null | undefined;
  name: string;
  onDone: () => void;
}): ReactElement | null {
  const [open, setOpen] = useState<HostFlowKind | null>(null);
  const offer = hostSignInOffer(host);
  if (!host || (!offer && !open)) return null;
  return (
    <>
      {offer === 'login' ? (
        <Button type="button" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => setOpen('login')} data-host-sign-in-offer="login">
          <LogIn aria-hidden className="size-3.5" />{t('providerClis.signIn')}
        </Button>
      ) : offer === 'token' ? (
        <Button type="button" size="sm" variant="ghost" className="h-7 gap-1.5 text-xs text-muted-foreground"
          onClick={() => setOpen('token')} data-host-sign-in-offer="token" title={t('hostSignIn.token.offerHint')}>
          <KeyRound aria-hidden className="size-3.5" />{t('hostSignIn.token.offer')}
        </Button>
      ) : null}
      <HostSignInDialog backend={host.backend} name={name} kind={open ?? 'login'} open={open !== null}
        onOpenChange={(next) => { if (!next) setOpen(null); }} onDone={onDone} />
    </>
  );
}
