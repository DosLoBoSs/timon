/**
 * Which permission modes a backend actually runs read-only.
 *
 * The Grok CLI cannot ask for an approval headless, so its provider runs every
 * guarded mode in `plan` rather than raise it to always-approve: only `plan`
 * and an explicit `bypassPermissions` reach the CLI as such. The screens that
 * let a person pick a mode say so, or a Grok agent left in `auto` would look
 * broken when it refuses to edit anything.
 *
 * The catalogue carries no per-backend datum for this yet, so this is the one
 * place of the interface that names the backend: move it to a catalogue field
 * the day the provider contract can declare it.
 */
import type { BackendName } from './backends';

const PLAN_OR_BYPASS_ONLY: ReadonlySet<string> = new Set(['grok']);

/** `grok@<account>` runs as `grok` does. */
function baseBackend(backend: BackendName): string {
  return backend.split('@')[0] ?? backend;
}

/** True when `mode`, picked for an agent on `backend`, runs read-only. */
export function modeRunsReadOnly(backend: BackendName | null | undefined, mode: string | null | undefined): boolean {
  if (!backend || mode === 'plan' || mode === 'bypassPermissions') return false;
  return PLAN_OR_BYPASS_ONLY.has(baseBackend(backend));
}
