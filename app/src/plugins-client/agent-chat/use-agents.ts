'use client';

import { useEffect, useState } from 'react';

import { logoFallbackFor, logoUrlFor } from '@/app/multichat/types';
import { isIconUrl } from '@/lib/project-visual';
import { avatarModeOf, lookOfAgent } from '@/components/agent-avatar';
import type { AgentLook } from '@/components/mascot/agent-look';

/** What the card needs of an agent: how to name it, how to picture it, and
 *  what to search it by. */
export type PickableAgent = {
  name: string;
  icon_url?: string | null;
  emoji?: string | null;
  color?: string | null;
  role?: string | null;
  project?: string | null;
  team?: string | null;
  ephemeral?: boolean;
  /** Mascot look and picked head (`config.look`, `config.avatar`), as the daemon lists them. */
  look?: unknown;
  avatar?: unknown;
};

/** What the card needs of a project: an agent without an icon of its own
 *  wears its project's, as it does in Multichat. */
export type KnownProject = {
  slug: string;
  name?: string;
  icon?: string | null;
  color?: string;
};

/** One-shot fetch of a list the card only borrows from. A failure is an empty
 *  list: the card falls back to initials, it never waits on the daemon. */
function useList<T>(url: string, key: string): T[] {
  const [list, setList] = useState<T[]>([]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await fetch(url, { cache: 'no-store' });
        if (!r.ok) return;
        const j = (await r.json()) as Record<string, unknown>;
        const value = j[key];
        if (alive && Array.isArray(value)) setList(value as T[]);
      } catch {
        // Daemon unreachable: initials instead of icons, free typing instead
        // of a list.
      }
    })();
    return () => { alive = false; };
  }, [url, key]);

  return list;
}

/**
 * The installed agents, fetched once per mount.
 *
 * The list is only there to *choose* from and to borrow an avatar: a card whose
 * agent has since been deleted keeps showing its thread — the chat says what it
 * has to say about a missing agent far better than a widget that would blank
 * itself on a slow fetch.
 */
export function useAgents(): PickableAgent[] {
  return useList<PickableAgent>('/api/ui/agents', 'agents');
}

/** The projects, for the icon an agent borrows from its own. */
export function useProjects(): KnownProject[] {
  return useList<KnownProject>('/api/ui/projects', 'projects');
}

/** Agent record matching a configured name. Agent names are compared without
 *  case: `Alice.main` and `alice.main` are the same agent on disk. */
export function findAgent(
  agents: readonly PickableAgent[],
  name: string,
): PickableAgent | undefined {
  const target = name.toLowerCase();
  return agents.find((a) => a.name.toLowerCase() === target);
}

export function findProject(
  projects: readonly KnownProject[],
  slug: string | null | undefined,
): KnownProject | undefined {
  if (!slug) return undefined;
  const target = slug.toLowerCase();
  return projects.find((p) => p.slug.toLowerCase() === target);
}

/** How an agent is pictured: an image, its mascot, or a glyph in a colour. */
export type Visage = { image: string | null; glyphe: string; couleur: string; look?: AgentLook | null };

/**
 * The avatar of an agent, resolved the way Multichat resolves it
 * (`logoUrlFor` / `logoFallbackFor`): its own icon, else its project's, else
 * its emoji or initial. `explicit` is the image the daemon wrote on the card
 * itself at onboarding, which wins.
 */
export function agentFace(
  name: string,
  agents: readonly PickableAgent[],
  projects: readonly KnownProject[],
  explicit?: string,
): Visage {
  const agent = findAgent(agents, name);
  const project = findProject(projects, agent?.project);
  const own = explicit && isIconUrl(explicit) ? explicit : null;
  const color = agent?.color || project?.color || 'hsl(var(--primary))';
  // The head the agent picked (docs/AGENT-AVATAR.md), unless the card carries
  // its own photo. Without a pick, or without the pick's setting, this view's
  // order stays as it was: no agent changes face here by itself.
  if (agent && !explicit) {
    const mode = avatarModeOf(agent.avatar);
    const look = lookOfAgent(agent);
    const glyph = logoFallbackFor(agent, undefined);
    if (mode === 'mascot' && look) return { image: null, glyphe: glyph, couleur: color, look };
    if (mode === 'emoji' && agent.emoji?.trim()) return { image: null, glyphe: agent.emoji.trim(), couleur: color };
    if (mode === 'image' && agent.icon_url && isIconUrl(agent.icon_url)) return { image: agent.icon_url, glyphe: glyph, couleur: color };
  }
  return {
    image: own || logoUrlFor(agent, project),
    // A customised photo can be an emoji: it stands in for the glyph.
    glyphe: explicit && !own ? explicit : logoFallbackFor(agent ?? { name }, project),
    couleur: color,
  };
}
