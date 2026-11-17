'use client';

import { isAddWidgetPlaceholder } from './add-widget';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy, verticalListSortingStrategy } from '@dnd-kit/sortable';

import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { WidgetCard } from './widget-card';
import { useWidgetHost } from './widget-host';
import { type WidgetOrientation, type WidgetZoneDef } from './widget-dnd';
import { moveEdge, sharesFromHeights, normalizedShares, widgetStacks, type WidgetLayout, type ZoneId } from './widget-layout';
import { WidgetInsertion } from './widget-drop';
import { Fragment } from 'react';
import { useMobile } from '@/hooks/use-mobile';

/** Space between two cards of a column, in px (`.widget-frame ~ .widget-frame`). */
const CARD_GAP = 12;

/** Flex weight of a stack: its share in percent. A card saved with a height of
 *  its own (before every column was shared out) counts for its height against
 *  the column's: it keeps its look until an edge is first dragged. */
function weightOf(head: WidgetLayout, zoneHeight: number): number {
  if (head.heightMode === 'fill') return head.fillPercent ?? 100;
  return zoneHeight > 0 ? Math.max(5, (head.hauteur / zoneHeight) * 100) : head.hauteur / 6;
}

/**
 * The edge between two cards of a column: dragging it trades height between
 * them, the rest of the column untouched, so it stays exactly full. It sticks
 * to the known shares (`HEIGHT_SNAPS`); Shift drags freely. Arrow keys move it
 * by 24px, Shift for 96.
 */
function HeightEdge({ index, label, moveEdgeBy }: {
  index: number;
  label: string;
  moveEdgeBy: (index: number, start: readonly number[] | null, delta: number, free: boolean, persist: boolean) => readonly number[] | null;
}) {
  const drag = useRef<{ pointer: number; y: number; heights: readonly number[] } | null>(null);
  const frameRequest = useRef<number | null>(null);
  const [active, setActive] = useState(false);
  useEffect(() => () => { if (frameRequest.current !== null) cancelAnimationFrame(frameRequest.current); }, []);
  const finish = (y: number | null, free: boolean) => {
    const start = drag.current;
    drag.current = null;
    setActive(false);
    if (frameRequest.current !== null) { cancelAnimationFrame(frameRequest.current); frameRequest.current = null; }
    if (start) moveEdgeBy(index, start.heights, y === null ? 0 : y - start.y, free, true);
  };
  return <div className="relative z-30 h-0 shrink-0" data-widget-edge={index}>
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      title={label}
      tabIndex={0}
      className={cn(
        // In the 12px gap below the card (the next card's top margin).
        'absolute inset-x-2 top-0.5 h-2 cursor-row-resize touch-none outline-none',
        'after:absolute after:inset-x-0 after:top-1/2 after:h-0.5 after:-translate-y-1/2 after:rounded-full after:transition-colors',
        'hover:after:bg-primary/50 focus-visible:after:bg-primary',
        active && 'after:bg-primary',
      )}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const heights = moveEdgeBy(index, null, 0, true, false);
        if (!heights) return;
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        drag.current = { pointer: e.pointerId, y: e.clientY, heights };
        setActive(true);
      }}
      onPointerMove={(e) => {
        const start = drag.current;
        if (start?.pointer !== e.pointerId) return;
        const y = e.clientY;
        const free = e.shiftKey;
        // One layout per frame: a pointer reports far more often than the
        // screen repaints, and each report re-renders the column.
        if (frameRequest.current !== null) cancelAnimationFrame(frameRequest.current);
        frameRequest.current = requestAnimationFrame(() => {
          frameRequest.current = null;
          moveEdgeBy(index, start.heights, y - start.y, free, false);
        });
      }}
      onPointerUp={(e) => {
        if (drag.current?.pointer !== e.pointerId) return;
        finish(e.clientY, e.shiftKey);
        e.currentTarget.releasePointerCapture?.(e.pointerId);
      }}
      onLostPointerCapture={() => { if (drag.current) finish(null, true); }}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        const step = (e.shiftKey ? 96 : 24) * (e.key === 'ArrowDown' ? 1 : -1);
        moveEdgeBy(index, null, step, true, true);
      }}
    />
  </div>;
}

/**
 * One zone of the host: the widgets placed there, and a drop target of its own.
 *
 * It no longer renders the slot entries apart: a plugin widget is now placed
 * by the host, like the others, and painting it here as well would make it
 * appear twice.
 *
 * The drop target matters even when the zone is empty: without it a zone
 * emptied of every widget would offer nothing to drop on and become unreachable
 * for good. `hideWhenEmpty` is what keeps an untouched sidebar weightless while
 * still letting a drag reach it, since an empty zone reappears as an outline
 * for the length of the gesture.
 *
 * `orientation="horizontal"` lays the zone out as one line (the top bar): the
 * cards sit side by side at their natural width, without height, resize or
 * docking, and only a widget registered with `bar: true` is admitted.
 *
 * `compact` marks a narrow column (the product's sidebars): a widget that has a
 * compact form (`bar: true`) paints it there — its icons stacked — instead of
 * its card. Declared by whoever mounts the zone, never guessed from a width: a
 * rail that widens on hover must not switch a widget's form under the pointer.
 * A horizontal zone is always compact. Its shape is read from `data-compact`
 * and `data-orientation`, not painted as a label: the label said nothing the
 * zone's place on screen did not.
 */
export function WidgetZone({
  zone,
  slot,
  label,
  className,
  emptyClassName,
  hideWhenEmpty = false,
  revealWhenEditing = true,
  orientation = 'vertical',
  compact = false,
}: {
  /** Id the placements are written under. */
  zone: ZoneId;
  /** Slot whose admission rules govern the zone. */
  slot: string;
  label?: string;
  className?: string;
  /** Classes of the outline shown while empty during a drag. */
  emptyClassName?: string;
  hideWhenEmpty?: boolean;
  /** A collapsed nav rail has no room for an empty editing hint. */
  revealWhenEditing?: boolean;
  orientation?: WidgetOrientation;
  /** Narrow column: widgets with a compact form paint it rather than their card. */
  compact?: boolean;
}) {
  const { widgetsOf, registerZone, dragging, editing, accepts, onShares, widget } =
    useWidgetHost();
  const mobile = useMobile();
  const horizontal = orientation === 'horizontal';
  const definition = useMemo<WidgetZoneDef>(
    () => ({ id: zone, slot, label, ...(horizontal ? { orientation } : {}) }),
    [zone, slot, label, horizontal, orientation],
  );
  useEffect(() => registerZone(definition), [registerZone, definition]);

  const allowed = accepts(definition);
  const { setNodeRef, isOver } = useDroppable({ id: `zone:${zone}`, disabled: !allowed });
  const entries = widgetsOf(zone);
  const aside = useRef<HTMLElement | null>(null);
  const [zoneHeight, setZoneHeight] = useState(0);
  useEffect(() => {
    const el = aside.current;
    if (!el || horizontal || typeof ResizeObserver === 'undefined') return;
    const measure = () => setZoneHeight(el.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [horizontal]);

  const stacks = widgetStacks(entries);
  const head = (members: WidgetLayout[]) => members.find((w) => w.activeTab) ?? members[0]!;
  // A bare form (an icon column) keeps its natural height; every other card of
  // a column takes a share of what is left, and the shares always make 100 %.
  // "Your widget here" alone in its column keeps its own height, docked at
  // the bottom (`add-widget.ts`); beside other cards it takes its share.
  const docked = !horizontal && stacks.length === 1 && stacks[0]!.length === 1 && isAddWidgetPlaceholder(stacks[0]![0]!.id);
  const bare = (members: WidgetLayout[]) => horizontal || docked || (compact && members.length === 1 && widget(members[0]!.id)?.bar === true);
  const shared = horizontal ? [] : stacks.filter((members) => !bare(members));
  // Weights against each other, rescaled to 100 %: the card left alone when
  // its neighbour moves away fills the column instead of keeping its half.
  const parts = normalizedShares(shared.map((members) =>
    weightOf(head(members), Math.max(0, zoneHeight - CARD_GAP * (shared.length - 1)))));
  const fillsHeight = shared.length > 0;
  const empty = entries.length === 0;

  /**
   * Moves the edge `index` (below the `index`-th shared card) by `delta` px,
   * from the heights measured when the gesture began (`start`, or measured
   * now). Writes every share of the column, so a column saved with heights of
   * its own comes out of its first drag shared at exactly 100 %. Returns the
   * heights it started from, `null` when the column cannot be measured.
   */
  const moveEdgeBy = useCallback((index: number, start: readonly number[] | null, delta: number, free: boolean, persist: boolean) => {
    const el = aside.current;
    if (!el) return null;
    const cards = Array.from(el.children).filter((c): c is HTMLElement => c instanceof HTMLElement && c.classList.contains('widget-frame'));
    const frames = shared.map((members) => cards.find((c) => c.dataset.widgetId === head(members).id));
    if (frames.some((c) => !c)) return null;
    const heights = start ?? frames.map((c) => c!.getBoundingClientRect().height);
    if (delta === 0 && start === null && !persist) return heights;
    const minimums = shared.map((members) => Math.max(...members.map((m) => widget(m.id)?.minHeight ?? 0)) + (members.length > 1 ? 46 : 0));
    const nextHeights = moveEdge(heights, minimums, index, delta, !free);
    const parts = sharesFromHeights(nextHeights);
    onShares(shared.map((members, i) => ({ id: head(members).id, percent: parts[i]! })), persist);
    return heights;
  }, [shared, widget, onShares]);

  if (hideWhenEmpty && empty && !dragging && (!editing || !revealWhenEditing)) return null;

  return (
    <aside
      data-widget-zone={zone}
      data-orientation={orientation}
      data-compact={horizontal || compact || undefined}
      ref={(node) => { setNodeRef(node); aside.current = node; }}
      aria-label={label}
      // The refusal shows BEFORE the drop: the zone greys out and takes the
      // not-allowed cursor as soon as the lifted widget has no place there, rather
      // than swallowing the gesture and undoing it afterwards.
      aria-disabled={dragging !== null && !allowed ? true : undefined}
      title={dragging !== null && !allowed ? t('widgets.notAllowed') : undefined}
      className={cn(
        className,
        'widget-zone gap-0',
        editing && empty && (horizontal
          ? 'h-9 min-w-9 items-center rounded-md border border-dashed border-border'
          : 'min-h-24 rounded-lg border border-dashed border-border'),
        hideWhenEmpty && empty && emptyClassName,
        dragging !== null && !allowed && 'cursor-not-allowed opacity-40',
        isOver && dragging && allowed && 'bg-primary/5',
      )}
    >
      {editing && empty && !dragging && (horizontal
        ? <p className="whitespace-nowrap px-2 text-[11px] text-muted-foreground">{t('widgets.dropHere')}</p>
        : <p className="p-3 text-center text-xs text-muted-foreground">{label} · {t('widgets.dropHere')}</p>)}
      <SortableContext items={entries.map((e) => e.id)} strategy={horizontal ? horizontalListSortingStrategy : verticalListSortingStrategy}>
        {docked && <div aria-hidden data-add-widget-spacer className="min-h-0 flex-1" />}
        {stacks.map((members) => {
          const sharedIndex = shared.indexOf(members);
          return (
            <Fragment key={members[0]!.group ?? members[0]!.id}>
              <WidgetInsertion id={members[0]!.id} zone={zone} horizontal={horizontal} />
              <WidgetCard
                entry={head(members)}
                members={members}
                part={sharedIndex >= 0 ? parts[sharedIndex] : undefined}
                orientation={orientation}
                compact={horizontal || compact}
              />
              {!mobile && sharedIndex >= 0 && sharedIndex < shared.length - 1 && (
                <HeightEdge
                  index={sharedIndex}
                  label={t('widgets.resizeEdge', { above: widget(head(members).id)?.title ?? '', below: widget(head(shared[sharedIndex + 1]!).id)?.title ?? '' })}
                  moveEdgeBy={moveEdgeBy}
                />
              )}
            </Fragment>
          );
        })}
        <WidgetInsertion id={null} zone={zone} grow={!fillsHeight && !horizontal && !docked} horizontal={horizontal} />
      </SortableContext>
    </aside>
  );
}
