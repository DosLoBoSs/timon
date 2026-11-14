'use client';

/**
 * The order of the model picker, set by dragging: the providers list's
 * "Reorder" mode. The list itself groups providers by status, so the picker's
 * order — every backend, by rank — is edited here, flat. Each backend's rank
 * is written through the same route as before (`PATCH /manage/<id>`).
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { GripVertical } from 'lucide-react';
import { toast } from 'sonner';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { BrandMark } from '@/components/brand-mark';
import { t } from '@/lib/i18n';
import { sseOn } from '@/lib/sse-stream';
import type { CustomBackend } from './form';

const MANAGE_API = '/api/ui/backends/manage';

/** A file the person dropped by hand without a dialect cannot be written to: it keeps its place. */
export function rankable(backend: Pick<CustomBackend, 'origin' | 'dialect'>): boolean {
  return backend.origin !== 'file' || backend.dialect !== null;
}

async function errorText(res: Response): Promise<string> {
  if (res.status === 403) return t('backendsSettings.errors.forbidden');
  const raw = (await res.text().catch(() => '')).trim();
  try {
    return (JSON.parse(raw) as { error?: string }).error || `HTTP ${res.status}`;
  } catch {
    return raw || `HTTP ${res.status}`;
  }
}

function SortableRow({ backend, busy }: { backend: CustomBackend; busy: boolean }): ReactElement {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: backend.id, disabled: busy || !rankable(backend) });
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} data-reorder-row={backend.id}
      className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted/60">
      <button type="button" {...attributes} {...listeners} aria-label={t('backendsSettings.reorder')}
        className="shrink-0 touch-none rounded p-1 text-muted-foreground hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
        <GripVertical className="size-4" />
      </button>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/60">
        <BrandMark icon={backend.icon ?? undefined} brand={backend.brand ?? undefined} className="size-4" />
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{backend.label}</span>
      {backend.disabled ? <span className="shrink-0 text-xs text-muted-foreground">{t('providerStatus.disabled')}</span> : null}
    </li>
  );
}

export function ProvidersReorder({ onChanged }: { onChanged?: () => void }): ReactElement {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const [backends, setBackends] = useState<CustomBackend[] | null>(null);
  const [busy, setBusy] = useState(false);
  // A reload answered in the middle of a drag would put the old order back under the pointer.
  const mutating = useRef(false);

  const load = useCallback(async () => {
    if (mutating.current) return;
    try {
      const res = await fetch(MANAGE_API, { cache: 'no-store' });
      if (!res.ok) throw new Error(await errorText(res));
      const body = await res.json() as { backends?: CustomBackend[] };
      if (!mutating.current) setBackends(body.backends ?? []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setBackends((current) => current ?? []);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => sseOn('backends_changed', () => { void load(); }), [load]);

  async function reorder({ active, over }: DragEndEvent) {
    if (!backends || busy || !over || active.id === over.id) return;
    const from = backends.findIndex((row) => row.id === active.id);
    const to = backends.findIndex((row) => row.id === over.id);
    if (from < 0 || to < 0) return;
    const next = arrayMove(backends, from, to);
    setBackends(next);
    setBusy(true);
    mutating.current = true;
    try {
      for (const [rank, row] of next.entries()) {
        if (!rankable(row)) continue;
        let res: Response;
        try {
          res = await fetch(`${MANAGE_API}/${encodeURIComponent(row.id)}`, {
            method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rank }),
          });
        } catch { throw new Error(t('backendsSettings.errors.unconfirmed')); }
        if (!res.ok) throw new Error(await errorText(res));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      mutating.current = false;
      setBusy(false);
      await load();
      onChanged?.();
    }
  }

  if (!backends) return <p className="m-0 text-[13px] text-muted-foreground">{t('common.loading')}</p>;
  return (
    <div className="space-y-2">
      <p className="m-0 max-w-3xl text-xs leading-relaxed text-muted-foreground">{t('backendsSettings.reorderHint')}</p>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(event) => void reorder(event)}>
        <SortableContext items={backends.map((backend) => backend.id)} strategy={verticalListSortingStrategy}>
          <ul className="m-0 flex list-none flex-col gap-0.5 rounded-xl bg-card p-1 shadow-elev-1" aria-label={t('providerList.reorder.title')}>
            {backends.map((backend) => <SortableRow key={backend.id} backend={backend} busy={busy} />)}
          </ul>
        </SortableContext>
      </DndContext>
    </div>
  );
}
