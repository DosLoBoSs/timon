'use client';

/**
 * The long-lived claude token (`claude setup-token`), a section of the Claude
 * provider's page only: the client half of that provider registers it
 * (`plugins-client/provider-claude.tsx`), since the token is its own setting.
 * Write-only like the vault: the daemon never sends the value back, so the
 * field is always empty and only says whether a token is stored.
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ProviderSection } from '@/components/provider-page/provider-section';
import { ToneDot } from '@/components/provider-page/provider-status-pill';
import type { StatusTone } from '@/lib/provider-overview';
import { t } from '@/lib/i18n';
import { apiErrorMessage } from '@/lib/api-error';

const API = '/api/ui/backends/claude-token';

export type ClaudeTokenState = { configured: boolean; readable: boolean; serviceOutsideSession: boolean };

/** Which status line to show; exported for the test. */
export function claudeTokenStateKey(state: ClaudeTokenState): string {
  if (!state.configured) return 'backendsSettings.claudeToken.none';
  return state.readable ? 'backendsSettings.claudeToken.set' : 'backendsSettings.claudeToken.unreadable';
}

/** Its pastille: stored and readable is ready, unreadable is blocked, missing asks for action only where missions need it. */
export function claudeTokenTone(state: ClaudeTokenState): StatusTone {
  if (state.configured) return state.readable ? 'ready' : 'blocked';
  return state.serviceOutsideSession ? 'action' : 'off';
}

async function errorOf(res: Response): Promise<string> {
  if (res.status === 403 || res.status === 401) return t('backendsSettings.errors.forbidden');
  const body = await res.json().catch(() => null) as { error?: string } | null;
  return apiErrorMessage(body, { status: res.status });
}

export function ClaudeTokenPanel(): ReactElement | null {
  const [state, setState] = useState<ClaudeTokenState | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(API, { cache: 'no-store' }).catch(() => null);
    if (res?.ok) setState(await res.json() as ClaudeTokenState);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function send(method: 'PUT' | 'DELETE') {
    setBusy(true);
    try {
      const res = await fetch(API, {
        method, cache: 'no-store',
        ...(method === 'PUT' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: value }) } : {}),
      });
      if (!res.ok) throw new Error(await errorOf(res));
      setState(await res.json() as ClaudeTokenState);
      setValue('');
      toast.success(t(method === 'PUT' ? 'backendsSettings.claudeToken.saved' : 'backendsSettings.claudeToken.cleared'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Not a superadmin, or an older daemon: nothing to offer.
  if (!state) return null;
  return (
    <ProviderSection title={t('backendsSettings.claudeToken.title')} description={t('backendsSettings.claudeToken.hint')}>
      <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (value.trim()) void send('PUT'); }}>
        <p className="m-0 flex items-center gap-1.5 text-xs text-muted-foreground" data-claude-token={claudeTokenTone(state)}>
          <ToneDot tone={claudeTokenTone(state)} />
          {t(claudeTokenStateKey(state))}
        </p>
        {state.serviceOutsideSession && !state.readable ? (
          <p className="m-0 flex items-start gap-1.5 text-xs text-destructive">
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>{t('backendsSettings.claudeToken.required')}</span>
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="claude-token" type="password" autoComplete="off" spellCheck={false} className="h-8 max-w-sm flex-1 text-[13px] md:text-[13px]"
            aria-label={t('backendsSettings.claudeToken.title')}
            value={value} placeholder="sk-ant-oat01-…" onChange={(e) => setValue(e.target.value)}
          />
          <Button type="submit" size="sm" disabled={busy || !value.trim()}>{t('backendsSettings.save')}</Button>
          {state.configured ? (
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void send('DELETE')}>
              {t('backendsSettings.claudeToken.clear')}
            </Button>
          ) : null}
        </div>
      </form>
    </ProviderSection>
  );
}
