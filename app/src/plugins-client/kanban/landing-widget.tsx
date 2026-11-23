'use client';

/**
 * "Jobs" — the Kanban jobs that land through a pull request, in four groups:
 * what needs a gesture (a check fails, a conflict, changes asked, a pull
 * request closed without its merge), what waits on review, what is not pushed
 * yet, and what landed this week. Groups, not columns: the widget lives in a
 * 300 px rail.
 *
 * One row per job: its title and where it stands, ONE action in an icon (the
 * repair the forge calls for — fix the checks, address the comments, resolve
 * the conflict — while one may start, else the preview while there is
 * something to land, the pull request once merged), the rest in "…". A repair
 * starts only on that click, three at most per job (`landing-repair.tsx`). A widget of `@timon/kanban`, stacked by default in the
 * chat's "Git" stack. In a chat's rail it narrows to the conversation's
 * project; elsewhere the project is picked once for the stack
 * (`git-stack-project.tsx`), all of them when none is.
 *
 * The forge is asked only while the widget is mounted (in the Git stack, also
 * behind another tab, for the count on its own), the page visible, and a
 * check still runs (about once a minute; the daemon answers its stored copy in
 * between). The landing poller keeps its own pace.
 *
 * The list follows the daemon's `integration_changed` (`landing-events.ts`):
 * a job that moves is read again at once, a burst of changes in one read.
 * A slow poll stays behind it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, CircleCheck, CircleDashed, ExternalLink, Eye, GitPullRequest, LoaderCircle, MoreHorizontal, RefreshCw } from 'lucide-react';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Tile } from '@/components/tile';
import { WidgetButton, widgetButtonClass } from '@/components/widget-toolbar';
import { HUD_SURFACE } from '@/components/cockpit/hud-surface';
import type { WidgetProps } from '@/components/widget-host/widget-props';
import { useWidgetAttention, useWidgetCount, useWidgetInFront, useWidgetMenu } from '@/components/widget-host/widget-self';
import { t } from '@/lib/i18n';
import { NativeViewCover } from '@/lib/native-view-cover';
import { cn } from '@/lib/utils';
import {
  canRepair, CHECKS_REFRESH_MS, groupLandings, landingAction, landingsToRefresh, listLandings, mainRepair,
  refreshLandingChecks, repairsNeeded, type Landing, type LandingGroup, type RepairKind,
} from './landing-api';
import { askRepair, RepairChip, RepairIcon, repairLabel } from './landing-repair';
import { JobDialog } from './job-dialog';
import { JobLinksMenuItems } from './job-links-menu';
import { useTodoOpener } from './todo-opener';
import { proposalsForLanding, waitingCount, type ForgeProposal } from './forge-proposals-api';
import { ProposalChip } from './proposal-chip';
import { PublishDialog } from './publish-dialog';
import { useForgeProposals } from './use-forge-proposals';
import { StackProjectPicker, useStackProject } from './git-stack-project';
import { inProject, useLandingChanges, useLandingFallbackPoll } from './landing-events';
import { landsLocally, LocalLandingEmpty, useProjectIntegration } from './local-landing';

const BADGE = 'inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 text-[10.5px] font-medium tabular-nums';

const TONE = {
  neutral: 'bg-foreground/[0.06] text-muted-foreground',
  good: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  bad: 'bg-red-500/15 text-red-700 dark:text-red-300',
  busy: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  info: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
} as const;

const MENU_ITEM = 'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-accent';

/** Where the job stands on the forge, as one chip. */
function StateBadge({ landing }: { landing: Landing }) {
  if (landing.state === 'open') return <span className={cn(BADGE, TONE.neutral)}>{t('landings.state.open', { number: landing.pr_number ?? 0 })}</span>;
  if (landing.state === 'merged') return <span className={cn(BADGE, TONE.good)}>{t(landing.landed ? 'landings.state.landed' : 'landings.state.merged')}</span>;
  if (landing.state === 'closed') return <span className={cn(BADGE, TONE.bad)}>{t('landings.state.closed')}</span>;
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
      {pass > 0 && fail === 0 && (
        <span className={cn(BADGE, TONE.good)} title={t('landings.checks.pass', { count: pass })}>
          <CircleCheck className="size-3" aria-hidden />{pass}
        </span>
      )}
      {checks.draft && <span className={cn(BADGE, TONE.neutral)}>{t('landings.draft')}</span>}
      {checks.review && checks.review !== 'review_required' && (
        <span className={cn(BADGE, checks.review === 'approved' ? TONE.good : TONE.busy)}>
          {t(`landings.review.${checks.review}`)}
        </span>
      )}
    </>
  );
}

function openPr(landing: Landing) {
  if (landing.pr_url) window.open(landing.pr_url, '_blank', 'noopener,noreferrer');
}

function MainAction({ landing, repairing, onPreview, onRepair }: {
  landing: Landing;
  repairing: boolean;
  onPreview: () => void;
  onRepair: (kind: RepairKind) => void;
}) {
  const action = landingAction(landing);
  const kind = mainRepair(landing);
  if (action === 'repair' && kind) {
    const label = repairLabel(kind);
    return (
      <WidgetButton
        data-landing-action="repair"
        data-repair-kind={kind}
        onClick={() => onRepair(kind)}
        disabled={repairing}
        aria-busy={repairing || undefined}
        title={label}
        aria-label={label}
        icon={repairing ? <LoaderCircle className="size-3.5 animate-spin" /> : <RepairIcon kind={kind} />}
      />
    );
  }
  const label = action === 'openPr' ? t('landings.openPr') : t('landings.preview');
  return (
    <WidgetButton
      data-landing-action={action}
      onClick={action === 'openPr' ? () => openPr(landing) : onPreview}
      title={label}
      aria-label={label}
      icon={action === 'openPr' ? <ExternalLink className="size-3.5" /> : <Eye className="size-3.5" />}
    />
  );
}

function LandingRow({ landing, proposals, onPreview, onRefresh, onRepair, onOpenTodo, onOpenProposal, refreshing, repairing }: {
  landing: Landing;
  proposals: readonly ForgeProposal[];
  onPreview: () => void;
  onRefresh: () => void;
  onRepair: (kind: RepairKind) => void;
  onOpenTodo: (id: number) => void;
  onOpenProposal: (proposal: ForgeProposal) => void;
  refreshing: boolean;
  repairing: boolean;
}) {
  // The pull request's title says what the job is; until there is one, its
  // branch is all there is, and the meta line does not repeat it.
  const title = landing.pr_title || landing.branch;
  const action = landingAction(landing);
  const main = mainRepair(landing);
  // The other repairs the forge calls for; all of them, greyed, while one
  // runs or none is left, so the menu still says what is wrong.
  const otherRepairs = repairsNeeded(landing).filter((k) => k !== main);
  const repairOpen = canRepair(landing) && !repairing;
  return (
    <li data-landing={landing.id} className="flex items-center gap-1 rounded-lg bg-muted/30 py-2 pl-2.5 pr-1 transition-colors hover:bg-muted/50">
      <div className="min-w-0 flex-1">
        <div className="line-clamp-2 break-words text-[12.5px] font-medium leading-snug text-foreground" title={title}>{title}</div>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
          {landing.pr_title && <span className="min-w-0 max-w-full truncate" title={landing.branch}>{landing.branch}</span>}
          <StateBadge landing={landing} />
          {landing.conflict === true && <span className={cn(BADGE, TONE.busy)}>{t('landings.conflict')}</span>}
          <ChecksBadges landing={landing} />
          <RepairChip landing={landing} />
          <ProposalChip proposals={proposals} onOpen={onOpenProposal} />
        </div>
      </div>
      {/* Icon only: the row's width belongs to the job, not to its action. */}
      <MainAction landing={landing} repairing={repairing} onPreview={onPreview} onRepair={onRepair} />
      <Dropdown.Root modal={false}>
        <Dropdown.Trigger asChild>
          <button type="button" title={t('landings.more')} aria-label={t('landings.more')} className={widgetButtonClass({ iconOnly: true })}>
            <MoreHorizontal className="size-3.5" />
          </button>
        </Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content sideOffset={6} align="end" className="z-50 min-w-48 rounded-lg border border-border bg-popover p-1 text-xs text-popover-foreground shadow-elev-2">
            <NativeViewCover />
            {otherRepairs.map((kind) => (
              <Dropdown.Item key={kind} data-repair-menu={kind} disabled={!repairOpen} onSelect={() => onRepair(kind)} className={MENU_ITEM}>
                <RepairIcon kind={kind} />{repairLabel(kind)}
              </Dropdown.Item>
            ))}
            {action !== 'preview' && (
              <Dropdown.Item onSelect={onPreview} className={MENU_ITEM}>
                <Eye className="size-3.5" />{t('landings.preview')}
              </Dropdown.Item>
            )}
            {landing.pr_url && action !== 'openPr' && (
              <Dropdown.Item onSelect={() => openPr(landing)} className={MENU_ITEM}>
                <GitPullRequest className="size-3.5" />{t('landings.openPr')}
              </Dropdown.Item>
            )}
            <JobLinksMenuItems links={landing.links} onOpenTodo={onOpenTodo} itemClassName={MENU_ITEM} />
            <Dropdown.Item disabled={landing.state !== 'open' || refreshing} onSelect={onRefresh} className={MENU_ITEM}>
              <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />{t('landings.refresh')}
            </Dropdown.Item>
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>
    </li>
  );
}

function GroupTitle({ group, count }: { group: LandingGroup; count: number }) {
  return (
    <h3 data-landing-group={group} className="flex items-center gap-1.5 px-1 pb-0.5 pt-1.5 text-[11px] font-medium text-muted-foreground">
      {t(`landings.groups.${group}`)}
      <span className="tabular-nums opacity-70">{count}</span>
    </h3>
  );
}

export function LandingWidget({ handle, className }: WidgetProps) {
  const stack = useStackProject();
  const project = stack.slug;
  const [landings, setLandings] = useState<Landing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewed, setPreviewed] = useState<Landing | null>(null);
  const [refreshing, setRefreshing] = useState<ReadonlySet<string>>(new Set());
  const [repairing, setRepairing] = useState<ReadonlySet<string>>(new Set());
  const current = useRef<Landing[]>([]);
  const { openTodo, todoModal } = useTodoOpener();
  const [publishing, setPublishing] = useState<ForgeProposal | null>(null);
  const integration = useProjectIntegration(project);

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

  const repair = useCallback(async (landing: Landing, kind: RepairKind) => {
    setRepairing((s) => new Set(s).add(landing.id));
    const fresh = await askRepair(landing, kind);
    setRepairing((s) => { const n = new Set(s); n.delete(landing.id); return n; });
    if (fresh) merge(fresh);
  }, [merge]);

  // Only the latest answer lands: a change announced during a slower read
  // must not be overwritten by that read's older list.
  const lastRead = useRef(0);
  const readList = useCallback(async (): Promise<Landing[] | null> => {
    const read = ++lastRead.current;
    const out = await listLandings(project);
    if (read !== lastRead.current) return null;
    if (!out.ok) { setError(out.message); return null; }
    setError(null);
    setLandings(out.value);
    current.current = out.value;
    return out.value;
  }, [project]);

  const load = useCallback(async () => {
    const list = await readList();
    if (list) await refreshChecks(landingsToRefresh(list));
  }, [readList, refreshChecks]);

  useEffect(() => { void load(); }, [load]);

  // A change the daemon announced: the list again, and the forge only for a
  // pull request it has never read (just opened). The checks it announces
  // are already in the list: asking for them again would only echo.
  useLandingChanges(() => {
    void readList().then((list) => {
      if (list) void refreshChecks(list.filter((l) => l.state === 'open' && l.checks === null));
    });
  }, inProject(project), project);
  useLandingFallbackPoll(() => { void load(); });

  // Only while a check runs, and the page is in front of someone.
  useEffect(() => {
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      const due = current.current.filter((l) => l.state === 'open' && l.checks_running);
      if (due.length > 0) void refreshChecks(due);
    }, CHECKS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refreshChecks]);

  const closePreview = useCallback(() => setPreviewed(null), []);
  // The proposals of the projects on screen: the one picked, else every job's.
  const proposalProjects = useMemo(
    () => (project ? [project] : (landings ?? []).map((l) => l.project).filter((p): p is string => !!p)),
    [project, landings],
  );
  const proposals = useForgeProposals(proposalProjects);
  const groups = landings ? groupLandings(landings, Date.now()) : [];
  const shown = groups.reduce((n, g) => n + g.landings.length, 0);
  // In the Git stack the count sits on the tab ("Jobs 4") and the reload
  // button in the widget's menu: alone in the header, it kept a line. The
  // list also reloads each time its tab comes to the front.
  const countOnTab = useWidgetCount(landings === null ? null : shown);
  // Counted on the rows shown: the dot on the tab never points at a row out of sight.
  const waiting = waitingCount(groups.flatMap((g) => g.landings.map((landing) => proposalsForLanding(proposals.pending, landing))));
  useWidgetAttention(waiting > 0 ? t('forgePublish.tabWaiting', { count: waiting }) : null);
  const reloadInMenu = useWidgetMenu(useMemo(() => [{
    key: 'reload', label: t('landings.reload'), icon: <RefreshCw className="size-3.5" />, onSelect: () => { void load(); },
  }], [load]));
  const inFront = useWidgetInFront();
  const wasInFront = useRef(inFront);
  useEffect(() => {
    if (inFront && !wasInFront.current) void load();
    wasInFront.current = inFront;
  }, [inFront, load]);

  return (
    <Tile
      title={t('landings.title')}
      subtitle={shown > 0 && !countOnTab ? shown : undefined}
      className={cn(HUD_SURFACE, className)}
      bodyClassName="px-1.5 pb-3 pt-1"
      actions={(
        <>
          <StackProjectPicker project={stack} none={t('landings.allProjects')} label={t('landings.selectProject')} />
          {!reloadInMenu && <WidgetButton onClick={() => { void load(); }} title={t('landings.reload')} aria-label={t('landings.reload')} icon={<RefreshCw className="size-3.5" />} />}
          {handle}
        </>
      )}
    >
      {error && <p className="px-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
      {landings === null && !error && <p className="px-1 text-xs text-muted-foreground">{t('landings.loading')}</p>}
      {landings !== null && shown === 0 && (project && landsLocally(integration)
        ? <LocalLandingEmpty project={project} read={integration} />
        : <p className="px-1 text-xs text-muted-foreground">{t('landings.empty')}</p>)}
      {groups.map(({ group, landings: members }) => (
        <section key={group} className="flex flex-col gap-1" aria-label={t(`landings.groups.${group}`)}>
          <GroupTitle group={group} count={members.length} />
          <ul className="flex flex-col gap-1">
            {members.map((landing) => (
              <LandingRow
                key={landing.id}
                landing={landing}
                refreshing={refreshing.has(landing.id)}
                repairing={repairing.has(landing.id)}
                onPreview={() => setPreviewed(landing)}
                onRefresh={() => { void refreshChecks([landing]); }}
                onRepair={(kind) => { void repair(landing, kind); }}
                onOpenTodo={openTodo}
                proposals={proposalsForLanding(proposals.pending, landing)}
                onOpenProposal={setPublishing}
              />
            ))}
          </ul>
        </section>
      ))}
      {previewed && <JobDialog landing={previewed} onClose={closePreview} openTodo={openTodo} onChange={merge} />}
      {todoModal}
      {publishing && (
        <PublishDialog
          key={publishing.id}
          project={publishing.project}
          proposal={publishing}
          onClose={() => setPublishing(null)}
          onChange={proposals.reload}
        />
      )}
    </Tile>
  );
}
