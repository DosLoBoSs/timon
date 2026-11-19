'use client';

/**
 * "Open pull requests": the pull requests open on the repository of ONE
 * project in `pr` mode, contributors' ones included, and the brief of their
 * relecture.
 *
 * One group, one filter (the author), one main action per row: "Prepare the
 * review". It prepares the reviewer's brief and shows it beside the diff, with
 * a way to copy it; Timon starts no mission from here, since its reviewer
 * would not be confined, and nothing is ever posted on the forge. Opening the
 * pull request on the forge, or a past report, sit in the row's menu.
 *
 * A widget of the "Git" stack. The project comes from the chat rail when
 * there is one, else from a picker the jobs widget shares
 * (`git-stack-project.tsx`): it is chosen once for both.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, ExternalLink, FileText, GitPullRequest, Loader2, MoreHorizontal, ScanSearch } from 'lucide-react';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { toast } from 'sonner';
import { Tile } from '@/components/tile';
import { WIDGET_SELECT, WidgetButton, widgetButtonClass } from '@/components/widget-toolbar';
import { HUD_SURFACE } from '@/components/cockpit/hud-surface';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { apiErrorMessage } from '@/lib/api-error';
import { copyToClipboard } from '@/lib/clipboard';
import { t } from '@/lib/i18n';
import { NativeViewCover } from '@/lib/native-view-cover';
import { cn } from '@/lib/utils';
import type { WidgetProps } from '@/components/widget-host/widget-props';
import {
  anyReviewRunning, filterByAuthor, pullAuthors, reviewBadge,
  type PullRequestItem, type PullRequestList, type ReviewBadge,
} from './pull-requests-model';
import { diffLineKind } from './landing-api';
import { DIFF_LINE_CLASS } from './landing-preview-dialog';
import { StackProjectPicker, useStackProject } from './git-stack-project';

/** How often a running review is asked for its verdict. */
const RUNNING_POLL_MS = 15_000;
/** Most diff lines painted: a 2 MB diff would freeze the dialog. */
const DIFF_LINES_SHOWN = 3000;

type Load =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; list: PullRequestList };

type Draft = { number: number; title: string; brief: string };

/** The diff of pull request `number`: an answer for an earlier dialog is dropped. */
type DiffLoad = { number: number } & (
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; diff: string; truncated: boolean }
);

const projectPath = (slug: string) => `/api/ui/projects/${encodeURIComponent(slug)}/pull-requests`;

export function PullRequestsWidget({ handle, className }: WidgetProps) {
  const project = useStackProject();
  const slug = project.slug;
  const [load, setLoad] = useState<Load>({ kind: 'idle' });
  const [author, setAuthor] = useState<string | null>(null);
  const [preparing, setPreparing] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [diff, setDiff] = useState<DiffLoad>({ number: 0, kind: 'loading' });
  const [report, setReport] = useState<PullRequestItem | null>(null);

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
      const json = await res.json().catch(() => ({})) as { brief?: string };
      if (!res.ok || !json.brief) {
        toast.error(t('pullRequests.prepareError'), { description: apiErrorMessage(json, { status: res.status }) });
        return;
      }
      setDiff({ number: pull.number, kind: 'loading' });
      setDraft({ number: pull.number, title: pull.title, brief: json.brief });
      void readDiff(slug, pull.number);
    } catch (err) {
      toast.error(t('pullRequests.prepareError'), { description: (err as Error).message });
    } finally {
      setPreparing(null);
    }
  };

  const readDiff = async (project: string, number: number) => {
    const show = (next: DiffLoad) => setDiff((current) => (current.number === number ? next : current));
    try {
      const res = await fetch(`${projectPath(project)}/${number}/diff`, { cache: 'no-store' });
      const json = await res.json().catch(() => ({})) as { diff?: string; truncated?: boolean };
      if (!res.ok || typeof json.diff !== 'string') {
        show({ number, kind: 'error', message: apiErrorMessage(json, { status: res.status }) });
        return;
      }
      show({ number, kind: 'ready', diff: json.diff, truncated: json.truncated === true });
    } catch (err) {
      show({ number, kind: 'error', message: (err as Error).message });
    }
  };

  const copyBrief = async () => {
    if (!draft) return;
    if (await copyToClipboard(draft.brief)) toast.success(t('pullRequests.dialog.copied'));
    else toast.error(t('pullRequests.dialog.copyFailed'));
  };

  const projectPicker = (
    <StackProjectPicker project={project} none={t('pullRequests.noProjectOption')} label={t('pullRequests.selectProject')} />
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
        <Dialog open onOpenChange={(open) => { if (!open) setDraft(null); }}>
          <DialogContent className="max-w-3xl">
            <DialogTitle className="text-sm">{t('pullRequests.dialog.title', { number: draft.number })}</DialogTitle>
            <DialogDescription className="sr-only">{draft.title}</DialogDescription>
            <Tabs defaultValue="brief" className="flex min-h-0 min-w-0 flex-col gap-2">
              <TabsList className="h-8 self-start">
                <TabsTrigger value="brief" className="text-xs">{t('pullRequests.dialog.tabBrief')}</TabsTrigger>
                <TabsTrigger value="diff" data-pull-diff-tab="" className="text-xs">{t('pullRequests.dialog.tabDiff')}</TabsTrigger>
              </TabsList>
              <TabsContent value="brief" className="mt-0 min-w-0">
                <div data-pull-brief="" className="scrollbar-thin max-h-[55vh] overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 text-[12px] leading-relaxed text-foreground">
                  {draft.brief}
                </div>
              </TabsContent>
              <TabsContent value="diff" className="mt-0 min-w-0">
                <DiffView load={diff} />
              </TabsContent>
            </Tabs>
            <div className="flex justify-end gap-2">
              <WidgetButton onClick={() => setDraft(null)} label={t('pullRequests.dialog.close')} />
              <WidgetButton primary data-pull-copy="" onClick={() => void copyBrief()} icon={<Copy className="size-3" />} label={t('pullRequests.dialog.copy')} />
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

function DiffView({ load }: { load: DiffLoad }) {
  if (load.kind === 'loading') return <p className="text-xs text-muted-foreground">{t('pullRequests.loading')}</p>;
  if (load.kind === 'error') return <p className="text-xs text-red-600 dark:text-red-400">{load.message}</p>;
  if (!load.diff.trim()) return <p className="text-xs text-muted-foreground">{t('pullRequests.dialog.diffEmpty')}</p>;
  const lines = load.diff.split('\n');
  const cut = load.truncated || lines.length > DIFF_LINES_SHOWN;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {/* The dialog is a grid: without min-w-0 up the chain, the longest diff
          line widens the dialog instead of scrolling inside it. */}
      {/* code-font: a diff */}
      <pre data-pull-diff="" className="scrollbar-thin max-h-[55vh] w-full overflow-auto rounded-lg bg-muted/40 py-1.5 font-mono text-[11px] leading-[1.5]">
        {/* w-max + min-w-full: a line's colour spans the scrolled width, not only the visible one. */}
        <div className="w-max min-w-full">
          {lines.slice(0, DIFF_LINES_SHOWN).map((line, i) => (
            <div key={i} className={cn('whitespace-pre px-2', DIFF_LINE_CLASS[diffLineKind(line)])}>{line || ' '}</div>
          ))}
        </div>
      </pre>
      {cut && <p className="text-[11px] text-muted-foreground">{t('pullRequests.dialog.diffCut')}</p>}
    </div>
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
    <li data-pull-row={pull.number} className="flex items-center gap-1 rounded-lg bg-muted/30 py-2 pl-2.5 pr-1 transition-colors hover:bg-muted/50">
      <div className="min-w-0 flex-1">
        <div className="line-clamp-2 break-words text-[12.5px] font-medium leading-snug text-foreground" title={pull.title}>{pull.title}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="truncate tabular-nums">{meta.join(' · ')}</span>
          {badge && <VerdictChip badge={badge} />}
        </div>
      </div>
      {/* Icon only: the row's width belongs to the pull request, not to its action. */}
      <WidgetButton
        data-pull-review=""
        onClick={onReview}
        disabled={running || preparing}
        title={preparing ? t('pullRequests.preparing') : t('pullRequests.review')}
        aria-label={preparing ? t('pullRequests.preparing') : t('pullRequests.review')}
        icon={preparing ? <Loader2 className="size-3.5 animate-spin" /> : <ScanSearch className="size-3.5" />}
      />
      <Dropdown.Root modal={false}>
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
