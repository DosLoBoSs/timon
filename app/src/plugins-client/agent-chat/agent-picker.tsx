'use client';

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Search } from 'lucide-react';

import { t } from '@/lib/i18n';
import { compareText } from '@/lib/intl';
import { foldText } from '@/lib/multichat-rail';
import { cn } from '@/lib/utils';
import { FramedFace } from './agent-avatar';
import {
  findProject,
  agentFace,
  type PickableAgent,
  type KnownProject,
} from './use-agents';

/**
 * The agents a query finds, sorted by name. Every word of the query must appear
 * in the agent's name, its role, its project (slug and name) or its team —
 * accents and case ignored, as in the Multichat search. Ephemeral agents are
 * one-shot missions, never something to keep a shortcut to.
 */
export function filterAgents(
  agents: readonly PickableAgent[],
  projects: readonly KnownProject[],
  query: string,
): PickableAgent[] {
  const words = foldText(query).split(/\s+/).filter(Boolean);
  return agents
    .filter((a) => !a.ephemeral)
    .filter((a) => {
      if (words.length === 0) return true;
      const project = findProject(projects, a.project);
      const haystack = foldText([a.name, a.role ?? '', a.project ?? '', project?.name ?? '', a.team ?? ''].join(' '));
      return words.every((word) => haystack.includes(word));
    })
    .sort((a, b) => compareText(a.name, b.name));
}

/**
 * A search field over the installed agents, with its list: the one way to add
 * an agent to a card, from its config or from the "+" at the end of its row.
 *
 * Agents already on the card stay listed, greyed and out of reach, so a search
 * for one says "already there" instead of "not found".
 *
 * `open` keeps the list visible (the "+" popover, which exists only to
 * pick); without it the list opens as the field is focused or typed into.
 */
export function AgentPicker({
  agents,
  projects,
  excluded,
  onPick,
  onEscape,
  open: alwaysOpen = false,
  autoFocus = false,
}: {
  agents: readonly PickableAgent[];
  projects: readonly KnownProject[];
  /** Lower-cased names of the agents already on the card. */
  excluded: ReadonlySet<string>;
  onPick: (agent: string) => void;
  /** Escape on a closed list (or on the always-open one): the host closes. */
  onEscape?: () => void;
  open?: boolean;
  autoFocus?: boolean;
}) {
  const id = useId();
  const listId = `${id}-list`;
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [active, setActive] = useState(-1);
  const visible = alwaysOpen || expanded;

  const candidates = useMemo(() => filterAgents(agents, projects, query), [agents, projects, query]);
  const pickable = (i: number) => {
    const a = candidates[i];
    return a !== undefined && !excluded.has(a.name.toLowerCase());
  };

  // A new query, or the list reloaded: the first agent one can add is the one
  // Enter adds.
  useEffect(() => {
    setActive(candidates.findIndex((a) => !excluded.has(a.name.toLowerCase())));
  }, [candidates, excluded]);

  useEffect(() => {
    if (autoFocus) field.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    if (!visible || active < 0) return;
    const option = list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    // Absent from jsdom; the list still works without it.
    option?.scrollIntoView?.({ block: 'nearest' });
  }, [active, visible]);

  const pick = (i: number) => {
    const a = candidates[i];
    if (!a || !pickable(i)) return;
    onPick(a.name);
    setQuery('');
  };

  // Next option one can add, `pas` away, wrapping; greyed ones are skipped.
  const next = (from: number, step: 1 | -1): number => {
    const n = candidates.length;
    for (let k = 1; k <= n; k += 1) {
      const i = (((from + step * k) % n) + n) % n;
      if (pickable(i)) return i;
    }
    return -1;
  };

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        if (!visible) { setExpanded(true); return; }
        const step: 1 | -1 = e.key === 'ArrowDown' ? 1 : -1;
        // From nowhere, Down lands on the first option and Up on the last.
        setActive((i) => next(i >= 0 ? i : step === 1 ? -1 : 0, step));
        return;
      }
      case 'Enter':
        // Never the form's submit: in the config, Enter here means "add",
        // not "save the card with half a search typed in".
        e.preventDefault();
        if (visible) pick(active);
        return;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        if (!alwaysOpen && expanded) setExpanded(false);
        else onEscape?.();
        return;
      case 'Tab':
        setExpanded(false);
        return;
      default:
        return;
    }
  };

  const optionId = (i: number) => `${id}-option-${i}`;

  return (
    <div className="flex flex-col gap-1">
      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
        <input
          ref={field}
          type="text"
          role="combobox"
          aria-expanded={visible}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={visible && active >= 0 ? optionId(active) : undefined}
          aria-label={t('agentChat.picker.label')}
          placeholder={t('agentChat.picker.placeholder')}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setExpanded(true); }}
          onFocus={() => setExpanded(true)}
          onBlur={() => setExpanded(false)}
          onClick={() => setExpanded(true)}
          onKeyDown={handleKey}
          className="w-full rounded-lg border border-border bg-background/60 py-1.5 pl-8 pr-2.5 text-[12px] outline-none focus:border-primary/60"
        />
      </div>
      {visible && (
        <ul
          ref={list}
          id={listId}
          role="listbox"
          aria-label={t('agentChat.picker.label')}
          className={cn(
            'scrollbar-thin flex max-h-56 flex-col gap-px overflow-y-auto',
            // In the popover the list already sits in a framed box.
            alwaysOpen ? 'p-0.5' : 'rounded-lg border border-border bg-popover p-1',
          )}
        >
          {candidates.length === 0 ? (
            <li role="presentation" className="px-2 py-1.5 text-[11.5px] text-muted-foreground/80">
              {t('agentChat.picker.empty')}
            </li>
          ) : (
            candidates.map((a, i) => {
              const isExcluded = excluded.has(a.name.toLowerCase());
              const project = findProject(projects, a.project);
              return (
                <li
                  key={a.name}
                  id={optionId(i)}
                  data-index={i}
                  role="option"
                  aria-selected={i === active}
                  aria-disabled={isExcluded || undefined}
                  // Keeps the focus in the field: a click must not blur it
                  // (and close the list) before it lands.
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => { if (!isExcluded && i !== active) setActive(i); }}
                  onClick={() => pick(i)}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px]',
                    isExcluded ? 'cursor-default opacity-45' : 'cursor-pointer',
                    i === active && 'bg-primary/15 text-foreground',
                  )}
                >
                  <FramedFace visage={agentFace(a.name, agents, projects)} className="size-6" glyphClassName="text-[10px]" />
                  <span className="min-w-0 flex-1 truncate">{a.name}</span>
                  <span className="max-w-[45%] shrink-0 truncate text-[10.5px] text-muted-foreground/75">
                    {isExcluded ? t('agentChat.picker.onCard') : (project?.name || a.project || '')}
                  </span>
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}
