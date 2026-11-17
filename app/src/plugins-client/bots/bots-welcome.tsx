'use client';

/**
 * The main agent's welcome, on the TIMs page (the maintainer's decision of 05/11/2026,
 * docs/ONBOARDING-AGENT-CHAT.md). Right after the onboarding the person lands
 * here, the main TIM selected, and it speaks first in its own conversation:
 * the setup mission (origin `setup`, the authority of the `setup_*` tools),
 * whose bootstrap turn stays out of the transcript (`ChatClient setup`). The
 * skill `timon-main-agent-setup` drives it, `setup_finish` ends it, and the
 * conversation stays on screen afterwards: the TIM is still there to talk to.
 *
 * The page decides when this replaces the plain chat (`bots-page.tsx`); this
 * module starts or resumes the conversation (`useSetupChat`) once it is on
 * screen — the page may be mounted in a hidden island tab or a background
 * window, and a mission is not spent on a welcome nobody sees — lifts the
 * loader on the agent's first words, and keeps a way out: "Skip the welcome",
 * quiet while it goes well, a warning when the conversation is stuck.
 *
 * A later visit, the welcome over, reopens that conversation as it ended
 * (`useEndedWelcome`) while it is still the TIM's latest: the plain chat leaves
 * setup conversations out, and the TIM would seem to have forgotten it.
 */
import { useEffect, useRef, useState, type ComponentType, type ReactElement, type RefObject } from 'react';
import dynamic from 'next/dynamic';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ProviderCliCards } from '@/components/provider-cli/provider-cli-cards';
import { stepHref } from '@/components/onboarding/onboarding-flow';
import type { Fetcher } from '@/components/onboarding/agent-create';
import { useSetupChat, type SetupChat } from '@/components/onboarding/setup-chat';
import { welcomeSkipped } from '@/components/onboarding/setup-entry';
import type { SetupChatSignal } from '@/components/onboarding/setup-trouble';
import { t } from '@/lib/i18n';
import { settingsPath } from '@/lib/settings-path';

/** What the welcome hands the conversation. The product's is `ChatClient` (below); a test passes its own. */
export type WelcomeConversationProps = {
  agent: string;
  missionId: string;
  onAgentSpoke: () => void;
  onSetupTrouble: (signal: SetupChatSignal) => void;
};

// Loaded on demand, like the page's own chat.
const ProductConversation = dynamic(
  () => import('@/app/chat/chat-client').then((m) => {
    function WelcomeConversation(props: WelcomeConversationProps): ReactElement {
      return (
        <m.ChatClient
          forcedAgent={props.agent}
          forcedMission={props.missionId}
          compact
          chromeComplet
          setup
          onAgentSpoke={props.onAgentSpoke}
          onSetupTrouble={props.onSetupTrouble}
        />
      );
    }
    return WelcomeConversation;
  }),
  { ssr: false },
);

/** The main TIM's welcome conversation, over: what a later visit reopens. */
export type EndedWelcome = { agent: string; missionId: string };

/**
 * Which chat the page shows for the selected TIM, pure: the welcome for the
 * main TIM while the daemon holds it (`mainAgentOnboarding`), and for the rest
 * of the visit once it was on screen — the plain chat leaves the setup
 * conversation out, and the TIM would seem to forget what it just said. A
 * later visit shows that conversation as it ended (`ended`) while it is the
 * TIM's latest. `hold`: capabilities not read yet, or the ended welcome still
 * looked up (`ended` undefined), the main TIM's chat waits rather than flash
 * the wrong conversation first.
 */
export function botsChatMode(input: {
  selected: string | null;
  main: string | null;
  caps: { firstRun?: boolean; mainAgentOnboarding?: boolean } | null;
  welcomeAgent: string | null;
  ended?: EndedWelcome | null;
}): 'welcome' | 'ended' | 'chat' | 'hold' {
  const { selected, main, caps } = input;
  if (!selected) return 'chat';
  if (input.welcomeAgent === selected) return 'welcome';
  if (caps === null) return selected === main ? 'hold' : 'chat';
  if (selected !== main || caps.firstRun !== false) return 'chat';
  if (caps.mainAgentOnboarding === true) return 'welcome';
  if (input.ended === undefined) return 'hold';
  return input.ended?.agent === selected ? 'ended' : 'chat';
}

/** Enough of the TIM's conversations to tell whether the welcome is still the one it last had. */
const ENDED_LOOKUP_LIMIT = 20;

type MissionRow = { id: string; agent_name: string; source_channel: string | null; started_at: number; last_event_at: number | null };

function isMissionRow(row: unknown): row is MissionRow {
  const r = row as Partial<MissionRow> | null;
  return typeof r?.id === 'string' && typeof r.agent_name === 'string' && typeof r.started_at === 'number';
}

/**
 * The welcome a later visit reopens: the TIM's most recently active
 * conversation, when it is the setup one and the reader did not skip it. A
 * conversation had since takes over (the plain chat opens it). `null` on any
 * doubt — the daemon down, a list it cannot read.
 */
export async function fetchEndedWelcome(agent: string, fetcher: Fetcher = fetch): Promise<EndedWelcome | null> {
  try {
    const query = new URLSearchParams({ agent, limit: String(ENDED_LOOKUP_LIMIT) });
    const res = await fetcher(`/api/ui/missions?${query}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const body = await res.json() as { missions?: unknown };
    const rows = Array.isArray(body.missions) ? body.missions.filter(isMissionRow) : [];
    const activity = (row: MissionRow): number => row.last_event_at ?? row.started_at;
    const latest = rows.sort((a, b) => activity(b) - activity(a))[0];
    if (!latest || latest.agent_name !== agent || latest.source_channel !== 'setup' || welcomeSkipped(latest.id)) return null;
    return { agent, missionId: latest.id };
  } catch {
    return null;
  }
}

/** `fetchEndedWelcome` for `agent`, looked up afresh at each visit of it: `undefined` until it answers. */
export function useEndedWelcome(agent: string | null, fetcher?: Fetcher): EndedWelcome | null | undefined {
  const [found, setFound] = useState<{ agent: string; welcome: EndedWelcome | null } | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  useEffect(() => {
    // Forgotten between two visits: the person may have talked to the TIM elsewhere since.
    if (!agent) { setFound(null); return; }
    let live = true;
    void fetchEndedWelcome(agent, fetcherRef.current).then((welcome) => { if (live) setFound({ agent, welcome }); });
    return () => { live = false; };
  }, [agent]);
  if (!agent) return null;
  return found?.agent === agent ? found.welcome : undefined;
}

const noop = (): void => {};

/** The welcome as it ended, reopened: the same conversation, with nothing above it left to skip. */
export function EndedWelcomeView({ Conversation, welcome }: {
  Conversation: ComponentType<WelcomeConversationProps>;
  welcome: EndedWelcome;
}): ReactElement {
  return (
    <section
      data-bots-welcome="ended"
      aria-label={t('bots.welcomeConversation', { name: welcome.agent })}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="relative flex min-h-0 flex-1 flex-col">
        <Conversation
          key={welcome.missionId}
          agent={welcome.agent}
          missionId={welcome.missionId}
          onAgentSpoke={noop}
          onSetupTrouble={noop}
        />
      </div>
    </section>
  );
}

export function BotsEndedWelcome({ welcome }: { welcome: EndedWelcome }): ReactElement {
  return <EndedWelcomeView Conversation={ProductConversation} welcome={welcome} />;
}

function Loader({ label }: { label: string }): ReactElement {
  return (
    <div role="status" aria-live="polite" className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-background">
      <Loader2 className="size-8 animate-spin text-primary" aria-hidden />
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  );
}

function Unavailable({ chat }: { chat: SetupChat }): ReactElement {
  const agent = chat.stage.kind === 'unavailable' ? chat.stage.agent : '';
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-5 overflow-auto p-8" data-chat-unavailable>
      <h1 className="text-2xl font-semibold tracking-tight">{t('setupChat.unavailable.title')}</h1>
      <p className="leading-relaxed text-muted-foreground">{t('setupChat.unavailable.body', { settingsPath: settingsPath('models') })}</p>
      <div className="space-y-3">
        <p className="text-sm font-medium">{t('setupChat.troubleshoot.title')}</p>
        <ProviderCliCards mode="recovery" disabled={chat.busy} />
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <Button type="button" disabled={chat.busy} onClick={() => void chat.start(agent || null)}>{t('setupChat.unavailable.retry')}</Button>
        <button
          type="button"
          className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
          disabled={chat.busy}
          onClick={() => void chat.skip()}
        >
          {t('bots.welcomeSkip')}
        </button>
      </div>
      {chat.skipError && <p role="alert" className="text-sm text-destructive">{t('setupChat.escape.skipFailed')}</p>}
    </div>
  );
}

/** The way out, above the conversation: a quiet link while it goes well, a warning when it is stuck. */
function WelcomeEscape({ chat }: { chat: SetupChat }): ReactElement {
  const { trouble, stage } = chat;
  const restart = (): void => { if (stage.kind === 'chat') void chat.start(stage.agent); };
  return (
    <div data-welcome-escape={trouble.level} className="flex flex-col items-end gap-2 px-4 py-1.5">
      {trouble.level === 'quiet' ? (
        <button
          type="button"
          disabled={chat.busy}
          onClick={() => void chat.skip()}
          className="text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
          {t('bots.welcomeSkip')}
        </button>
      ) : (
        <div role="alert" className="w-full space-y-2 rounded-xl bg-muted p-3">
          <p className="text-sm font-medium">{t(`setupChat.escape.${trouble.reason}.title`)}</p>
          <p className="text-sm leading-relaxed text-muted-foreground">{t(`setupChat.escape.${trouble.reason}.body`)}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" disabled={chat.busy} onClick={() => void chat.skip()}>{t('bots.welcomeSkip')}</Button>
            {trouble.canRestart && (
              <Button type="button" size="sm" variant="outline" disabled={chat.busy} onClick={restart}>{t('setupChat.escape.restart')}</Button>
            )}
          </div>
        </div>
      )}
      {chat.skipError && <p role="alert" className="text-sm text-destructive">{t('setupChat.escape.skipFailed')}</p>}
    </div>
  );
}

export function BotsWelcomeView({ Conversation, chat, onMission, onClosed, onUnnamed }: {
  Conversation: ComponentType<WelcomeConversationProps>;
  chat: SetupChat;
  /** The conversation is on screen: the page keeps showing it once the welcome has ended. */
  onMission: (agent: string, missionId: string) => void;
  /** The reader skipped the welcome: the page goes back to the plain chat. */
  onClosed: () => void;
  /** No named agent yet: back to the onboarding's agent step. */
  onUnnamed: () => void;
}): ReactElement {
  const { stage } = chat;
  const unnamedRef = useRef(onUnnamed);
  unnamedRef.current = onUnnamed;
  useEffect(() => { if (stage.kind === 'unnamed') unnamedRef.current(); }, [stage.kind]);
  const missionRef = useRef(onMission);
  missionRef.current = onMission;
  const agent = stage.kind === 'chat' ? stage.agent : null;
  const missionId = stage.kind === 'chat' ? stage.missionId : null;
  useEffect(() => { if (agent && missionId) missionRef.current(agent, missionId); }, [agent, missionId]);
  const closedRef = useRef(onClosed);
  closedRef.current = onClosed;
  useEffect(() => { if (chat.skipped) closedRef.current(); }, [chat.skipped]);

  if (stage.kind === 'unavailable') {
    return <div data-bots-welcome="unavailable" className="flex min-h-0 flex-1 flex-col"><Unavailable chat={chat} /></div>;
  }
  if (stage.kind !== 'chat') {
    return <div data-bots-welcome={stage.kind} className="relative flex-1"><Loader label={t('setupChat.starting')} /></div>;
  }
  // Once the agent ended the welcome, the conversation is a plain one: no way out to offer, no warning to raise.
  const running = chat.leaving === null;
  return (
    <section
      data-bots-welcome="chat"
      aria-label={t('bots.welcomeConversation', { name: stage.agent })}
      className="flex min-h-0 flex-1 flex-col"
    >
      {running && <WelcomeEscape chat={chat} />}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* Keyed on the mission: a restarted conversation starts from an empty thread. */}
        <Conversation
          key={stage.missionId}
          agent={stage.agent}
          missionId={stage.missionId}
          onAgentSpoke={chat.onAgentSpoke}
          onSetupTrouble={chat.onSetupTrouble}
        />
        {running && !chat.spoke && <Loader label={t('setupChat.starting')} />}
      </div>
    </section>
  );
}

/**
 * The element is on screen, latched: laid out in the viewport (a hidden island
 * tab is `display: none`, which never intersects) while the window is visible.
 * Without `IntersectionObserver` there is nothing to wait for: shown.
 */
export function useShownOnce(ref: RefObject<HTMLElement | null>): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (shown) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver !== 'function') { setShown(true); return; }
    let inView = false;
    const check = (): void => { if (inView && document.visibilityState !== 'hidden') setShown(true); };
    const observer = new IntersectionObserver((entries) => {
      inView = entries.some((entry) => entry.isIntersecting);
      check();
    });
    observer.observe(el);
    document.addEventListener('visibilitychange', check);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', check);
    };
  }, [ref, shown]);
  return shown;
}

export function BotsWelcome({ onMission, onClosed }: {
  onMission: (agent: string, missionId: string) => void;
  onClosed: () => void;
}): ReactElement {
  const box = useRef<HTMLDivElement>(null);
  const shown = useShownOnce(box);
  const chat = useSetupChat({ shown });
  return (
    <div ref={box} className="flex min-h-0 flex-1 flex-col">
      <BotsWelcomeView
        Conversation={ProductConversation}
        chat={chat}
        onMission={onMission}
        onClosed={onClosed}
        onUnnamed={() => window.location.assign(stepHref('agent'))}
      />
    </div>
  );
}
