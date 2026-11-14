'use client';

/**
 * The backends of the provider a page is painted for, as the edit routes know
 * them (`/api/ui/backends/manage`): their models, name, picture and, for one
 * added by hand, its connection. The overview the page reads says what a
 * provider IS; these routes are where its sections change it.
 *
 * Each section keeps its own draft of a backend (`useBackendDraft`), saved
 * with only its own fields: a save in Models never resends the connection.
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { ReasoningControl } from '@/lib/backends';
import { sseOn } from '@/lib/sse-stream';
import { t } from '@/lib/i18n';
import { formOf, type BackendForm, type BackendProtocol, type CustomBackend } from './form';

export const MANAGE_API = '/api/ui/backends/manage';
export const CUSTOM_API = '/api/ui/backends/custom';

/** `thinkingControls`: what a model of this protocol can be set by. */
export type ProtocolOption = { protocol: BackendProtocol; dialect: string; installed: boolean; thinkingControls?: ReasoningControl['type'][] };
type Listing = { backends?: CustomBackend[]; protocols?: ProtocolOption[] };

export async function backendErrorText(res: Response): Promise<string> {
  if (res.status === 401 || res.status === 403) return t('backendsSettings.errors.forbidden');
  const raw = (await res.text().catch(() => '')).trim();
  try {
    return (JSON.parse(raw) as { error?: string }).error || `HTTP ${res.status}`;
  } catch {
    return raw || `HTTP ${res.status}`;
  }
}

/** A hand-written file in a format the product does not know is read, never edited. */
export function editable(backend: CustomBackend): boolean {
  return backend.origin !== 'file' || backend.dialect !== null;
}

/** Sends one section's fields of a backend; throws the daemon's reason. */
export async function patchBackend(id: string, body: Record<string, unknown>): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${MANAGE_API}/${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store',
    });
  } catch {
    throw new Error(t('backendsSettings.errors.unconfirmed'));
  }
  if (!res.ok) throw new Error(await backendErrorText(res));
}

export function useProviderBackends(ids: readonly string[]): {
  backends: CustomBackend[];
  protocols: ProtocolOption[];
  reload: () => Promise<void>;
} {
  const [listing, setListing] = useState<{ backends: CustomBackend[]; protocols: ProtocolOption[] }>({ backends: [], protocols: [] });
  const wanted = ids.join('\n');

  const reload = useCallback(async () => {
    try {
      const res = await fetch(MANAGE_API, { cache: 'no-store' });
      // Refused: the page already says only an administrator sees providers.
      if (res.status === 401 || res.status === 403) return;
      if (!res.ok) throw new Error(await backendErrorText(res));
      const body = await res.json() as Listing;
      const order = wanted.split('\n');
      setListing({
        backends: (body.backends ?? []).filter((backend) => order.includes(backend.id) && editable(backend))
          .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)),
        protocols: body.protocols ?? [],
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [wanted]);

  useEffect(() => { void reload(); }, [reload]);
  // A file edited by hand, or another window's save, shows up here too.
  useEffect(() => sseOn('backends_changed', () => { void reload(); }), [reload]);

  return { ...listing, reload };
}

const same = (a: Record<string, unknown>, b: Record<string, unknown>): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * One section's draft of a backend. What the daemon sends again replaces the
 * draft only while the user has not touched it: a stream event never wipes
 * what they are typing.
 */
export function useBackendDraft(backend: CustomBackend, payloadOf: (form: BackendForm) => Record<string, unknown>): {
  draft: BackendForm;
  patch: (next: Partial<BackendForm>) => void;
  dirty: boolean;
  reset: () => void;
  /** After a save: the draft is what the daemon holds now, until it says otherwise. */
  settle: () => void;
} {
  const [state, setState] = useState(() => ({ base: formOf(backend), draft: formOf(backend) }));
  const server = JSON.stringify(backend);
  useEffect(() => {
    setState((current) => {
      const next = formOf(JSON.parse(server) as CustomBackend);
      return { base: next, draft: same(payloadOf(current.draft), payloadOf(current.base)) ? next : current.draft };
    });
  // `payloadOf` is a module function: the server's copy alone decides.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server]);

  return {
    draft: state.draft,
    patch: (next) => setState((current) => ({ ...current, draft: { ...current.draft, ...next } })),
    dirty: !same(payloadOf(state.draft), payloadOf(state.base)),
    reset: () => setState((current) => ({ ...current, draft: current.base })),
    settle: () => setState((current) => ({ base: { ...current.draft, key: '' }, draft: { ...current.draft, key: '' } })),
  };
}
