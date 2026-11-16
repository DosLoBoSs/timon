'use client';

/**
 * Settings › System › Updates, the pane of `@timon/updates`: one row, the
 * version and its state at the left, one action at the right ("Check",
 * "Retry" or "Update"), the rest in its "…" menu — the release notes, the
 * installer to download by hand, and the automatic check switched on or off.
 *
 * "Update" goes through `openUpdateDialog()`, the same door as the update
 * card; while nothing provides it, the row links the installer instead.
 * Checking and switching need `settings:write`: without it the row shows the
 * state and offers "Update" alone.
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { ArrowUpCircle, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { ProviderSection, ProviderSettingRow } from '@/components/provider-page/provider-section';
import { useMe } from '@/hooks/use-me';
import { formatRelativeTime } from '@/lib/intl';
import { t } from '@/lib/i18n';
import { openUpdateDialog, useUpdateDialogProvided } from '@/lib/update-open';
import {
  manualInstallerUrl, releaseNotesUrl, settingLockedBy, updateRowView, type UpdateRowStatus,
} from '@/lib/update-settings';
import { checkForUpdatesNow, loadUpdateStatus, useUpdateStore } from '@/lib/updates';

const UPDATES_SETTING = 'TIMON_UPDATES_CHECK';
/** "checked 2 h ago" moves on while the pane stays open. */
const CLOCK_MS = 60_000;

function statusText(status: UpdateRowStatus, now: number): string {
  const ago = (iso: string | null): string | null => (iso ? formatRelativeTime(iso, now) : null);
  switch (status.kind) {
    case 'upToDate': {
      const when = ago(status.checkedAt);
      return when ? t('updates.settings.status.upToDateAt', { ago: when }) : t('updates.settings.status.upToDate');
    }
    case 'available': {
      const when = ago(status.checkedAt);
      return when
        ? t('updates.settings.status.installedAt', { installed: status.installed, ago: when })
        : t('updates.settings.status.installed', { installed: status.installed });
    }
    case 'unchecked': return t('updates.settings.status.unchecked');
    case 'checking': return t('updates.settings.status.checking');
    case 'failed': return t('updates.settings.status.failed');
    case 'off': return t('updates.settings.status.off');
    case 'dev': return t('updates.settings.status.dev');
    case 'unknown': return t('updates.settings.status.unknown');
  }
}

export function UpdatesSettings(): ReactElement {
  const store = useUpdateStore();
  const me = useMe();
  const provided = useUpdateDialogProvided();
  const [checkFailed, setCheckFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()); }, CLOCK_MS);
    return () => { clearInterval(timer); };
  }, []);

  // A daemon too old to say is yes, as `meCan` reads it: its route refuses for itself.
  const canWrite = me !== null && (me.can === null || me.can['settings:write'] !== false);
  const { status } = store;
  const view = updateRowView({ status, checking: store.checking, checkFailed, canWrite });
  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const installerUrl = manualInstallerUrl(status, userAgent);

  const check = useCallback(async () => {
    setCheckFailed(false);
    const answered = await checkForUpdatesNow();
    setNow(Date.now());
    if (!answered) setCheckFailed(true);
  }, []);

  const setAutomatic = useCallback(async (enabled: boolean) => {
    setSaving(true);
    try {
      const res = await fetch('/api/ui/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: UPDATES_SETTING, value: enabled }),
      });
      if (!res.ok) { toast.error(t('updates.settings.saveFailed')); return; }
      const locked = settingLockedBy(await res.json().catch(() => null));
      if (locked) toast.error(t(locked === 'env' ? 'updates.settings.lockedEnv' : 'updates.settings.lockedConfig'));
      await loadUpdateStatus();
    } catch {
      toast.error(t('updates.settings.saveFailed'));
    } finally {
      setSaving(false);
    }
  }, []);

  const title = view.version
    ? t(view.available ? 'updates.settings.titleAvailable' : 'updates.settings.title', { version: view.version })
    : t('updates.settings.titleUnknown');

  let action: ReactElement | null = null;
  if (view.action === 'update') {
    action = provided ? (
      <Button type="button" size="sm" className="h-8 gap-1.5" onClick={() => { openUpdateDialog(); }} data-update-settings-action="update">
        <ArrowUpCircle className="size-3.5" aria-hidden />
        {t('updates.settings.update')}
      </Button>
    ) : (
      <Button asChild size="sm" className="h-8 gap-1.5">
        <a href={installerUrl} target="_blank" rel="noopener noreferrer" data-update-settings-action="update">
          <ArrowUpCircle className="size-3.5" aria-hidden />
          {t('updates.settings.update')}
        </a>
      </Button>
    );
  } else if (view.action === 'check' || view.action === 'retry' || view.action === 'checking') {
    const busy = view.action === 'checking';
    action = (
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-8 gap-1.5"
        disabled={busy}
        onClick={() => { void check(); }}
        data-update-settings-action={view.action}
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <RefreshCw className="size-3.5" aria-hidden />}
        {t(`updates.settings.${view.action}`)}
      </Button>
    );
  }

  const enabled = status?.enabled ?? true;
  const menu = (
    <>
      <DropdownMenuItem asChild>
        <a href={releaseNotesUrl(status)} target="_blank" rel="noopener noreferrer" data-update-settings-notes="">
          {t('updates.settings.notes')}<ExternalLink className="ml-auto size-3" aria-hidden />
        </a>
      </DropdownMenuItem>
      <DropdownMenuItem asChild>
        <a href={installerUrl} target="_blank" rel="noopener noreferrer" data-update-settings-download="">
          {t('updates.settings.download')}<ExternalLink className="ml-auto size-3" aria-hidden />
        </a>
      </DropdownMenuItem>
      {canWrite && status && status.state !== 'dev' ? (
        <DropdownMenuItem disabled={saving} onSelect={() => { void setAutomatic(!enabled); }} data-update-settings-automatic={enabled ? 'on' : 'off'}>
          {t(enabled ? 'updates.settings.automaticOff' : 'updates.settings.automaticOn')}
        </DropdownMenuItem>
      ) : null}
    </>
  );

  return (
    <div className="max-w-2xl">
      <ProviderSection title={t('updates.settings.section')}>
        <ProviderSettingRow
          data-update-settings={view.status.kind}
          title={title}
          status={<span role="status">{statusText(view.status, now)}</span>}
          action={action}
          menu={menu}
          menuLabel={t('updates.settings.more')}
        />
      </ProviderSection>
    </div>
  );
}
