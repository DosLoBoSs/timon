'use client';

/**
 * "Pull requests" — the landing of the Kanban jobs that go through one: one
 * card per job, with its branch, the state of its pull request, the forge's
 * checks and a conflict with the target, and a preview of what the pull
 * request carries before anything is pushed.
 *
 * A widget of `@timon/kanban` (`cockpit.widget`), movable to any zone. In an
 * agent chat's rail it narrows to the conversation's project; elsewhere it
 * lists every job the reader can see.
 *
 * The forge is asked only while the widget is mounted, the page visible, and a
 * check still runs (about once a minute; the daemon answers its stored copy in
 * between). The landing poller keeps its own pace.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleAlert, CircleCheck, CircleDashed, Eye, GitPullRequest, MoreHorizontal, RefreshCw } from 'lucide-react';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Tile } from '@/components/tile';
import { WidgetButton, widgetButtonClass } from '@/components/widget-toolbar';
import { HUD_SURFACE } from '@/components/cockpit/hud-surface';
import { useChatRail } from '@/components/chat/chat-rails';
import type { WidgetProps } from '@/components/widget-host/widget-props';
import { t } from '@/lib/i18n';
import { NativeViewCover } from '@/lib/native-view-cover';
import { cn } from '@/lib/utils';
import {
  CHECKS_REFRESH_MS, landingsToRefresh, listLandings, refreshLandingChecks, type Landing,
} from './landing-api';
import { LandingPreviewDialog } from './landing-preview-dialog';

const BADGE = 'inline-flex h-5 items-center gap-1 rounded-full px-1.5 text-[10.5px] font-medium tabular-nums';

const TONE = {
  neutral: 'bg-foreground/[0.06] text-muted-foreground',
  good: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  bad: 'bg-red-500/15 text-red-700 dark:text-red-300',
  busy: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  info: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
} as const;

function StateBadge({ landing }: { landing: Landing }) {
  if (landing.state === 'open') {
    const label = t('landings.state.open', { number: landing.pr_number ?? 0 });
    return landing.pr_url
      ? <a href={landing.pr_url} target="_blank" rel="noreferrer noopener" className={cn(BADGE, TONE.info, 'hover:underline')}>{label}</a>
      : <span className={cn(BADGE, TONE.info)}>{label}</span>;
  }
  if (landing.state === 'merged') return <span className={cn(BADGE, TONE.good)}>{t(landing.landed ? 'landings.state.landed' : 'landings.state.merged')}</span>;
  if (landing.state === 'closed') return <span className={cn(BADGE, TONE.neutral)}>{t('landings.state.closed')}</span>;
  return <span className={cn(BADGE, TONE.neutral)}>{t('landings.state.branch')}</span>;
}

function ChecksBadges({ landing }: { landing: Landing }) {
  const checks = landing.checks;
  if (!checks || landing.state !== 'open') return null;
  const { pass, fail, pending } = checks.counts;
  return (
    <>
      {fail > 0 && (
        <span className={cn(BADGE, TONE.bad)} title={t('landings.checks.fail', { count: fail })}>
          <CircleAlert className="size-3" aria-hidden />{fail}
        </span>
      )}
      {pending > 0 && (
        <span className={cn(BADGE, TONE.busy)} title={t('landings.checks.pending', { count: pending })}>
          <CircleDashed className="size-3 animate-spin [animation-duration:3s]" aria-hidden />{pending}
        </span>
      )}
      {pass > 0 && (
        <span className={cn(BADGE, TONE.good)} title={t('landings.checks.pass', { count: pass })}>
          <CircleCheck className="size-3" aria-hidden />{pass}
        </span>
      )}
      {checks.draft && <span className={cn(BADGE, TONE.neutral)}>{t('landings.draft')}</span>}
      {checks.review && (
        <span className={cn(BADGE, checks.review === 'approved' ? TONE.good : checks.review === 'changes_requested' ? TONE.bad : TONE.neutral)}>
          {t(`landings.review.${checks.review}`)}
        </span>
      )}
    </>
  );
}

function LandingCard({ landing, onPreview, onRefresh, refreshing }: {
  landing: Landing;
  onPreview: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <li className="flex flex-col gap-1.5 rounded-lg bg-foreground/[0.035] px-2.5 py-2" data-landing={landing.id}>
      <div className="flex min-w-0 items-center gap-2">
        {/* code-font: a branch name */}
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground" title={landing.branch}>{landing.branch}</span>
        <StateBadge landing={landing} />
      </div>
      {landing.pr_title && <p className="truncate text-[11.5px] text-muted-foreground" title={landing.pr_title}>{landing.pr_title}</p>}
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <span className="mr-1 text-[11px] text-muted-foreground">{t('landings.into', { target: `${landing.remote}/${landing.target}` })}</span>
        {landing.conflict === true && <span className={cn(BADGE, TONE.bad)}>{t('landings.conflict')}</span>}
        <ChecksBadges landing={landing} />
        <span className="ml-auto flex items-center gap-0.5">
          <WidgetButton onClick={onPreview} title={t('landings.preview')} aria-label={t('landings.preview')} icon={<Eye className="size-3.5" />} />
          <Dropdown.Root>
            <Dropdown.Trigger asChild>
              <button type="button" title={t('landings.more')} aria-label={t('landings.more')} className={widgetButtonClass({ iconOnly: true })}>
                <MoreHorizontal className="size-3.5" />
              </button>
            </Dropdown.Trigger>
            <Dropdown.Portal>
              <Dropdown.Content sideOffset={6} align="end" className="z-50 min-w-48 rounded-lg border border-border bg-popover p-1 text-xs text-popover-foreground shadow-elev-2">
                <NativeViewCover />
                {landing.pr_url && (
                  <Dropdown.Item asChild className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-accent">
                    <a href={landing.pr_url} target="_blank" rel="noreferrer noopener">
                      <GitPullRequest className="size-3.5" />{t('landings.openPr')}
                    </a>
                  </Dropdown.Item>
                )}
                <Dropdown.Item
                  disabled={landing.state !== 'open' || refreshing}
                  onSelect={onRefresh}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-accent"
                >
                  <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />{t('landings.refresh')}
                </Dropdown.Item>
              </Dropdown.Content>
            </Dropdown.Portal>
          </Dropdown.Root>
        </span>
      </div>
    </li>
  );
}

export function LandingWidget({ handle, className }: WidgetProps) {
  const chat = useChatRail();
  const project = chat?.slug ?? null;
  const [landings, setLandings] = useState<Landing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewed, setPreviewed] = useState<Landing | null>(null);
  const [refreshing, setRefreshing] = useState<ReadonlySet<string>>(new Set());
  const current = useRef<Landing[]>([]);

  const merge = useCallback((fresh: Landing) => {
    setLandings((list) => (list ?? []).map((l) => (l.id === fresh.id ? fresh : l)));
    current.current = current.current.map((l) => (l.id === fresh.id ? fresh : l));
  }, []);

  const refreshChecks = useCallback(async (targets: readonly Landing[]) => {
    for (const landing of targets) {
      setRefreshing((s) => new Set(s).add(landing.id));
      const out = await refreshLandingChecks(landing.id);
      setRefreshing((s) => { const n = new Set(s); n.delete(landing.id); return n; });
      // A forge that does not answer leaves the last copy on the card.
      if (out.ok) merge(out.value);
    }
  }, [merge]);

  const load = useCallback(async () => {
    const out = await listLandings(project);
    if (!out.ok) { setError(out.message); return; }
    setError(null);
    setLandings(out.value);
    current.current = out.value;
    await refreshChecks(landingsToRefresh(out.value));
  }, [project, refreshChecks]);

  useEffect(() => { void load(); }, [load]);

  // Only while a check runs, and the page is in front of someone.
  useEffect(() => {
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      const due = current.current.filter((l) => l.state === 'open' && l.checks_running);
      if (due.length > 0) void refreshChecks(due);
    }, CHECKS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refreshChecks]);

  return (
    <Tile
      title={t('landings.title')}
      subtitle={landings && landings.length > 0 ? landings.length : undefined}
      className={cn(HUD_SURFACE, className)}
      bodyClassName="gap-2 p-2"
      actions={handle}
    >
      {error && <p className="px-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
      {landings === null && !error && <p className="px-1 text-xs text-muted-foreground">{t('landings.loading')}</p>}
      {landings !== null && landings.length === 0 && <p className="px-1 text-xs text-muted-foreground">{t('landings.empty')}</p>}
      {landings !== null && landings.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {landings.map((landing) => (
            <LandingCard
              key={landing.id}
              landing={landing}
              refreshing={refreshing.has(landing.id)}
              onPreview={() => setPreviewed(landing)}
              onRefresh={() => { void refreshChecks([landing]); }}
            />
          ))}
        </ul>
      )}
      {previewed && <LandingPreviewDialog landing={previewed} onClose={() => setPreviewed(null)} />}
    </Tile>
  );
}
