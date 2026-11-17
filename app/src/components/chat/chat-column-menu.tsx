'use client';

import { useCallback, useEffect, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent, type TouchEvent } from 'react';
import { ArrowLeftRight, Columns2, PanelLeftClose, PanelRightClose, Plus, X } from 'lucide-react';

import { t as i18n } from '@/lib/i18n';
import type { FileMenuItem } from './file-context-menu';
import type { ColumnSide } from './chat-columns';

/** What a column lets its menu do. Absent = the row is not offered. */
export type ColumnCommands = {
  side: ColumnSide;
  /** The column's zone, which is also its first tab: it cannot be closed. */
  zone: string;
  onAddTab?: () => void;
  onCloseTab?: (zone: string) => void;
  onAddColumn?: () => void;
  onRemoveColumn?: () => void;
  onSwap?: () => void;
  onCollapse?: () => void;
};

/**
 * The rows of the column menu opened on the tab `target`: "close" acts on that
 * tab, the rest on the column as a whole.
 */
export function columnMenuItems(c: ColumnCommands, target: string): FileMenuItem[] {
  const items: FileMenuItem[] = [];
  const iconClass = 'size-3.5';
  if (c.onAddTab) {
    items.push({ key: 'add-tab', label: i18n('chatPage.addColumnTab'), icon: <Plus className={iconClass} aria-hidden />, onSelect: c.onAddTab });
  }
  const closeTab = c.onCloseTab;
  if (closeTab && target !== c.zone) {
    items.push({ key: 'close-tab', label: i18n('chatPage.closeColumnTab'), title: i18n('chatPage.closeColumnTabHint'), icon: <X className={iconClass} aria-hidden />, onSelect: () => closeTab(target) });
  }
  if (c.onAddColumn) {
    items.push({ key: 'add-column', label: i18n('chatPage.addColumn'), title: i18n('chatPage.addColumnHint'), icon: <Columns2 className={iconClass} aria-hidden />, onSelect: c.onAddColumn });
  }
  if (c.onRemoveColumn) {
    items.push({ key: 'remove-column', label: i18n('chatPage.removeColumn'), title: i18n('chatPage.removeColumnHint'), icon: <X className={iconClass} aria-hidden />, onSelect: c.onRemoveColumn });
  }
  if (c.onSwap) {
    items.push({ key: 'swap', label: i18n('chatPage.swapColumns'), title: i18n('chatPage.swapColumnsHint'), icon: <ArrowLeftRight className={iconClass} aria-hidden />, onSelect: c.onSwap });
  }
  if (c.onCollapse) {
    const CollapseIcon = c.side === 'left' ? PanelLeftClose : PanelRightClose;
    items.push({ key: 'collapse', label: i18n('chatPage.collapseRail'), title: i18n('chatPage.collapseRailHint'), icon: <CollapseIcon className={iconClass} aria-hidden />, onSelect: c.onCollapse });
  }
  return items;
}

/** How long a finger rests on a tab before its menu opens, in ms. */
export const LONG_PRESS_MS = 500;
/** How far, in px, the finger may drift before the press stops being a press. */
const MAX_DRIFT = 8;
/**
 * After a long press or a key opened the menu, the browser may still send its
 * own `contextmenu` (Android on a long press, some keyboards on key up) and the
 * finger's click: both are the same gesture, not a new one.
 */
const ECHO_MS = 800;

type OpenMenu = (x: number, y: number) => void;

/**
 * The three ways to open a tab's menu, on the element that carries it: a right
 * click at the pointer, the Menu key or Shift+F10 under the element, a long
 * press for a finger (the drawer of narrow screens has no right click).
 */
export function useMenuPress(open: OpenMenu | undefined) {
  const press = useRef<{ id: number; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const openedAt = useRef(0);

  const cancel = useCallback(() => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);

  const belowElement = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.bottom };
  };

  if (!open) return {};
  return {
    'aria-haspopup': 'menu' as const,
    onContextMenu: (e: MouseEvent<HTMLElement>) => {
      e.preventDefault();
      e.stopPropagation();
      if (Date.now() - openedAt.current < ECHO_MS) return;
      // A keyboard-made event carries no pointer position on every browser.
      const p = e.clientX === 0 && e.clientY === 0 ? belowElement(e.currentTarget) : { x: e.clientX, y: e.clientY };
      open(p.x, p.y);
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
      e.preventDefault();
      openedAt.current = Date.now();
      const p = belowElement(e.currentTarget);
      open(p.x, p.y);
    },
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.pointerType === 'mouse') return;
      cancel();
      const { pointerId: id, clientX: x, clientY: y } = e;
      press.current = {
        id, x, y,
        timer: setTimeout(() => {
          press.current = null;
          openedAt.current = Date.now();
          open(x, y);
        }, LONG_PRESS_MS),
      };
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const a = press.current;
      if (a && a.id === e.pointerId && Math.hypot(e.clientX - a.x, e.clientY - a.y) > MAX_DRIFT) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    // The finger lifting after a long press is not a tap: no click, no
    // mouse events the browser would make up for it.
    onTouchEnd: (e: TouchEvent<HTMLElement>) => {
      if (Date.now() - openedAt.current < ECHO_MS) e.preventDefault();
    },
    onClickCapture: (e: MouseEvent<HTMLElement>) => {
      if (Date.now() - openedAt.current < ECHO_MS && press.current === null && e.detail > 0) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
  };
}
