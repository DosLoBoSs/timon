'use client';

/**
 * "Open pull requests": the pull requests open on the repository of ONE
 * project in `pr` mode, contributors' ones included, and their read-only
 * relecture.
 *
 * One group, one filter (the author), one main action per row: "Review". It
 * prepares the reviewer's brief, which the person reads in a dialog and sends
 * with a click; nothing starts before, and nothing is ever posted on the
 * forge. The verdict comes back on the row. Opening the pull request on the
 * forge, or the reviewer's report, sit in the row's menu.
 *
 * The project comes from the chat rail when there is one, else from a picker
 * remembered per browser, like the project's TO DO widget.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ExternalLink, FileText, GitPullRequest, MoreHorizontal, ScanSearch } from 'lucide-react';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { toast } from 'sonner';
import { Tile } from '@/components/tile';
import { WIDGET_SELECT, WidgetButton, widgetButtonClass } from '@/components/widget-toolbar';
import { HUD_SURFACE } from '@/components/cockpit/hud-surface';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useChatRail } from '@/components/chat/chat-rails';
import { apiErrorMessage } from '@/lib/api-error';
import { t } from '@/lib/i18n';
import { sharedGet } from '@/lib/shared-read';
import { machineScopedStorage } from '@/lib/machines/machine-storage';
import { NativeViewCover } from '@/lib/native-view-cover';
import { cn } from '@/lib/utils';
import type { WidgetProps } from '@/components/widget-host/widget-props';
import {
  anyReviewRunning, filterByAuthor, pullAuthors, reviewBadge,
  type PullRequestItem, type PullRequestList, type ReviewBadge,
} from './pull-requests-model';

/** The project picked by hand, per browser and per machine. */
const PROJECT_KEY = 'timon.pull-requests.project';
/** How often a running review is asked for its verdict. */
const RUNNING_POLL_MS = 15_000;

type Project = { slug: string; name?: string | null };

type Load =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; list: PullRequestList };

type Draft = { number: number; reviewId: string; agent: string; brief: string };

function storedProject(): string | null {
  if (typeof window === 'undefined') return null;
  return machineScopedStorage(window.localStorage).getItem(PROJECT_KEY) || null;
}

const projectPath = (slug: string) => `/api/ui/projects/${encodeURIComponent(slug)}/pull-requests`;

export function PullRequestsWidget({ handle, className }: WidgetProps) {
  const chat = useChatRail();
  const [picked, setPicked] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [load, setLoad] = useState<Load>({ kind: 'idle' });
  const [author, setAuthor] = useState<string | null>(null);
  const [preparing, setPreparing] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [sending, setSending] = useState(false);
  const [report, setReport] = useState<PullRequestItem | null>(null);

  useEffect(() => { setPicked(storedProject()); }, []);
  const context = chat?.slug ?? null;
  const slug = context ?? picked;

  useEffect(() => {
    if (context) return;
    let alive = true;
    void (async () => {
      try {
        const r = await sharedGet('/api/ui/projects');
        const j = (await r.json()) as { projects?: Project[] };
        if (alive) setProjects(j.projects ?? []);
      } catch {
        // The picker stays empty: the tile says it waits for a project.
      }
    })();
    return () => { alive = false; };
  }, [context]);

  const reload = useCallback(async (quiet = false) => {
    if (!slug) { setLoad({ kind: 'idle' }); return; }
    if (!quiet) setLoad({ kind: 'loading' });
    try {
      const res = await fetch(projectPath(slug), { cache: 'no-store' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setLoad({ kind: 'error', message: apiErrorMessage(json, { status: res.status }) }); return; }
      setLoad({ kind: 'ready', list: json as PullRequestList });
    } catch (err) {
      setLoad({ kind: 'error', message: (err as Error).message });
    }
  }, [slug]);

  useEffect(() => { setAuthor(null); void reload(); }, [reload]);

  const pulls = load.kind === 'ready' ? load.list.pulls : [];
  const running = anyReviewRunning(pulls);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => { void reload(true); }, RUNNING_POLL_MS);
    return () => clearInterval(timer);
  }, [running, reload]);

  const authors = useMemo(() => pullAuthors(pulls), [pulls]);
  const shown = useMemo(() => filterByAuthor(pulls, author), [pulls, author]);

  const prepare = async (pull: PullRequestItem) => {
    if (!slug) return;
    setPreparing(pull.number);
    try {
      const res = await fetch(`${projectPath(slug)}/${pull.number}/review`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      const json = await res.json().catch(() => ({})) as { brief?: string; review?: { id: string; agent: string } };
      if (!res.ok || !json.brief || !json.review) {
        toast.error(t('pullRequests.prepareError'), { description: apiErrorMessage(json, { status: res.status }) });
        return;
      }
      setDraft({ number: pull.number, reviewId: json.review.id, agent: json.review.agent, brief: json.brief });
    } catch (err) {
      toast.error(t('pullRequests.prepareError'), { description: (err as Error).message });
    } finally {
      setPreparing(null);
    }
  };

  const send = async () => {
    if (!slug || !draft) return;
    setSending(true);
    try {
      const res = await fetch(`${projectPath(slug)}/${draft.number}/review/send`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ review_id: draft.reviewId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(t('pullRequests.sendError'), { description: apiErrorMessage(json, { status: res.status }) });
        return;
      }
      toast.success(t('pullRequests.sent', { agent: draft.agent }));
      setDraft(null);
      void reload(true);
    } catch (err) {
      toast.error(t('pullRequests.sendError'), { description: (err as Error).message });
    } finally {
      setSending(false);
    }
  };

  const projectPicker = context ? null : (
    <select
      data-pull-project=""
      value={picked ?? ''}
      aria-label={t('pullRequests.selectProject')}
      onChange={(e) => {
        const v = e.target.value || null;
        setPicked(v);
        const storage = machineScopedStorage(window.localStorage);
        if (v) storage.setItem(PROJECT_KEY, v); else storage.removeItem(PROJECT_KEY);
      }}
      className={cn(WIDGET_SELECT, 'max-w-[9rem]')}
    >
      <option value="">{t('pullRequests.noProjectOption')}</option>
      {projects.map((p) => <option key={p.slug} value={p.slug}>{p.name || p.slug}</option>)}
    </select>
  );

  const authorFilter = authors.length > 1 ? (
    <select
      data-pull-author-filter=""
      value={author ?? ''}
      aria-label={t('pullRequests.filterAuthor')}
      onChange={(e) => setAuthor(e.target.value || null)}
      className={cn(WIDGET_SELECT, 'max-w-[8rem]')}
    >
      <option value="">{t('pullRequests.allAuthors')}</option>
      {authors.map((a) => <option key={a} value={a}>{a}</option>)}
    </select>
  ) : null;

  return (
    <Tile
      title={t('pullRequests.title')}
      subtitle={load.kind === 'ready' ? String(shown.length) : undefined}
      className={cn(HUD_SURFACE, className)}
      bodyClassName="px-1.5 pb-3 pt-1"
      actions={<>{authorFilter}{projectPicker}{handle}</>}
    >
      {!slug ? (
        <Empty text={t('pullRequests.chooseProject')} />
      ) : load.kind === 'loading' || load.kind === 'idle' ? (
        <Empty text={t('pullRequests.loading')} />
      ) : load.kind === 'error' ? (
        <Empty text={load.message} />
      ) : shown.length === 0 ? (
        <Empty text={author ? t('pullRequests.emptyAuthor') : t('pullRequests.empty')} />
      ) : (
        <ul className="flex flex-col gap-1">
          {shown.map((pull) => (
            <PullRow
              key={pull.number}
              pull={pull}
              preparing={preparing === pull.number}
              onReview={() => void prepare(pull)}
              onReport={() => setReport(pull)}
            />
          ))}
        </ul>
      )}

      {draft && (
        <Dialog open onOpenChange={(open) => { if (!open && !sending) setDraft(null); }}>
          <DialogContent className="max-w-2xl">
            <DialogTitle className="text-sm">{t('pullRequests.dialog.title', { number: draft.number })}</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              {t('pullRequests.dialog.reviewer', { agent: draft.agent })}
            </DialogDescription>
            <div data-pull-brief="" className="scrollbar-thin max-h-[55vh] overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 text-[12px] leading-relaxed text-foreground">
              {draft.brief}
            </div>
            <div className="flex justify-end gap-2">
              <WidgetButton onClick={() => setDraft(null)} disabled={sending} label={t('pullRequests.dialog.cancel')} />
              <WidgetButton primary data-pull-send="" onClick={() => void send()} disabled={sending} label={sending ? t('pullRequests.dialog.sending') : t('pullRequests.dialog.send')} />
            </div>
          </DialogContent>
        </Dialog>
      )}

      {report?.review?.report && (
        <Dialog open onOpenChange={(open) => { if (!open) setReport(null); }}>
          <DialogContent className="max-w-2xl">
            <DialogTitle className="text-sm">{t('pullRequests.report.title', { number: report.number })}</DialogTitle>
            <DialogDescription className="sr-only">{report.title}</DialogDescription>
            <div className="scrollbar-thin max-h-[60vh] overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 text-[12.5px] leading-relaxed text-foreground">
              {report.review.report}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </Tile>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-6">
      <GitPullRequest className="size-4 text-muted-foreground/60" aria-hidden />
      <span className="text-center text-[12.5px] text-muted-foreground">{text}</span>
    </div>
  );
}

const VERDICT_TONE: Record<string, string> = {
  mergeable: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  changes_requested: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  reject: 'bg-red-500/15 text-red-700 dark:text-red-300',
  product_decision: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  none: 'bg-muted text-muted-foreground',
};

function VerdictChip({ badge }: { badge: ReviewBadge }) {
  const label = badge.kind === 'running'
    ? t('pullRequests.reviewing')
    : badge.kind === 'failed'
      ? t('pullRequests.verdict.failed')
      : t(`pullRequests.verdict.${badge.verdict ?? 'none'}`);
  const tone = badge.kind === 'verdict' ? VERDICT_TONE[badge.verdict ?? 'none'] : VERDICT_TONE.none;
  const outdated = badge.kind === 'verdict' && badge.outdated;
  return (
    <span
      title={outdated ? t('pullRequests.outdated') : undefined}
      data-pull-verdict={badge.kind === 'verdict' ? badge.verdict ?? 'none' : badge.kind}
      className={cn('inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-[10.5px] font-medium', tone, outdated && 'opacity-60')}
    >
      {label}{outdated ? ' *' : ''}
    </span>
  );
}

function PullRow({ pull, preparing, onReview, onReport }: {
  pull: PullRequestItem;
  preparing: boolean;
  onReview: () => void;
  onReport: () => void;
}) {
  const badge = reviewBadge(pull);
  const running = badge?.kind === 'running';
  const meta = [`#${pull.number}`, pull.author ?? t('pullRequests.deletedAuthor')];
  if (pull.isDraft) meta.push(t('pullRequests.draft'));
  return (
    <li data-pull-row={pull.number} className="flex items-center gap-2 rounded-lg bg-muted/30 px-2.5 py-2 transition-colors hover:bg-muted/50">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-medium text-foreground" title={pull.title}>{pull.title}</div>
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="truncate tabular-nums">{meta.join(' · ')}</span>
          {badge && <VerdictChip badge={badge} />}
        </div>
      </div>
      <WidgetButton
        primary
        data-pull-review=""
        onClick={onReview}
        disabled={running || preparing}
        icon={<ScanSearch className="size-3" />}
        label={preparing ? t('pullRequests.preparing') : t('pullRequests.review')}
      />
      <Dropdown.Root>
        <Dropdown.Trigger asChild>
          <button type="button" title={t('pullRequests.more')} aria-label={t('pullRequests.more')} className={widgetButtonClass({ iconOnly: true })}>
            <MoreHorizontal className="size-3.5" />
          </button>
        </Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content sideOffset={6} align="end" className="z-50 min-w-44 rounded-lg border border-border bg-popover p-1 text-xs text-popover-foreground shadow-elev-2">
            <NativeViewCover />
            <Dropdown.Item
              onSelect={() => { window.open(pull.url, '_blank', 'noopener,noreferrer'); }}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 outline-none focus:bg-muted"
            >
              <ExternalLink className="size-3.5" />{t('pullRequests.openOnForge')}
            </Dropdown.Item>
            {pull.review?.report && (
              <Dropdown.Item
                onSelect={onReport}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 outline-none focus:bg-muted"
              >
                <FileText className="size-3.5" />{t('pullRequests.showReport')}
              </Dropdown.Item>
            )}
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>
    </li>
  );
}
