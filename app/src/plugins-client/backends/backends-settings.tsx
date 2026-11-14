'use client';

/**
 * Settings → AI models → Providers: every installed provider, with shared model editing.
 * Connection fields are offered only for providers the user added. The daemon writes `~/.timon/backends/<id>.json` and
 * keeps the key in the vault — this screen never receives the key back, which
 * is why the key field of an edit means "replace it", and an empty one means
 * "leave it alone".
 */

import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, GripVertical, Pencil, Plus, Trash2 } from 'lucide-react';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { t } from '@/lib/i18n';
import { sseOn } from '@/lib/sse-stream';
import { cn } from '@/lib/utils';
import { BrandMark } from '@/components/brand-mark';
import { blankForm, formOf, type CustomBackend } from './form';
import { API, EndpointFields, MANAGE_API, VerdictLine, connectionEditable, errorText, useEndpointDraft, type ProtocolOption } from './endpoint-form';
import { ProvidersPanel } from './providers-panel';
import { ProvidersList } from './providers-list';
import { SidePanel } from './side-panel';
import { HINT } from './type-scale';
import { confirmAction } from '@/components/confirm-dialog/confirm-dialog-context';

type Listing = { backends?: CustomBackend[]; protocols?: ProtocolOption[] };

/** The row's status badge. A binary that is not installed reads "Not detected"
 *  rather than "Inactive": it is the one inactive state with a plain cause. */
function statusKey(backend: CustomBackend): string {
  if (backend.disabled) return 'backendsSettings.disabled';
  if (backend.active) return 'backendsSettings.active';
  return backend.reason && /^binary .+ not found in PATH$/.test(backend.reason)
    ? 'backendsSettings.notDetected'
    : 'backendsSettings.inactive';
}

function SortableBackendRow({ id, busy, below, children }: { id: string; busy: boolean; below?: ReactNode; children: ReactNode }): ReactElement {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id, disabled: busy });
  return <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}
    className="rounded-md border border-border bg-card px-3 py-2.5">
    <div className="flex items-center gap-2">
      <button type="button" {...attributes} {...listeners} aria-label={t('backendsSettings.reorder')}
        className="shrink-0 touch-none rounded p-1 text-muted-foreground hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
        <GripVertical className="size-4" />
      </button>
      <div className="flex min-w-0 flex-1 items-center gap-3">{children}</div>
    </div>
    {below ? <div className="pl-8">{below}</div> : null}
  </li>;
}

/** Keeps its width when the action it holds does not apply to a row, so the
 *  switch and the buttons sit in the same column on every row. */
function ActionSlot({ className, children }: { className: string; children?: ReactNode }): ReactElement {
  return <span className={cn('flex shrink-0 items-center justify-center', className)}>{children}</span>;
}

export function BackendsSettings({ onOpenProvider }: { onOpenProvider: (id: string) => void }): ReactElement {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const mutating = useRef(false);
  const [confirming, setConfirming] = useState<CustomBackend | null>(null);
  const [backends, setBackends] = useState<CustomBackend[]>([]);
  const [protocols, setProtocols] = useState<ProtocolOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);
  // Bumped by the list's Check: the blocks below read their sources again.
  const [generation, setGeneration] = useState(0);

  const load = useCallback(async () => {
    if (mutating.current) return;
    try {
      const res = await fetch(MANAGE_API, { cache: 'no-store' });
      if (res.status === 403 || res.status === 401) { setDenied(true); return; }
      if (!res.ok) throw new Error(await errorText(res));
      const body = await res.json() as Listing;
      if (mutating.current) return;
      setDenied(false);
      setBackends(body.backends ?? []);
      setProtocols(body.protocols ?? []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load, generation]);
  // A file dropped by hand in the folder shows up here too.
  useEffect(() => sseOn('backends_changed', () => { void load(); }), [load]);

  const draft = useEndpointDraft(() => load());
  const form = draft.form;

  async function remove(target: { id: string; label: string }) {
    if (!(await confirmAction({ title: t('backendsSettings.confirmRemove', { name: target.label }), confirmLabel: t('confirmDialog.remove'), destructive: true }))) return;
    try {
      const res = await fetch(`${API}/${encodeURIComponent(target.id)}`, { method: 'DELETE', cache: 'no-store' });
      if (!res.ok) throw new Error(await errorText(res));
      draft.close();
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function patchBackend(id: string, body: Record<string, unknown>) {
    let res: Response;
    try {
      res = await fetch(`${MANAGE_API}/${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
    } catch { throw new Error(t('backendsSettings.errors.unconfirmed')); }
    if (!res.ok) throw new Error(await errorText(res));
  }

  async function setAvailability(backend: CustomBackend, disabled: boolean) {
    setBusy(true);
    mutating.current = true;
    try {
      await patchBackend(backend.id, { disabled });
      setConfirming(null);
    } catch (err) { toast.error(err instanceof Error ? err.message : String(err)); }
    finally { mutating.current = false; setBusy(false); await load(); }
  }

  async function requestToggle(backend: CustomBackend) {
    if (backend.disabled) { await setAvailability(backend, false); return; }
    setBusy(true);
    try {
      const res = await fetch(MANAGE_API, { cache: 'no-store' });
      if (!res.ok) throw new Error(await errorText(res));
      const fresh = (await res.json() as Listing).backends?.find((row) => row.id === backend.id);
      if (fresh) setConfirming(fresh);
    } catch (err) { toast.error(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  async function reorder({ active, over }: DragEndEvent) {
    if (busy || !over || active.id === over.id) return;
    const from = backends.findIndex((row) => row.id === active.id);
    const to = backends.findIndex((row) => row.id === over.id);
    if (from < 0 || to < 0) return;
    const next = arrayMove(backends, from, to);
    setBackends(next);
    setBusy(true);
    mutating.current = true;
    try {
      for (const [rank, row] of next.entries()) {
        if (row.origin === 'file' && row.dialect === null) continue;
        await patchBackend(row.id, { rank });
      }
    } catch (err) { toast.error(err instanceof Error ? err.message : String(err)); }
    finally { mutating.current = false; setBusy(false); await load(); }
  }

  if (denied) {
    return <p className="pt-4 text-[13px] text-muted-foreground">{t('backendsSettings.errors.forbidden')}</p>;
  }

  return (
    <div className="pt-4">
      <p className="max-w-3xl text-[13px] leading-relaxed text-muted-foreground">{t('backendsSettings.intro')}</p>

      <div className="mt-5 max-w-3xl">
        <ProvidersList onOpen={onOpenProvider} onVerified={() => setGeneration((current) => current + 1)} />
      </div>

      {/* Edited here until the provider page's Models and Add sections take these rows over. */}
      <h3 className="m-0 mt-10 text-sm font-semibold">{t('providerList.legacy.title')}</h3>
      {loading ? (
        <div className="mt-6 text-[13px] text-muted-foreground">{t('common.loading')}</div>
      ) : backends.length === 0 ? (
        <div className="mt-5 rounded-md border border-dashed border-border p-6 text-center text-[13px] text-muted-foreground">
          {t('backendsSettings.empty')}
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(event) => void reorder(event)}>
        <SortableContext items={backends.map((backend) => backend.id)} strategy={verticalListSortingStrategy}>
        <ul className="mt-5 flex flex-col gap-2">
          {backends.map((backend) => (
            <SortableBackendRow key={backend.id} id={backend.id} busy={busy || backend.origin === 'file' && backend.dialect === null}
              below={<>
                {backend.warnings.map((warning) => (
                  <p key={warning} className="mt-2 flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
                    <span>{warning}</span>
                  </p>
                ))}
              </>}>
              <BrandMark
                icon={backend.icon ?? undefined}
                brand={backend.brand ?? undefined}
                className="size-4 shrink-0 text-muted-foreground"
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-semibold">{backend.label}</div>
                <div className="mt-1 flex min-w-0 items-center gap-1.5">
                  <Badge
                    className="shrink-0"
                    variant={backend.active ? 'default' : 'outline'}
                    // Why it is inactive, on hover: the line of red text that
                    // used to say it made every such row taller.
                    title={!backend.disabled && backend.reason ? backend.reason : undefined}
                  >
                    {t(statusKey(backend))}
                  </Badge>
                  <Badge className="shrink-0" variant="outline">{t(`backendsSettings.origins.${backend.origin ?? 'file'}`)}</Badge>
                  {backend.protocol ? <Badge className="shrink-0" variant="secondary">{t(`backendsSettings.protocols.${backend.protocol}`)}</Badge> : null}
                  {/* code-font: a URL */}
                  {backend.baseUrl ? <span title={backend.baseUrl} className="min-w-0 truncate font-mono text-[12px] text-muted-foreground">{backend.baseUrl}</span> : null}
                </div>
              </div>
              <span className="shrink-0 whitespace-nowrap text-[12px] text-muted-foreground">
                {t('backendsSettings.modelCount', { count: backend.models.filter((model) => !model.hidden).length })}
              </span>
              <span className="flex shrink-0 items-center gap-1">
                <ActionSlot className="w-10">
                  {(backend.origin !== 'file' || backend.dialect !== null) && <Switch checked={!backend.disabled} disabled={busy} aria-label={t('backendsSettings.toggle', { name: backend.label })}
                    onCheckedChange={() => void requestToggle(backend)} />}
                </ActionSlot>
                <ActionSlot className="size-8">
                  {(backend.origin !== 'file' || backend.dialect !== null) ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="size-8 p-0"
                      onClick={() => draft.open(formOf(backend))}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      <span className="sr-only">{t('backendsSettings.edit')}</span>
                    </Button>
                  ) : null}
                </ActionSlot>
              </span>
            </SortableBackendRow>
          ))}
        </ul>
        </SortableContext>
        </DndContext>
      )}

      <Dialog open={confirming !== null} onOpenChange={(open) => { if (!open && !busy) setConfirming(null); }}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          {confirming && <>
            <DialogHeader>
              <DialogTitle className="text-base">{t('backendsSettings.disableTitle', { name: confirming.label })}</DialogTitle>
              <DialogDescription className={cn('max-w-2xl', HINT)}>{t('backendsSettings.disableHint')}</DialogDescription>
            </DialogHeader>
            {(['agents', 'routines', 'tasks'] as const).map((kind) => {
              const rows = confirming.usages?.[kind] ?? [];
              return rows.length ? <div key={kind} className="text-[13px]">
                <span className="font-medium">{t(`backendsSettings.usages.${kind}`)}</span>
                <ul className="mt-1 list-inside list-disc">{rows.map((row) => <li key={row.id}>{row.label}</li>)}</ul>
              </div> : null;
            })}
            <DialogFooter className="gap-2 sm:gap-0">
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(null)}>{t('common.cancel')}</Button>
              <Button size="sm" disabled={busy} onClick={() => void setAvailability(confirming, true)}>{t('backendsSettings.disable')}</Button>
            </DialogFooter>
          </>}
        </DialogContent>
      </Dialog>

      <Button size="sm" className="mt-4" onClick={() => draft.open(blankForm())}>
        <Plus className="mr-1.5 h-3.5 w-3.5" />
        {t('backendsSettings.add')}
      </Button>

      <SidePanel
        open={form !== null}
        title={t(form?.id ? 'backendsSettings.editTitle' : 'backendsSettings.add')}
        onClose={draft.close}
        onSubmit={() => void draft.save()}
        footer={<>
          {connectionEditable(form) && <Button type="button" size="sm" variant="secondary" disabled={draft.busy} onClick={() => void draft.test()}>
            {draft.verdict?.tone === 'ok' ? <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" /> : null}
            {t('backendsSettings.testButton')}
          </Button>}
          <Button type="submit" size="sm" disabled={draft.busy}>{t('backendsSettings.save')}</Button>
          <Button type="button" size="sm" variant="ghost" disabled={draft.busy} onClick={draft.close}>
            {t('common.cancel')}
          </Button>
          <VerdictLine verdict={draft.verdict} />
          {form?.id && form.origin === 'file' && (
            <Button type="button" size="sm" variant="ghost" className="ml-auto text-destructive hover:text-destructive" disabled={draft.busy}
              onClick={() => void remove({ id: form.id as string, label: form.name || (form.id as string) })}>
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              {t('backendsSettings.remove')}
            </Button>
          )}
        </>}
      >
        {form && <EndpointFields form={form} protocols={protocols} patch={draft.patch} />}
      </SidePanel>

      <p className="mt-6 max-w-3xl text-xs leading-relaxed text-muted-foreground">{t('backendsSettings.reorderHint')}</p>

      <div key={generation}>
        <ProvidersPanel />
      </div>
    </div>
  );
}
