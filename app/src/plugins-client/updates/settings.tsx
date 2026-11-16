'use client';

/**
 * Settings › System › Updates, the pane of `@timon/updates`: one row, the
 * version and its state at the left, one action at the right ("Check",
 * "Retry" or "Update"), the rest in its "…" menu — the release notes, the
 * installer to download by hand, the automatic check switched on or off, and
 * the "Announcements" switch (`TIMON_NOTICES_CHECK`), off and locked while the
 * check is off since that stops the feed too, and "Show closed cards again",
 * open to every account since it forgets that account's closings only.
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
  manualInstallerLink, NOTICES_SETTING, noticesSettingValue, noticesSwitchView, releaseNotesUrl, settingLockedBy,
  updateRowView, type UpdateRowStatus,
} from '@/lib/update-settings';
import { checkForUpdatesNow, loadUpdateStatus, useUpdateStore } from '@/lib/updates';
import { resetDismissedNotices } from '@/lib/notices';

const UPDATES_SETTING = 'TIMON_UPDATES_CHECK';
const SETTINGS_URL = '/api/ui/settings';
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

/** The look of `Switch`, drawn inside a menu item: a real switch there would nest a button in a button. */
function SwitchGlyph({ on }: { on: boolean }): ReactElement {
  return (
    <span
      aria-hidden
      data-state={on ? 'checked' : 'unchecked'}
      className="ml-auto inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent shadow-sm transition-colors data-[state=checked]:bg-primary data-[state=unchecked]:bg-foreground/[0.3] dark:data-[state=unchecked]:bg-foreground/[0.22]"
    >
      <span className={`block size-4 rounded-full bg-surface-3 shadow-lg transition-transform ${on ? 'translate-x-4' : 'translate-x-0'}`} />
    </span>
  );
}

export function UpdatesSettings(): ReactElement {
  const store = useUpdateStore();
  const me = useMe();
  const provided = useUpdateDialogProvided();
  const [checkFailed, setCheckFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [notices, setNotices] = useState<boolean | null>(null);
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
  const installer = manualInstallerLink(status, userAgent);

  const loadNotices = useCallback(async () => {
    try {
      const res = await fetch(SETTINGS_URL, { cache: 'no-store' });
      setNotices(res.ok ? noticesSettingValue(await res.json().catch(() => null)) : null);
    } catch {
      setNotices(null);
    }
  }, []);

  // Only an account that may switch it reads the settings: the switch is all this value feeds.
  useEffect(() => {
    if (canWrite) void loadNotices();
  }, [canWrite, loadNotices]);

  const check = useCallback(async () => {
    setCheckFailed(false);
    const answered = await checkForUpdatesNow();
    setNow(Date.now());
    if (!answered) setCheckFailed(true);
  }, []);

  const save = useCallback(async (key: string, enabled: boolean) => {
    setSaving(true);
    try {
      const res = await fetch(SETTINGS_URL, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, value: enabled }),
      });
      if (!res.ok) { toast.error(t('updates.settings.saveFailed')); return; }
      const locked = settingLockedBy(await res.json().catch(() => null));
      if (locked === 'env') toast.error(t('updates.settings.lockedEnv', { key }));
      else if (locked === 'config') toast.error(t('updates.settings.lockedConfig'));
      await (key === NOTICES_SETTING ? loadNotices() : loadUpdateStatus());
    } catch {
      toast.error(t('updates.settings.saveFailed'));
    } finally {
      setSaving(false);
    }
  }, [loadNotices]);

  const showClosedNotices = useCallback(async () => {
    setResetting(true);
    try {
      if (await resetDismissedNotices()) toast.success(t('updates.settings.closedNoticesShown'));
      else toast.error(t('updates.settings.closedNoticesFailed'));
    } finally {
      setResetting(false);
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
        <a href={installer.href} target="_blank" rel="noopener noreferrer" data-update-settings-action="update">
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
  const announcements = noticesSwitchView({ updatesEnabled: enabled, notices });
  const menu = (
    <>
      <DropdownMenuItem asChild>
        <a href={releaseNotesUrl(status)} target="_blank" rel="noopener noreferrer" data-update-settings-notes="">
          {t('updates.settings.notes')}<ExternalLink className="ml-auto size-3" aria-hidden />
        </a>
      </DropdownMenuItem>
      <DropdownMenuItem asChild>
        <a href={installer.href} target="_blank" rel="noopener noreferrer" data-update-settings-download="">
          {t(installer.forThisSystem ? 'updates.settings.download' : 'updates.settings.allInstallers')}<ExternalLink className="ml-auto size-3" aria-hidden />
        </a>
      </DropdownMenuItem>
      <DropdownMenuItem disabled={resetting} onSelect={() => { void showClosedNotices(); }} data-update-settings-show-notices="">
        {t('updates.settings.showClosedNotices')}
      </DropdownMenuItem>
      {canWrite && status && status.state !== 'dev' ? (
        <>
          <DropdownMenuItem disabled={saving} onSelect={() => { void save(UPDATES_SETTING, !enabled); }} data-update-settings-automatic={enabled ? 'on' : 'off'}>
            {t(enabled ? 'updates.settings.automaticOff' : 'updates.settings.automaticOn')}
          </DropdownMenuItem>
          {/* Kept open on select: the switch is seen moving. */}
          <DropdownMenuItem
            role="menuitemcheckbox"
            aria-checked={announcements.on}
            disabled={saving || announcements.disabled}
            onSelect={(event) => { event.preventDefault(); void save(NOTICES_SETTING, !announcements.on); }}
            data-update-settings-notices={announcements.on ? 'on' : 'off'}
          >
            {t('updates.settings.notices')}
            <SwitchGlyph on={announcements.on} />
          </DropdownMenuItem>
        </>
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
