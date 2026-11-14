'use client';

/**
 * The form of a provider reached at an address the user gives (a compatible
 * endpoint): its draft, its Test and its Save, and its fields. The daemon
 * writes `~/.timon/backends/<id>.json` and keeps the key in the vault — this
 * form never receives the key back, which is why the key field of an edit
 * means "replace it", and an empty one means "leave it alone".
 */

import { useRef, useState, type ReactElement } from 'react';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { ReasoningControl } from '@/lib/backends';
import {
  createPayload,
  destinationHost,
  formErrorKey,
  mergeDiscovered,
  outcomeMessage,
  testPayload,
  updatePayload,
  type BackendForm,
  type BackendProtocol,
  type CustomBackend,
  type TestOutcome,
} from './form';
import { ModelEditor } from './model-editor';
import { PictoPanel } from './picto-panel';
import { FIELD, HINT, LABEL } from './type-scale';

/** `thinkingControls`: what a model of this protocol can be set by — levels
 *  always, a budget or a switch when the dialect sends them. */
export type ProtocolOption = { protocol: BackendProtocol; dialect: string; installed: boolean; thinkingControls?: ReasoningControl['type'][] };
export type Verdict = ReturnType<typeof outcomeMessage>;

export const API = '/api/ui/backends/custom';
export const MANAGE_API = '/api/ui/backends/manage';

export async function errorText(res: Response): Promise<string> {
  if (res.status === 403) return t('backendsSettings.errors.forbidden');
  const raw = (await res.text().catch(() => '')).trim();
  try {
    return (JSON.parse(raw) as { error?: string }).error || `HTTP ${res.status}`;
  } catch {
    return raw || `HTTP ${res.status}`;
  }
}

const TONE_CLASS: Record<Verdict['tone'], string> = {
  ok: 'text-emerald-600 dark:text-emerald-400',
  warn: 'text-amber-600 dark:text-amber-400',
  error: 'text-destructive',
};

export function VerdictLine({ verdict }: { verdict: Verdict | null }): ReactElement | null {
  if (!verdict) return null;
  return (
    <span role="status" className={cn('text-xs', TONE_CLASS[verdict.tone])}>
      {t(verdict.key, verdict.vars)}
    </span>
  );
}

export type EndpointDraft = {
  form: BackendForm | null;
  /** A Test or a Save of this draft is running. */
  busy: boolean;
  verdict: Verdict | null;
  open: (next: BackendForm | null) => void;
  close: () => void;
  patch: (next: Partial<BackendForm>) => void;
  test: () => Promise<void>;
  save: () => Promise<void>;
};

/**
 * One draft at a time. `onSaved` receives what the daemon answered: the new
 * backend on a creation, `null` after an edit (its answer carries no row).
 */
export function useEndpointDraft(onSaved: (created: CustomBackend | null) => Promise<void> | void): EndpointDraft {
  const [form, setForm] = useState<BackendForm | null>(null);
  // The draft's own: a Test running in it never locks the list, nor the reverse.
  const [busy, setBusy] = useState(false);
  const [verdict, setVerdict] = useState<Verdict | null>(null);

  // Which draft is open. A Test or a Save answered after the draft was
  // closed or reopened on another backend belongs to a draft that is gone: its
  // answer must neither reopen it nor land in the new draft.
  const draft = useRef(0);
  const open = (next: BackendForm | null) => {
    draft.current += 1;
    setForm(next);
    setVerdict(null);
    setBusy(false);
  };
  const close = () => open(null);

  const patch = (next: Partial<BackendForm>) => {
    setVerdict(null);
    setForm((current) => (current ? { ...current, ...next } : current));
  };

  async function runTest(body: Record<string, unknown>): Promise<TestOutcome | null> {
    const res = await fetch(`${API}/test`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store',
    });
    if (!res.ok) { toast.error(await errorText(res)); return null; }
    return await res.json() as TestOutcome;
  }

  async function test() {
    if (!form) return;
    const errKey = formErrorKey(form);
    if (errKey) { toast.error(t(errKey)); return; }
    const mine = draft.current;
    setBusy(true);
    try {
      const result = await runTest(testPayload(form));
      if (!result || draft.current !== mine) return;
      setVerdict(outcomeMessage(result));
      // Proposed, not imposed: what the endpoint lists is ADDED to what the
      // user has now — including what they typed while the test ran.
      if (result.outcome === 'ok' && result.models.length) {
        setForm((current) => (current ? { ...current, models: mergeDiscovered(current.models, result.models, result.reasoningLevels) } : current));
      }
    } finally {
      if (draft.current === mine) setBusy(false);
    }
  }

  async function save() {
    if (!form) return;
    const errKey = formErrorKey(form);
    if (errKey) { toast.error(t(errKey)); return; }
    const mine = draft.current;
    setBusy(true);
    try {
      const editing = form.id !== null;
      const res = await fetch(editing ? `${MANAGE_API}/${encodeURIComponent(form.id as string)}` : API, {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(editing ? updatePayload(form) : createPayload(form)),
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(await errorText(res));
      const created = editing ? null : ((await res.json().catch(() => null)) as { backend?: CustomBackend } | null)?.backend ?? null;
      if (draft.current === mine) close();
      toast.success(t(editing ? 'backendsSettings.saved' : 'backendsSettings.added'));
      await onSaved(created);
    } catch (err) {
      toast.error(err instanceof TypeError ? t('backendsSettings.errors.unconfirmed') : err instanceof Error ? err.message : String(err));
    } finally {
      if (draft.current === mine) setBusy(false);
    }
  }

  return { form, busy, verdict, open, close, patch, test, save };
}

/** Whether the address and the key of this draft may be changed (a new one, or a file the user added). */
export function connectionEditable(form: BackendForm | null): boolean {
  const managed = !!form?.origin && form.origin !== 'file';
  return !form?.id || (!managed && form.connectionEditable !== false);
}

export function EndpointFields({ form, protocols, patch }: {
  form: BackendForm;
  protocols: readonly ProtocolOption[];
  patch: (next: Partial<BackendForm>) => void;
}): ReactElement {
  const host = destinationHost(form.baseUrl);
  const managed = !!form.origin && form.origin !== 'file';
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label className={LABEL} htmlFor="backend-name">{t('backendsSettings.fields.name')}</Label>
        <Input className={FIELD} id="backend-name" value={form.name} autoComplete="off" onChange={(e) => patch({ name: e.target.value })}
          // i18n-exempt: a provider's brand name, given as an example, the same in every language
          placeholder="DeepSeek" />
      </div>
      <div className="space-y-1.5">
        <span className={cn(LABEL, 'block')}>{t('backendsSettings.fields.picto')}</span>
        <PictoPanel
          value={{ icon: form.icon, brand: form.brand }}
          onChange={(picto) => patch(picto)}
        />
      </div>
      {connectionEditable(form) && <>
      <fieldset className="space-y-1.5">
        <legend className={LABEL}>{t('backendsSettings.fields.protocol')}</legend>
        <div className="flex flex-wrap gap-4 pt-1.5">
          {(['anthropic', 'openai-responses'] as const).map((protocol) => {
            const installed = protocols.find((option) => option.protocol === protocol)?.installed ?? true;
            return (
              <label key={protocol} className={cn('flex items-center gap-2 text-[13px]', !installed && 'opacity-50')}>
                <input
                  type="radio" name="backend-protocol" className="accent-primary"
                  checked={form.protocol === protocol}
                  onChange={() => installed ? patch({ protocol }) : toast.error(t('backendsSettings.errors.protocolUnavailable'))}
                />
                {t(`backendsSettings.protocols.${protocol}`)}
                {!installed && <span className="text-[12px]">{t('backendsSettings.errors.protocolUnavailable')}</span>}
              </label>
            );
          })}
        </div>
        <p className={HINT}>{t(`backendsSettings.protocolHints.${form.protocol}`)}</p>
      </fieldset>
      <div className="space-y-1.5">
        <Label className={LABEL} htmlFor="backend-url">{t('backendsSettings.fields.baseUrl')}</Label>
        <Input
          className={FIELD}
          id="backend-url" type="url" inputMode="url" autoComplete="off" value={form.baseUrl}
          placeholder={form.protocol === 'anthropic' ? 'https://api.deepseek.com/anthropic' : 'https://openrouter.ai/api/v1'}
          onChange={(e) => patch({ baseUrl: e.target.value })}
        />
        {host ? <p className={HINT}>{t('backendsSettings.destinationNotice', { host })}</p> : null}
      </div>
      <div className="space-y-1.5">
        <Label className={LABEL} htmlFor="backend-key">{t('backendsSettings.fields.key')}</Label>
        <Input className={FIELD} id="backend-key" type="password" autoComplete="off" value={form.key} onChange={(e) => patch({ key: e.target.value })} />
        <p className={HINT}>
          {t(form.id ? 'backendsSettings.keyHintEdit' : 'backendsSettings.keyHint')}
        </p>
      </div>
      </>}
      {managed && <p className={HINT}>{t('backendsSettings.managedHint')}</p>}
      <ModelEditor
        models={form.models}
        defaultModel={form.defaultModel}
        onChange={(next) => patch(next)}
        savedSlugs={form.savedSlugs}
        // Thinking is set by hand only on a provider the user added: a
        // built-in one declares its own levels.
        thinkingControls={!form.origin || form.origin === 'file'
          ? protocols.find((option) => option.protocol === form.protocol)?.thinkingControls ?? ['levels']
          : null}
      />
    </div>
  );
}
