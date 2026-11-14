/**
 * The API key of a provider, written from the Key section of its page: the
 * vault entry its backends read (`LLMTR_API_KEY`…), never read back.
 *
 * Same routes as Settings › Secrets (`/api/ui/secrets`, superadmin for a new
 * grant). A key the page writes is reserved to the provider's backends
 * (`backend:<id>`, TODO #531): it enters their process and nothing else. When
 * an entry of that name already carries such a reservation, its value is
 * replaced and its grants are left as they are; anything else (a global
 * entry, one shared by hand) is the Secrets page's business, and the new
 * reserved entry takes precedence for these backends only.
 */
import { apiErrorMessage } from '@/lib/api-error';
import { t } from '@/lib/i18n';
import type { SecretGrant, SecretSummary } from '@/lib/secrets';

export type ProviderSecretWrite =
  | { kind: 'replace'; id: string }
  | { kind: 'create'; grants: SecretGrant[] };

/** The backends a reservation can name: never an account instance, whose process runs under its backend's id. */
export function reservableBackends(backendIds: readonly string[]): string[] {
  return [...new Set(backendIds.filter((id) => id !== '' && !id.includes('@')))];
}

/** What saving `name` for these backends does, given the vault's list. */
export function planProviderSecretWrite(
  secrets: readonly SecretSummary[],
  name: string,
  backendIds: readonly string[],
): ProviderSecretWrite {
  const targets = reservableBackends(backendIds);
  const reserved = secrets
    .filter((secret) => secret.name === name
      && secret.grants.some((grant) => grant.scope_kind === 'backend' && targets.includes(grant.scope_ref ?? '')))
    .sort((a, b) => b.updated_at - a.updated_at);
  const newest = reserved[0];
  if (newest) return { kind: 'replace', id: newest.id };
  return { kind: 'create', grants: targets.map((id) => ({ scope_kind: 'backend', scope_ref: id })) };
}

async function failure(res: Response): Promise<Error> {
  const body: unknown = await res.json().catch(() => null);
  return new Error(apiErrorMessage(body, t('providerPage.apiKey.errorGeneric')));
}

/** Writes `value` under `name` for the provider's backends. The value goes out in the body only. */
export async function saveProviderSecret(name: string, value: string, backendIds: readonly string[]): Promise<void> {
  const list = await fetch('/api/ui/secrets', { cache: 'no-store' });
  if (!list.ok) throw await failure(list);
  const { secrets = [] } = (await list.json()) as { secrets?: SecretSummary[] };
  const plan = planProviderSecretWrite(secrets, name, backendIds);
  const res = plan.kind === 'replace'
    ? await fetch(`/api/ui/secrets/${encodeURIComponent(plan.id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      // Only the value: the entry keeps its name, mode, note and grants.
      body: JSON.stringify({ value }),
    })
    : await fetch('/api/ui/secrets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, mode: 'inject', note: null, grants: plan.grants, value }),
    });
  if (!res.ok) throw await failure(res);
}
