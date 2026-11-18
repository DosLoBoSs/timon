'use client';

/**
 * The preview of a job's pull request: what it brings (the diff, file by file,
 * and the commits) and whether Timon would open it (the pre-checks, run dry
 * by the daemon: nothing fetched, pushed or opened).
 *
 * Three tabs rather than one long page: a branch of a few hundred files keeps
 * its commits and its verdict one click away. A file's patch is painted only
 * once unfolded.
 */

import { useEffect, useState } from 'react';
import { ChevronRight, CircleAlert, CircleCheck, CircleMinus } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  diffLineKind, patchBody, previewLanding,
  type DiffLineKind, type Landing, type LandingPreview, type Precheck, type PreviewFile,
} from './landing-api';

/** How each kind of diff line is painted, here and in the open pull requests' dialog. */
export const DIFF_LINE_CLASS: Record<DiffLineKind, string> = {
  add: 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-200',
  del: 'bg-red-500/10 text-red-800 dark:text-red-200',
  hunk: 'text-sky-700 dark:text-sky-300',
  meta: 'text-muted-foreground',
  context: 'text-foreground/85',
};

const NOTE = 'rounded-md bg-amber-500/10 px-2.5 py-1.5 text-[11.5px] text-amber-800 dark:text-amber-200';
const ISLAND = 'rounded-lg bg-foreground/[0.035]';

function FileDiff({ file, open, onToggle }: { file: PreviewFile; open: boolean; onToggle: () => void }) {
  return (
    <li className={ISLAND}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-foreground/[0.04]"
      >
        <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        {/* code-font: a file path */}
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" title={file.path}>{file.path}</span>
        {file.binary
          ? <span className="text-[11px] text-muted-foreground">{t('landings.previewDialog.binary')}</span>
          : (
            <span className="shrink-0 text-[11px] tabular-nums">
              <span className="text-emerald-700 dark:text-emerald-300">+{file.additions ?? 0}</span>
              {' '}
              <span className="text-red-700 dark:text-red-300">−{file.deletions ?? 0}</span>
            </span>
          )}
      </button>
      {open && (
        <div className="px-2 pb-2">
          {file.patch === null
            ? <p className="px-1 text-[11.5px] text-muted-foreground">{t('landings.previewDialog.noPatch')}</p>
            : (
              // code-font: a diff
              <pre className="scrollbar-thin overflow-x-auto rounded-md bg-background/70 py-1.5 font-mono text-[11px] leading-[1.5]">
                {patchBody(file.patch).map((line, i) => (
                  <div key={i} className={cn('whitespace-pre px-2', DIFF_LINE_CLASS[diffLineKind(line)])} data-kind={diffLineKind(line)}>{line || ' '}</div>
                ))}
              </pre>
            )}
          {file.patch_truncated && <p className="mt-1.5 px-1 text-[11px] text-muted-foreground">{t('landings.previewDialog.fileCut')}</p>}
        </div>
      )}
    </li>
  );
}

function PrecheckRow({ check }: { check: Precheck }) {
  const Icon = check.skipped ? CircleMinus : check.ok ? CircleCheck : CircleAlert;
  const tone = check.skipped ? 'text-muted-foreground' : check.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400';
  return (
    <li className={cn(ISLAND, 'flex items-start gap-2 px-2.5 py-2')} data-check={check.name} data-ok={check.ok}>
      <Icon className={cn('mt-0.5 size-3.5 shrink-0', tone)} aria-hidden />
      <div className="min-w-0">
        <p className="text-xs font-medium">
          {t(`landings.precheck.${check.name}`)}
          {check.skipped && <span className="ml-1.5 font-normal text-muted-foreground">{t('landings.previewDialog.skipped')}</span>}
        </p>
        {/* The daemon's own wording: a branch, a commit or an account. */}
        <p className="break-words text-[11.5px] text-muted-foreground">{check.detail}</p>
      </div>
    </li>
  );
}

function Verdict({ preview }: { preview: LandingPreview }) {
  const p = preview.prechecks;
  if (!p.ran) return <p className="text-[11.5px] text-muted-foreground">{t('landings.previewDialog.prechecksNotRun', { reason: p.reason })}</p>;
  const refused = p.checks.filter((c) => !c.ok).length;
  return p.ready
    ? <p className="text-xs font-medium text-emerald-700 dark:text-emerald-300">{t('landings.previewDialog.ready')}</p>
    : <p className="text-xs font-medium text-red-700 dark:text-red-300">{t('landings.previewDialog.refused', { count: refused })}</p>;
}

export function LandingPreviewDialog({ landing, onClose }: { landing: Landing; onClose: () => void }) {
  const [preview, setPreview] = useState<LandingPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let alive = true;
    void previewLanding(landing.id).then((out) => {
      if (!alive) return;
      if (!out.ok) { setError(out.message); return; }
      setPreview(out.value);
      // A short diff opens whole; a long one waits to be asked.
      if (out.value.files.length <= 3) setOpen(new Set(out.value.files.map((f) => f.path)));
    });
    return () => { alive = false; };
  }, [landing.id]);

  const toggle = (path: string) => setOpen((s) => {
    const n = new Set(s);
    if (n.has(path)) n.delete(path); else n.add(path);
    return n;
  });
  const target = `${landing.remote}/${landing.target}`;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col gap-3 overflow-hidden">
        <DialogTitle className="flex min-w-0 items-center gap-2 text-sm">
          {/* code-font: a branch name */}
          <span className="truncate font-mono">{landing.branch}</span>
          <span className="shrink-0 font-normal text-muted-foreground">{t('landings.into', { target })}</span>
        </DialogTitle>
        <DialogDescription className="sr-only">{t('landings.previewDialog.description')}</DialogDescription>

        {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
        {!preview && !error && <p className="text-xs text-muted-foreground">{t('landings.loading')}</p>}

        {preview && (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] tabular-nums text-muted-foreground">
              <span>{t('landings.previewDialog.summary', { commits: preview.commit_count, files: preview.totals.files })}</span>
              <span>
                <span className="text-emerald-700 dark:text-emerald-300">+{preview.totals.additions}</span>
                {' '}
                <span className="text-red-700 dark:text-red-300">−{preview.totals.deletions}</span>
              </span>
              <span className={cn(preview.conflict.state === 'conflicting' && 'font-medium text-red-700 dark:text-red-300')}>
                {t(`landings.previewDialog.conflict.${preview.conflict.state}`, { target })}
              </span>
              <span className="ml-auto"><Verdict preview={preview} /></span>
            </div>
            {preview.problem && <p className={NOTE}>{preview.problem}</p>}
            {preview.conflict.files.length > 0 && (
              <p className={NOTE}>{t('landings.previewDialog.conflictFiles', { files: preview.conflict.files.join(', ') })}</p>
            )}

            <Tabs defaultValue="changes" className="flex min-h-0 flex-1 flex-col gap-2">
              <TabsList className="h-8 self-start">
                <TabsTrigger value="changes" className="text-xs">{t('landings.previewDialog.tabChanges')}</TabsTrigger>
                <TabsTrigger value="commits" className="text-xs">{t('landings.previewDialog.tabCommits')}</TabsTrigger>
                <TabsTrigger value="checks" className="text-xs">{t('landings.previewDialog.tabChecks')}</TabsTrigger>
              </TabsList>

              <TabsContent value="changes" className="scrollbar-thin mt-0 min-h-0 flex-1 overflow-y-auto">
                {preview.files.length === 0 && !preview.problem && (
                  <p className="text-xs text-muted-foreground">{t('landings.previewDialog.nothing', { target })}</p>
                )}
                <ul className="flex flex-col gap-1.5">
                  {preview.files.map((file) => (
                    <FileDiff key={file.path} file={file} open={open.has(file.path)} onToggle={() => toggle(file.path)} />
                  ))}
                </ul>
                {(preview.files_truncated || preview.patch_truncated) && (
                  <p className={cn(NOTE, 'mt-2')}>
                    {preview.files_truncated
                      ? t('landings.previewDialog.filesCut', { shown: preview.files.length, total: preview.totals.files })
                      : t('landings.previewDialog.patchCut')}
                  </p>
                )}
              </TabsContent>

              <TabsContent value="commits" className="scrollbar-thin mt-0 min-h-0 flex-1 overflow-y-auto">
                <ul className="flex flex-col gap-1">
                  {preview.commits.map((c) => (
                    <li key={c.sha} className={cn(ISLAND, 'flex min-w-0 items-baseline gap-2 px-2.5 py-1.5')}>
                      {/* code-font: a commit sha */}
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{c.short}</span>
                      <span className="min-w-0 flex-1 truncate text-xs" title={c.subject}>{c.subject}</span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">{c.author}</span>
                    </li>
                  ))}
                </ul>
                {preview.commits_truncated && (
                  <p className={cn(NOTE, 'mt-2')}>{t('landings.previewDialog.commitsCut', { shown: preview.commits.length, total: preview.commit_count })}</p>
                )}
              </TabsContent>

              <TabsContent value="checks" className="scrollbar-thin mt-0 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
                {preview.pull_request && (
                  <div className={cn(ISLAND, 'px-2.5 py-2')}>
                    <p className="text-xs font-medium">{preview.pull_request.title}</p>
                    {preview.pull_request.body && (
                      <p className="mt-1 whitespace-pre-wrap break-words text-[11.5px] text-muted-foreground">{preview.pull_request.body}</p>
                    )}
                  </div>
                )}
                {preview.prechecks.ran
                  ? (
                    <ul className="flex flex-col gap-1">
                      {preview.prechecks.checks.map((c) => <PrecheckRow key={c.name} check={c} />)}
                    </ul>
                  )
                  : <Verdict preview={preview} />}
              </TabsContent>
            </Tabs>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
