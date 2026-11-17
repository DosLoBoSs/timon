'use client';

/**
 * Onboarding steps 3 and 4 — the AIs this machine can use, then the main agent
 * builds itself, in a conversation.
 *
 * First "Your AIs" (TODO #251): the provider cards, so that everyone sees
 * which AI CLIs are installed and signed in — and can install one — before a
 * chat that needs one. It used to appear only once the chat had failed to
 * start, which nobody reached in normal use. "Continue" opens as soon as one
 * CLI the chat can start on is there; a reload that resumes a named agent or an
 * open chat skips it.
 *
 * Then two moments. First ONE field: the name, asked before the chat so the rename
 * has no live mission to meet (the daemon refuses to move a running agent).
 * Then the chat itself, alone on screen: the agent speaks first, asks for a
 * picture (a card in the conversation) and a few words on its character, and
 * ends the step by itself (`setup_finish`).
 *
 * Nothing here asks the person to write what a model can ask for. The product's
 * menus are drawn but inert: they are what the person is about to get.
 *
 * "Skip" is on every screen of the step (`SetupEscape`, SUG-0078): quiet while
 * the conversation goes well, put forward when it fails — a refused tool left a
 * tester with no card, no `setup_finish`, and a gate that sent every page back here.
 */
import { Component, Suspense, useCallback, useRef, useState, type FormEvent, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { ArrowRight, ImagePlus, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LogoCropDialog, type LogoCropSource } from '@/components/logo-crop-dialog';
import { MAX_IMAGE_UPLOAD_BYTES } from '@/lib/image-upload';
import { OnboardingBackdrop } from '@/components/onboarding-backdrop';
import { TopBar } from '@/components/topbar';
import { useSettingsNavigation } from '@/lib/settings-navigation';
import { t } from '@/lib/i18n';
import { settingsPath } from '@/lib/settings-path';
import { ProviderCliCards } from '@/components/provider-cli/provider-cli-cards';
import { readyForSetupChat } from '@/lib/provider-clis';
import { machineScopedStorage } from '@/lib/machines/machine-storage';
import { openedFromOnboarding } from '@/components/onboarding/onboarding-flow';
import { useSetupChat, type SetupLeave } from '@/components/onboarding/setup-chat';
import { setupLanding } from './setup-landing';
import { fetchCapabilities } from '@/lib/capabilities';
import { SetupEscape } from './setup-escape';
import { SlotRegion } from '@/lib/plugin-host/render';

// Loaded on demand: the provider step comes first, and the chat is only
// fetched at the chat stage, under the loader that hides it until the agent speaks.
const ChatClient = dynamic(() => import('@/app/chat/chat-client').then((m) => m.ChatClient), { ssr: false });

/** "Your AIs" was passed in this tab: a reload on the name form does not show it again. */
const PROVIDERS_KEY = 'timon.setup.providers';

/** Out of the setup, into the app: a full load, the client host reads the finished install afresh. */
async function leaveSetup(): Promise<void> {
  window.location.assign(setupLanding(await fetchCapabilities(true).catch(() => null)));
}
const NAME_ERRORS = new Set(['invalid_name', 'name_taken', 'rename_failed', 'workspace_unavailable', 'main_agent_unavailable']);

function providersSeen(): boolean {
  // The onboarding's "Choose your LLM" step already showed the provider cards: not twice.
  if (openedFromOnboarding(window.location.search)) return true;
  try { return machineScopedStorage(sessionStorage).getItem(PROVIDERS_KEY) === 'done'; } catch { return false; }
}

/** The decorative menus must never take the chat down with them. */
class GhostBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  render(): ReactNode { return this.state.failed ? null : this.props.children; }
}

export default function MainAgentSetupPage() {
  // The agent's last words stay on screen a moment, then the loader covers the way out.
  const [exiting, setExiting] = useState(false);
  const onLeave = useCallback((why: SetupLeave) => {
    if (why === 'finished') setExiting(true);
    void leaveSetup();
  }, []);
  // The session itself (where it resumes, its start, its trouble, its end) is the welcome's (`setup-chat.ts`);
  // a daemon that does not answer leaves the reader on the forms, which have a way forward of their own.
  const chat = useSetupChat({ leave: onLeave, statusFailure: 'unnamed' });
  const { stage } = chat;
  const [providersDone, setProvidersDone] = useState(false);
  const [name, setName] = useState('');
  // The picture is chosen with the name: the conversation no longer asks for it.
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [avatarSource, setAvatarSource] = useState<LogoCropSource | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const busy = naming || chat.busy;
  const skipError = chat.skipError ? t('setupChat.escape.skipFailed') : null;
  const settings = useSettingsNavigation();
  // `null` until the daemon answered: "Continue" waits for one CLI the chat can start on. A list
  // refused or unreachable does not hold the wizard: the chat then says itself what is missing.
  const [aiReady, setAiReady] = useState<boolean | null>(null);
  const onBackends = useCallback((backends: Parameters<typeof readyForSetupChat>[0] | null) => {
    setAiReady(backends ? readyForSetupChat(backends) : true);
  }, []);
  // No agent named yet: "Your AIs" first, unless this tab already passed it. Read only once the
  // daemon answered, never while the page renders on the server.
  const form = stage.kind === 'unnamed' ? (providersDone || providersSeen() ? 'name' : 'providers') : null;

  async function submitName(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy || !name.trim()) return;
    setNaming(true);
    setError(null);
    try {
      const res = await fetch('/api/ui/setup/main-agent/name', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), ...(avatarUrl ? { avatarUrl } : {}) }),
      });
      const body = await res.json().catch(() => ({})) as { name?: string; error?: string };
      if (!res.ok || !body.name) {
        setError(t(`mainAgentSetup.${NAME_ERRORS.has(body.error ?? '') ? body.error : 'failed'}`));
        return;
      }
      await chat.start(body.name);
    } catch {
      setError(t('mainAgentSetup.failed'));
    } finally {
      setNaming(false);
    }
  }

  function leaveProviders(): void {
    try { machineScopedStorage(sessionStorage).setItem(PROVIDERS_KEY, 'done'); } catch { /* private mode */ }
    setProvidersDone(true);
  }

  function skip(): void {
    if (busy) return;
    void chat.skip();
  }

  const escape = (
    <SetupEscape
      trouble={chat.trouble}
      busy={busy}
      error={skipError}
      onSkip={skip}
      onRestart={() => { if (stage.kind === 'chat') void chat.start(stage.agent); }}
    />
  );
  const skipLink = (
    <div className="space-y-1">
      <button type="button" className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground" disabled={busy} onClick={skip}>
        {t('setupChat.escape.skip')}
      </button>
      {skipError && <p role="alert" className="text-sm text-destructive">{skipError}</p>}
    </div>
  );

  if (stage.kind === 'starting') return <><SetupLoader />{escape}</>;

  if (stage.kind === 'chat') {
    return (
      <div data-setup-chat className="relative flex h-[100dvh] w-full flex-col bg-background">
        {/* What the person is about to get: drawn, not clickable. The real top
            bar, which also places the menu rail under it. Not faded: a faded
            chrome no longer matches the opaque backdrop around the island. */}
        <div inert aria-hidden className="pointer-events-none select-none">
          <GhostBoundary><TopBar banners={false} /></GhostBoundary>
        </div>
        <main className="timon-island-backdrop flex min-h-0 flex-1 pb-[var(--timon-island-gap)] pl-[var(--timon-nav-w)] pr-[var(--timon-island-gap)]">
          <div className="timon-island relative min-w-0 flex-1 overflow-hidden">
            <Suspense fallback={null}>
              {/* Keyed on the mission: a restarted conversation starts from an empty thread. */}
              <ChatClient key={stage.missionId} forcedAgent={stage.agent} forcedMission={stage.missionId} compact chromeComplet setup onAgentSpoke={chat.onAgentSpoke} onSetupTrouble={chat.onSetupTrouble} />
            </Suspense>
          </div>
        </main>
        {(!chat.spoke || exiting) && <SetupLoader label={exiting ? t('setupChat.toTour') : undefined} />}
        {!exiting && escape}
      </div>
    );
  }

  return (
    <OnboardingBackdrop
      className={form === 'providers' ? 'max-w-3xl' : stage.kind === 'unavailable' ? 'max-w-xl' : 'max-w-md'}
      center
      step={form === 'providers' ? 'ai' : 'agent'}
    >

      {stage.kind === 'loading' ? (
        <p role="status" className="text-sm text-muted-foreground">{t('mainAgentSetup.loading')}</p>
      ) : form === 'providers' ? (
        <div className="space-y-6">
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight">{t('providerClis.onboarding.title')}</h1>
            <p className="max-w-2xl leading-relaxed text-muted-foreground">{t('providerClis.onboarding.body', { settingsPath: settingsPath('models') })}</p>
          </div>
          <ProviderCliCards mode="onboarding" onBackends={onBackends} />
          <div className="flex flex-wrap items-center gap-4">
            <Button type="button" disabled={aiReady !== true} onClick={leaveProviders}>
              {t('providerClis.onboarding.continue')}<ArrowRight className="ml-2 h-4 w-4" aria-hidden />
            </Button>
            {aiReady === false && (
              <>
                <p className="text-sm text-muted-foreground">{t('providerClis.onboarding.needOne')}</p>
                <button type="button" className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground" onClick={leaveProviders}>
                  {t('providerClis.onboarding.anyway')}
                </button>
              </>
            )}
          </div>
          {skipLink}
        </div>
      ) : stage.kind === 'unavailable' ? (
        <div className="space-y-5">
          <h1 className="text-2xl font-semibold tracking-tight">{t('setupChat.unavailable.title')}</h1>
          <p className="max-w-lg leading-relaxed text-muted-foreground">{t('setupChat.unavailable.body', { settingsPath: settingsPath('models') })}</p>
          <div className="space-y-3">
            <p className="text-sm font-medium">{t('setupChat.troubleshoot.title')}</p>
            <ProviderCliCards mode="recovery" disabled={busy} />
            <p className="text-sm text-muted-foreground">{t('setupChat.troubleshoot.other', { settingsPath: settingsPath('models') })}</p>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <Button type="button" disabled={busy} onClick={() => void chat.start(stage.agent)}>{t('setupChat.unavailable.retry')}</Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => settings.open({ category: 'models', tab: null })}>{t('setupChat.troubleshoot.openSettings')}</Button>
            {skipLink}
          </div>
        </div>
      ) : (
        <form className="flex flex-col items-center gap-8" onSubmit={(e) => void submitName(e)}>
          <h1 className="text-center text-3xl font-semibold tracking-tight">{t('setupChat.name.title')}</h1>
          <div className="flex flex-col items-center gap-2">
            <input
              ref={picker}
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                if (file.size > MAX_IMAGE_UPLOAD_BYTES) { setError(t('mainAgentSetup.imageInvalid')); return; }
                setError(null);
                setAvatarSource(file);
              }}
            />
            {/* The bubble IS the button: the upload picto sits in its centre, over the picture once there is one. */}
            <button
              type="button"
              disabled={busy}
              onClick={() => picker.current?.click()}
              aria-label={t(avatarUrl ? 'mainAgentSetup.changeAvatar' : 'mainAgentSetup.pickAvatar')}
              className="group relative flex size-24 items-center justify-center overflow-hidden rounded-full bg-muted text-muted-foreground transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              {avatarUrl && <img src={avatarUrl} alt="" className="absolute inset-0 size-full object-cover" />}
              <span className={avatarUrl
                ? 'relative flex size-full items-center justify-center bg-black/40 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100'
                : 'relative flex items-center justify-center'}>
                <ImagePlus className="size-7" aria-hidden />
              </span>
            </button>
            <span className="text-xs text-muted-foreground">{t('mainAgentSetup.optional')}</span>
          </div>
          <LogoCropDialog
            source={avatarSource}
            endpoint="/api/uploads/projects"
            onCancel={() => setAvatarSource(null)}
            onUploaded={(url) => { setAvatarSource(null); setAvatarUrl(url); }}
          />
          <label className="block w-full space-y-1.5" htmlFor="main-agent-name">
            <span className="text-sm font-medium">{t('mainAgentSetup.name')}</span>
            <input
              id="main-agent-name"
              className="w-full rounded-md border bg-background p-2.5 text-sm"
              value={name}
              maxLength={48}
              required
              autoFocus
              placeholder={t('mainAgentSetup.namePlaceholder')}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          {error && <p role="alert" className="text-center text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={busy || !name.trim()}>
            {busy ? t('mainAgentSetup.saving') : name.trim() ? t('setupChat.name.submitNamed', { name: name.trim() }) : t('setupChat.name.submit')}<ArrowRight className="ml-2 h-4 w-4" aria-hidden />
          </Button>
          {/* A plugin's other way in (agent import: "I already have agents"); empty, nothing painted. */}
          <SlotRegion name="onboarding.agent" className="flex flex-col items-center gap-2 text-center" />
          <div className="text-center">{skipLink}</div>
        </form>
      )}
    </OnboardingBackdrop>
  );
}

/** Opaque, over everything: the agent loads its skill and finds a backend that answers. */
function SetupLoader({ label }: { label?: string } = {}): ReactNode {
  return (
    <div role="status" aria-live="polite" className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-background">
      <Loader2 className="size-8 animate-spin text-primary" aria-hidden />
      <p className="text-sm text-muted-foreground">{label ?? t('setupChat.starting')}</p>
    </div>
  );
}
