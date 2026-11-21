'use client';

/**
 * The host's own sign-in of a provider, done in the app (TODO #426): the
 * daemon runs the provider's CLI and this dialog carries its page and its
 * code — the same steps as an added account (`AccountLoginPrompt`), so a
 * beginner never opens a terminal. `login` signs in into Timon's folder,
 * `token` mints a long-lived token. The flow starts when the dialog opens and
 * is cancelled when it closes before the end.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AccountLoginPrompt } from '@/components/settings/backend-accounts-settings';
import { cleanPastedCode, isLoginOver, type AccountLogin } from '@/lib/backend-accounts';
import { cancelHostFlow, readHostFlow, sendHostFlowCode, startHostFlow, type HostFlowKind } from '@/lib/host-sign-in';
import { t } from '@/lib/i18n';

const POLL_MS = 1000;

export function HostSignInDialog({ backend, name, kind, open, onOpenChange, onDone }: {
  /** The backend whose host sign-in this is (`claude`). */
  backend: string;
  /** The provider's name, for the title. */
  name: string;
  kind: HostFlowKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The flow succeeded: the surface reads its state again. */
  onDone: () => void;
}): ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-host-sign-in={kind}>
        <DialogHeader>
          <DialogTitle className="text-base">
            {kind === 'login' ? t('hostSignIn.login.title', { name }) : t('hostSignIn.token.title')}
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            {kind === 'login' ? t('hostSignIn.login.description', { name }) : t('hostSignIn.token.description')}
          </DialogDescription>
        </DialogHeader>
        {open ? <HostFlow backend={backend} name={name} kind={kind} onClose={() => onOpenChange(false)} onDone={onDone} /> : null}
      </DialogContent>
    </Dialog>
  );
}

/** One flow, from its start to its verdict. Leaving it cancels it. */
function HostFlow({ backend, name, kind, onClose, onDone }: {
  backend: string; name: string; kind: HostFlowKind; onClose: () => void; onDone: () => void;
}): ReactElement {
  const [login, setLogin] = useState<AccountLogin | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const latest = useRef<AccountLogin | null>(null);
  latest.current = login;
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = (next: AccountLogin | null) => {
      setLogin(next);
      latest.current = next;
      if (next?.state === 'connected') {
        toast.success(kind === 'login' ? t('hostSignIn.login.done', { name, identity: next.identity ?? '' }) : t('hostSignIn.token.done'));
        done.current();
      }
      if (!isLoginOver(next)) timer = setTimeout(() => void poll(), POLL_MS);
    };
    const poll = async () => {
      try {
        const next = await readHostFlow(backend, kind);
        if (alive) settle(next);
      } catch (error) {
        if (alive) toast.error(error instanceof Error ? error.message : t('backendAccounts.errorGeneric'));
      }
    };
    setLogin(null);
    setCode('');
    startHostFlow(backend, kind)
      .then((started) => {
        // Closed before the daemon answered: the flow exists now, stop it.
        if (!alive) {
          if (!isLoginOver(started)) void cancelHostFlow(backend, kind).catch(() => {});
          return;
        }
        settle(started);
      })
      .catch((error: unknown) => {
        if (alive) toast.error(error instanceof Error ? error.message : t('backendAccounts.errorGeneric'));
      });
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      // A flow left open would hold the CLI until its time runs out.
      if (latest.current && !isLoginOver(latest.current)) void cancelHostFlow(backend, kind).catch(() => {});
    };
  }, [backend, kind, name, attempt]);

  const submit = useCallback(async () => {
    setBusy(true);
    try {
      setLogin(await sendHostFlowCode(backend, kind, cleanPastedCode(code)));
      setCode('');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('backendAccounts.errorGeneric'));
    } finally {
      setBusy(false);
    }
  }, [backend, kind, code]);

  return (
    <div className="space-y-3" data-host-flow-state={login?.state ?? 'starting'}>
      <AccountLoginPrompt
        login={login}
        code={code}
        busy={busy}
        onCode={setCode}
        onSubmit={() => void submit()}
        onRetry={() => setAttempt((n) => n + 1)}
        onClose={onClose}
        signInWith={t('hostSignIn.signInWith', { name })}
        connected={kind === 'token' ? t('hostSignIn.token.done') : t('hostSignIn.login.done', { name, identity: login?.identity ?? '' })}
      />
      {login?.state === 'connected' ? (
        <Button type="button" size="sm" className="h-7 text-[12px]" onClick={onClose}>{t('backendAccounts.login.close')}</Button>
      ) : null}
      {login === null || !isLoginOver(login) ? (
        <Button type="button" size="sm" variant="ghost" className="h-7 text-[12px]" onClick={onClose}>
          {t('backendAccounts.login.cancel')}
        </Button>
      ) : null}
    </div>
  );
}
