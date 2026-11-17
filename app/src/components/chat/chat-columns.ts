/**
 * Physical order and visibility of the chat columns.
 *
 * Until now, "left" and "right" were not data: the `chat.left.widget` zone was
 * glued to a hard-coded `left-…` and the `chat.right.widget` zone to a
 * `right-…`, so swapping the two sidebars meant editing the page CSS. This
 * module makes the order a layout property (a list of zones, from leftmost to
 * rightmost) and collapsing a property of the collapsed column, not of the
 * missions rail alone.
 *
 * Pure model: it reads and writes nothing. Persistence goes through the
 * existing `loadLayout` / `saveLayout`, on their own `scope` (§10.12, part 6):
 * card placement and column order are two values with different lives (the
 * first changes at every drag, the second almost never), and mixing them would
 * force two shapes to live in the same opaque JSON, hence a migration for
 * nothing.
 */

import type { LayoutIo } from '@/lib/ui-layout-store';

export type ChatColumns = {
  /** Zones, from leftmost to rightmost. */
  ordre: string[];
  /** Zones the user collapsed. A collapsed zone keeps its place. */
  masquees: string[];
  /**
   * A column's tabs beyond the first, by column zone. The first tab IS the
   * column's zone: placements written before tabs existed stay there with no
   * migration. Absent = a single tab, so the stored value of a user who never
   * opens one does not change by a byte.
   */
  onglets?: Record<string, string[]>;
  /** Tab shown by a column, when it is not the first. */
  actifs?: Record<string, string>;
  /**
   * Width chosen by the user, in px, by shown zone (a column, or the tab shown
   * as its second column). Absent = the default width of its side.
   */
  largeurs?: Record<string, number>;
  /**
   * The tab a column shows BESIDE itself, by column zone. A second column is a
   * tab, not a zone of its own: when the screen is too narrow it folds back
   * into the tab bar, cards and placement included, with nothing to migrate.
   */
  secondes?: Record<string, string>;
  /**
   * Label the user (or an applied proposal) gave a tab, by zone. Absent = the
   * tab shows no text, as before names existed.
   */
  noms?: Record<string, string>;
  /**
   * Width of the thread's reading column chosen by the user, in px (text
   * only, gutters excluded). Absent = it follows the room the chat has.
   */
  fil?: number;
};

/** Narrowest reading column the user can drag the thread to. */
export const THREAD_READING_MIN = 420;
/** Widest one, whatever the screen: past it a line no longer reads. */
export const THREAD_READING_MAX = 2400;

export function clampThreadWidth(width: number): number {
  return Math.round(Math.min(THREAD_READING_MAX, Math.max(THREAD_READING_MIN, width)));
}

/** Sets the reading column's width, clamped; `null` goes back to the room the chat has. */
export function setThreadWidth(c: ChatColumns, width: number | null): ChatColumns {
  return withPatch(c, { fil: width === null || !Number.isFinite(width) ? undefined : clampThreadWidth(width) });
}

/** Longest tab name: a tab is a narrow pill. */
export const TAB_NAME_MAX = 40;

/** Trimmed, inner spaces folded, capped; empty = no name. */
function readName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const name = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().replace(/\s+/g, ' ').slice(0, TAB_NAME_MAX);
  return name || null;
}

/** Physical side of a column: what the page chrome makes of it. */
export type ColumnSide = 'left' | 'right';

/** The `ui_layout` scope where the column order is persisted. */
export const CHAT_COLUMNS_SCOPE = 'chat.columns';

/**
 * The `ui_layout` accessors for the columns.
 *
 * `storage: null` turns off picking up the layout left in `localStorage`: it
 * only knows one key, the cockpit's, and would write it here as a column
 * order; a card placement would become the column positions.
 */
export function columnsIo(io: LayoutIo = {}): LayoutIo {
  return { ...io, scope: CHAT_COLUMNS_SCOPE, storage: null };
}

/** Original order: the zones in the order the caller declares them. */
export function defaultColumns(known: readonly string[]): ChatColumns {
  return { ordre: [...known], masquees: [] };
}

/**
 * Separator between a column's zone and the suffix of its tabs.
 *
 * A tab is a widget zone in its own right (`chat.right.widget#k3x`), governed
 * by its column's slot: that is what lets the host place, drag and persist its
 * cards without knowing tabs exist.
 */
const TAB_SEPARATOR = '#';

/** Zone of the column a tab belongs to — itself for the first tab. */
export function columnZoneOf(zone: string): string {
  const i = zone.indexOf(TAB_SEPARATOR);
  return i < 0 ? zone : zone.slice(0, i);
}

function isTabOf(zone: string, column: string): boolean {
  return zone.startsWith(column + TAB_SEPARATOR) && zone.length > column.length + 1;
}

/**
 * Copies, emitting tabs only when there are some: a column back to a single
 * tab regains exactly the shape it had before tabs existed.
 */
function withPatch(
  c: ChatColumns,
  patch: Partial<ChatColumns>,
): ChatColumns {
  const next = { ...c, ...patch };
  const tabs: Record<string, string[]> = {};
  for (const [column, list] of Object.entries(next.onglets ?? {})) {
    if (list.length > 0) tabs[column] = [...list];
  }
  const active: Record<string, string> = {};
  for (const [column, zone] of Object.entries(next.actifs ?? {})) {
    if (tabs[column]?.includes(zone)) active[column] = zone;
  }
  const seconds: Record<string, string> = {};
  for (const [column, zone] of Object.entries(next.secondes ?? {})) {
    if (tabs[column]?.includes(zone)) seconds[column] = zone;
  }
  // A width outlives nothing it measured: a closed tab takes its own along.
  const zones = new Set(next.ordre.flatMap((column) => [column, ...(tabs[column] ?? [])]));
  const widths: Record<string, number> = {};
  for (const [zone, width] of Object.entries(next.largeurs ?? {})) {
    if (zones.has(zone) && typeof width === 'number' && Number.isFinite(width)) {
      widths[zone] = clampWidth(width);
    }
  }
  // A name, like a width, leaves with its tab.
  const names: Record<string, string> = {};
  for (const [zone, raw] of Object.entries(next.noms ?? {})) {
    const name = readName(raw);
    if (zones.has(zone) && name) names[zone] = name;
  }
  const out: ChatColumns = { ordre: [...next.ordre], masquees: [...next.masquees] };
  if (Object.keys(tabs).length > 0) out.onglets = tabs;
  if (Object.keys(active).length > 0) out.actifs = active;
  if (Object.keys(widths).length > 0) out.largeurs = widths;
  if (Object.keys(seconds).length > 0) out.secondes = seconds;
  if (Object.keys(names).length > 0) out.noms = names;
  if (typeof next.fil === 'number' && Number.isFinite(next.fil)) out.fil = clampThreadWidth(next.fil);
  return out;
}

function stringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Reads the stored value back, checking it against the zones the page mounts.
 *
 * Tolerant by construction, like `mergeLayout`: an unknown zone is ignored
 * (rename, missing plugin), a known zone missing from storage is added at its
 * original place, and a duplicate counts once. An unreadable value is thus
 * never a broken page, only a return to the defaults.
 */
export function readColumns(raw: unknown, known: readonly string[]): ChatColumns {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const allowed = new Set(known);
  const seen = new Set<string>();

  const order: string[] = [];
  for (const zone of stringList(o.ordre)) {
    if (!allowed.has(zone) || seen.has(zone)) continue;
    seen.add(zone);
    order.push(zone);
  }
  for (const zone of known) if (!seen.has(zone)) order.push(zone);

  const collapsed = [...new Set(stringList(o.masquees).filter((z) => allowed.has(z)))];

  // A tab is only admitted under its own column: an id naming the other
  // column would show its cards in two places.
  const rawTabs = typeof o.onglets === 'object' && o.onglets !== null
    ? (o.onglets as Record<string, unknown>) : {};
  const tabs: Record<string, string[]> = {};
  for (const column of known) {
    tabs[column] = [...new Set(stringList(rawTabs[column]).filter((z) => isTabOf(z, column)))];
  }
  const rawActive = typeof o.actifs === 'object' && o.actifs !== null
    ? (o.actifs as Record<string, unknown>) : {};
  const active: Record<string, string> = {};
  for (const column of known) {
    const zone = rawActive[column];
    if (typeof zone === 'string') active[column] = zone;
  }
  const rawSeconds = typeof o.secondes === 'object' && o.secondes !== null
    ? (o.secondes as Record<string, unknown>) : {};
  const seconds: Record<string, string> = {};
  for (const column of known) {
    const zone = rawSeconds[column];
    if (typeof zone === 'string') seconds[column] = zone;
  }
  const rawWidths = typeof o.largeurs === 'object' && o.largeurs !== null
    ? (o.largeurs as Record<string, unknown>) : {};
  const widths: Record<string, number> = {};
  for (const [zone, width] of Object.entries(rawWidths)) {
    if (typeof width === 'number') widths[zone] = width;
  }
  const rawNames = typeof o.noms === 'object' && o.noms !== null
    ? (o.noms as Record<string, unknown>) : {};
  const names: Record<string, string> = {};
  for (const [zone, raw] of Object.entries(rawNames)) {
    const name = readName(raw);
    if (name) names[zone] = name;
  }
  return withPatch({ ordre: order, masquees: collapsed }, { onglets: tabs, actifs: active, secondes: seconds, largeurs: widths, noms: names, ...(typeof o.fil === 'number' ? { fil: o.fil } : {}) });
}

/** Names a tab (the first included); `null` or an empty name removes it. */
export function nameTab(c: ChatColumns, zone: string, name: string | null): ChatColumns {
  const names = { ...c.noms };
  const clean = readName(name);
  if (clean) names[zone] = clean;
  else delete names[zone];
  return withPatch(c, { noms: names });
}

/**
 * Reverses the physical order of the columns.
 *
 * Collapsing follows the ZONE, not the side: a column collapsed then swapped
 * stays collapsed. It is the card that was put away, not half of the screen.
 */
export function swapColumns(c: ChatColumns): ChatColumns {
  return withPatch(c, { ordre: [...c.ordre].reverse() });
}

export function isCollapsed(c: ChatColumns, zone: string): boolean {
  return c.masquees.includes(zone);
}

/** Collapses an expanded column, expands a collapsed one. */
export function toggleCollapsed(c: ChatColumns, zone: string): ChatColumns {
  return setCollapsed(c, zone, !isCollapsed(c, zone));
}

/**
 * `zone` folded or unfolded, whatever the columns say now: a click once
 * decided. Replayed over another window's write (TODO #647), a toggle would
 * undo the very click it stands for.
 */
export function setCollapsed(c: ChatColumns, zone: string, collapsed: boolean): ChatColumns {
  const others = c.masquees.filter((z) => z !== zone);
  if (collapsed === isCollapsed(c, zone)) return c;
  return withPatch(c, { masquees: collapsed ? [...others, zone] : others });
}

/**
 * Side of a column, derived from its rank. The chat has two: the first is on
 * the left, everything else on the right, and `null` for a zone that is not a
 * column, for which the chrome must reserve nothing.
 */
export function sideOf(c: ChatColumns, zone: string): ColumnSide | null {
  const i = c.ordre.indexOf(zone);
  if (i < 0) return null;
  return i === 0 ? 'left' : 'right';
}

/** Zone holding a side, or `null` if the order does not count that many. */
export function zoneOfSide(c: ChatColumns, side: ColumnSide): string | null {
  return (side === 'left' ? c.ordre[0] : c.ordre[1]) ?? null;
}

/** A column's tabs, in order: its own zone first. */
export function tabsOf(c: ChatColumns, column: string): string[] {
  return [column, ...(c.onglets?.[column] ?? [])];
}

/** Zone a column shows: the chosen tab, otherwise the first. */
export function activeTab(c: ChatColumns, column: string): string {
  const chosen = c.actifs?.[column];
  return chosen && tabsOf(c, column).includes(chosen) ? chosen : column;
}

/**
 * Opens a tab at the end of the column and shows it.
 *
 * The suffix comes from the caller and must never be reused: a closed tab can
 * leave behind the placement of an absent plugin, which the host keeps as is.
 * A new tab taking over its id would bring that card back inside it when the
 * plugin returns.
 */
export function addTab(c: ChatColumns, column: string, suffix: string): ChatColumns {
  const zone = `${column}${TAB_SEPARATOR}${suffix}`;
  if (!c.ordre.includes(column) || !isTabOf(zone, column) || tabsOf(c, column).includes(zone)) return withPatch(c, {});
  return withPatch(c, {
    onglets: { ...c.onglets, [column]: [...(c.onglets?.[column] ?? []), zone] },
    actifs: { ...c.actifs, [column]: zone },
  });
}

/** Shows a tab of the column. A zone that is not one of its tabs changes nothing. */
export function selectTab(c: ChatColumns, column: string, zone: string): ChatColumns {
  if (!tabsOf(c, column).includes(zone)) return withPatch(c, {});
  const active = { ...c.actifs };
  if (zone === column) delete active[column];
  else active[column] = zone;
  return withPatch(c, { actifs: active });
}

/**
 * Closes a tab. The first one cannot be closed: it is the column. Closing the
 * shown tab shows the one before it.
 *
 * What the tab held is not this model's business: the caller pours its cards
 * into the first tab before closing it.
 */
export function removeTab(c: ChatColumns, column: string, zone: string): ChatColumns {
  const list = c.onglets?.[column] ?? [];
  const i = list.indexOf(zone);
  if (i < 0) return withPatch(c, {});
  const rest = list.filter((z) => z !== zone);
  const active = { ...c.actifs };
  if (activeTab(c, column) === zone) {
    const previous = i > 0 ? list[i - 1]! : column;
    if (previous === column) delete active[column];
    else active[column] = previous;
  }
  return withPatch(c, { onglets: { ...c.onglets, [column]: rest }, actifs: active });
}

/** Narrowest a column gets: below this, the cards stop reading. */
export const WIDTH_MIN = 240;
/** Widest a column gets, whatever the screen. */
export const WIDTH_MAX = 800;
/** Default width of a second column. */
export const SECOND_COLUMN_WIDTH = 300;

export function clampWidth(width: number): number {
  return Math.round(Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, width)));
}

/**
 * Where a column and its mirror land for a gesture that asks `wanted` for the
 * column. Both move by the same amount, held by whichever bound comes first:
 * the room left is shared by two columns growing at once.
 */
export function pairedWidths(
  start: number, wanted: number, max: number, twin: { width: number; max: number },
): { width: number; twin: number } {
  const min = Math.min(WIDTH_MIN, max);
  const growMax = Math.max(0, Math.min((max - start) / 2, twin.max - twin.width));
  const shrinkMax = Math.max(0, Math.min(start - min, twin.width - Math.min(WIDTH_MIN, twin.max)));
  const delta = Math.max(-shrinkMax, Math.min(growMax, wanted - start));
  return { width: Math.round(start + delta), twin: Math.round(twin.width + delta) };
}

/** Width chosen for a shown zone, otherwise the default of its place. */
export function widthOf(c: ChatColumns, zone: string, fallback: number): number {
  return c.largeurs?.[zone] ?? fallback;
}

/**
 * Sets the width of a shown zone, clamped. `null` goes back to the default:
 * the entry is dropped rather than written with the default value, so that a
 * default that changes later still applies.
 */
export function setWidth(c: ChatColumns, zone: string, width: number | null): ChatColumns {
  const widths = { ...c.largeurs };
  if (width === null || !Number.isFinite(width)) delete widths[zone];
  else widths[zone] = clampWidth(width);
  return withPatch(c, { largeurs: widths });
}

/** The tab a column shows beside itself, if any. */
export function secondOf(c: ChatColumns, column: string): string | null {
  const zone = c.secondes?.[column];
  return zone && tabsOf(c, column).includes(zone) ? zone : null;
}

/**
 * Opens a second column beside a column: a new tab, shown beside it rather
 * than in its place. The tab shown in the column does not change. A column has
 * at most one second column; asking again changes nothing.
 *
 * Same rule for the suffix as `addTab`: never reused.
 */
export function addSecond(c: ChatColumns, column: string, suffix: string): ChatColumns {
  if (secondOf(c, column) !== null) return withPatch(c, {});
  const zone = `${column}${TAB_SEPARATOR}${suffix}`;
  const opened = addTab(c, column, suffix);
  if (!tabsOf(opened, column).includes(zone)) return opened;
  return withPatch(opened, {
    actifs: c.actifs,
    secondes: { ...c.secondes, [column]: zone },
  });
}

/**
 * Puts a second column back among the column's tabs. Nothing is lost: the tab
 * keeps its cards and stays reachable from the tab bar.
 */
export function detachSecond(c: ChatColumns, column: string): ChatColumns {
  const seconds = { ...c.secondes };
  delete seconds[column];
  return withPatch(c, { secondes: seconds });
}

/** Room the thread keeps, whatever the columns ask for. */
export const THREAD_MIN = 480;
/** Gap between a column and the screen edge, or the thread on the left. */
const EDGE = 16;
/** Gap between two columns of a side, and between the column and the thread on the right. */
const GAP = 12;

/** What a side asks for, before the screen has its say. */
export type SideRequest = {
  /** Width of the column itself. */
  width: number;
  /** Whether the column itself is shown (it may be empty outside a drag). */
  first: boolean;
  /** Width of its second column, or `null` when none is shown. */
  second: number | null;
};

/** What a side gets: widths actually painted, `null` for a column not shown. */
export type SidePlacement = {
  first: number | null;
  second: number | null;
  /** The second column was asked for but folded back into the tabs. */
  secondFolded: boolean;
  /** Distance of the second column from the screen edge, in px. */
  secondOffset: number;
  /** Width the thread reserves for this side, in px (nav excluded). */
  gutter: number;
};

export type RailsPlan = {
  left: SidePlacement | null;
  right: SidePlacement | null;
  /** Room still free beyond the thread's minimum, in px. */
  slack: number;
};

function widthsOf(p: Pick<SidePlacement, 'first' | 'second'>): number[] {
  return [p.first, p.second].filter((w): w is number => w !== null);
}

function gutterOf(side: ColumnSide, widths: number[]): number {
  if (widths.length === 0) return 0;
  const sum = widths.reduce((a, b) => a + b, 0) + GAP * (widths.length - 1);
  // Left: the figures the fixed classes used to carry (280 → 312, 300 → 332).
  // Right: the thread's scroll zone sits above the columns (`z-10`), so the
  // gutter must clear the width handle past the column's edge — the old 312
  // let the thread overlap the column by 4px; it is 328 now.
  return side === 'left' ? EDGE + sum + EDGE : EDGE + sum + GAP;
}

function place(side: ColumnSide, p: Pick<SidePlacement, 'first' | 'second' | 'secondFolded'>): SidePlacement {
  return {
    ...p,
    secondOffset: p.first === null ? 0 : p.first + GAP,
    gutter: gutterOf(side, widthsOf(p)),
  };
}

/**
 * Lays the columns out on the width the chat has.
 *
 * The thread keeps `THREAD_MIN`. When the columns ask for more, the second
 * columns fold back into their tabs first — the widest side first — then the
 * widths shrink in proportion, never below `WIDTH_MIN`. `available <= 0`
 * means not measured yet: everything is shown as asked.
 */
export function planRails(
  available: number,
  left: SideRequest | null,
  right: SideRequest | null,
): RailsPlan {
  const sides: Array<[ColumnSide, SideRequest | null]> = [['left', left], ['right', right]];
  const placements = new Map<ColumnSide, SidePlacement>();
  for (const [side, d] of sides) {
    if (d) placements.set(side, place(side, {
      first: d.first || d.second === null ? d.width : null,
      second: d.second,
      secondFolded: false,
    }));
  }
  const used = () => [...placements.values()].reduce((a, p) => a + p.gutter, 0);
  const free = () => available - THREAD_MIN - used();
  const measured = available > 0;

  while (measured && free() < 0) {
    const withSecond = [...placements.entries()]
      .filter(([, p]) => p.second !== null)
      .sort(([, a], [, b]) => b.gutter - a.gutter);
    const widest = withSecond[0];
    if (!widest) break;
    const [side] = widest;
    const d = side === 'left' ? left! : right!;
    placements.set(side, place(side, { first: d.width, second: null, secondFolded: true }));
  }

  if (measured && free() < 0) {
    const all = [...placements.values()].flatMap(widthsOf);
    const sum = all.reduce((a, b) => a + b, 0);
    const factor = sum > 0 ? Math.max(0, (sum + free()) / sum) : 1;
    const shrink = (w: number | null) => w === null ? null : Math.max(WIDTH_MIN, Math.floor(w * factor));
    for (const [side, p] of placements) {
      placements.set(side, place(side, { ...p, first: shrink(p.first), second: shrink(p.second) }));
    }
  }

  return {
    left: placements.get('left') ?? null,
    right: placements.get('right') ?? null,
    slack: measured ? Math.max(0, free()) : Number.POSITIVE_INFINITY,
  };
}

/** Below this width the columns stop floating beside the thread: each one
 *  becomes a panel of the chat's island, opened on demand. The same breakpoint
 *  as `lg`, which used to hide them outright. */
export const DRAWER_BREAKPOINT = 1024;

/**
 * Whether the chat, `width` px wide (nav included), shows its columns as
 * panels. Unmeasured (0) is not narrow: the first paint keeps the floating
 * columns, which CSS hides on a small screen until the measure lands.
 */
export function showsDrawers(width: number): boolean {
  return width > 0 && width < DRAWER_BREAKPOINT;
}
