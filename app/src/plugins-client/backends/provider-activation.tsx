'use client';

/**
 * Switching a provider on or off, from its page's header. Not on the list's
 * row: the row is one target that opens the page, and turning a provider off
 * first shows what still uses it — a confirmation that needs the room a page
 * has. Each of the provider's backends is written through the same route as
 * the former list's switch (`PATCH /manage/<id>`).
 */
import { useState, type ReactElement } from 'react';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useProviderPage } from '@/components/provider-page/provider-page-context';
import { t } from '@/lib/i18n';
import type { CustomBackend } from './form';
import { editableBackend } from './providers-reorder';

const MANAGE_API = '/api/ui/backends/manage';
const USAGE_KINDS = ['agents', 'routines', 'tasks'] as const;

type Usages = NonNullable<CustomBackend['usages']>;

async function errorText(res: Response): Promise<string> {
  if (res.status === 403) return t('backendsSettings.errors.forbidden');
  const raw = (await res.text().catch(() => '')).trim();
  try {
    return (JSON.parse(raw) as { error?: string }).error || `HTTP ${res.status}`;
  } catch {
    return raw || `HTTP ${res.status}`;
  }
}

/** What uses any of these backends now, read fresh: the overview does not carry it. */
async function usagesOf(ids: readonly string[]): Promise<{ usages: Usages; writable: boolean }> {
  const res = await fetch(MANAGE_API, { cache: 'no-store' });
  if (!res.ok) throw new Error(await errorText(res));
  const rows = ((await res.json()) as { backends?: CustomBackend[] }).backends?.filter((row) => ids.includes(row.id)) ?? [];
  const usages: Usages = { agents: [], routines: [], tasks: [] };
  for (const row of rows) for (const kind of USAGE_KINDS) usages[kind].push(...(row.usages?.[kind] ?? []));
  return { usages, writable: rows.length > 0 && rows.every(editableBackend) };
}

async function setDisabled(ids: readonly string[], disabled: boolean): Promise<void> {
  for (const id of ids) {
    let res: Response;
    try {
      res = await fetch(`${MANAGE_API}/${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ disabled }),
      });
    } catch { throw new Error(t('backendsSettings.errors.unconfirmed')); }
    if (!res.ok) throw new Error(await errorText(res));
  }
}

export function ProviderActivation(): ReactElement | null {
  const page = useProviderPage();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<Usages | null>(null);
  if (!page || page.provider.backends.length === 0) return null;
  const { provider } = page;
  const ids = provider.backends.map((backend) => backend.id);
  const on = provider.backends.some((backend) => !backend.disabled);
  // A plugin switched off in Settings › Plugins: its backends are not this switch's to turn on.
  const pluginOff = provider.plugin?.state === 'disabled';

  const apply = async (disabled: boolean) => {
    setBusy(true);
    try {
      await setDisabled(ids, disabled);
      setConfirming(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      await page.refresh();
    }
  };

  const toggle = async () => {
    if (!on) { await apply(false); return; }
    setBusy(true);
    try {
      const { usages, writable } = await usagesOf(ids);
      if (!writable) { toast.error(t('providerPage.activation.readOnly')); return; }
      setConfirming(usages);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground" title={pluginOff ? t('providerPage.activation.pluginOff') : undefined}>
        {t(on ? 'providerPage.activation.on' : 'providerPage.activation.off')}
        <Switch checked={on && !pluginOff} disabled={busy || pluginOff} data-provider-activation
          aria-label={t('backendsSettings.toggle', { name: provider.name })} onCheckedChange={() => void toggle()} />
      </label>
      <Dialog open={confirming !== null} onOpenChange={(open) => { if (!open && !busy) setConfirming(null); }}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          {confirming ? <>
            <DialogHeader>
              <DialogTitle className="text-base">{t('backendsSettings.disableTitle', { name: provider.name })}</DialogTitle>
              <DialogDescription className="max-w-2xl text-xs leading-relaxed">{t('backendsSettings.disableHint')}</DialogDescription>
            </DialogHeader>
            {USAGE_KINDS.map((kind) => (confirming[kind].length ? (
              <div key={kind} className="text-[13px]" data-usage={kind}>
                <span className="font-medium">{t(`backendsSettings.usages.${kind}`)}</span>
                <ul className="mt-1 list-inside list-disc">{confirming[kind].map((row) => <li key={row.id}>{row.label}</li>)}</ul>
              </div>
            ) : null))}
            <DialogFooter className="gap-2 sm:gap-0">
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(null)}>{t('common.cancel')}</Button>
              <Button size="sm" disabled={busy} onClick={() => void apply(true)}>{t('backendsSettings.disable')}</Button>
            </DialogFooter>
          </> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
