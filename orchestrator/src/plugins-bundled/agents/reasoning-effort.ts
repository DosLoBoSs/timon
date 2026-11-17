/**
 * The reasoning efforts an agent's model accepts, for the config PATCH: the
 * values the thinking bar of the web client offers for that pair
 * (`app/src/lib/thinking-bar.ts`, `thinkingBarFor` + `reasoningLevelsFor`).
 * The two must stay in step: a value the bar shows has to pass here, and a
 * value refused here is one the bar would never send.
 */
import { catalogBackend, type CatalogBackend } from '../../backends/catalog.js';
import { implicitBackendName } from '../../backends/index.js';
import type { ModelReasoning, ReasoningControl } from '../../backends/reasoning-control.js';

/** Budget of each named step, in thinking tokens. Same values as
 *  `BUDGET_STEPS` in the web client's thinking bar. */
const BUDGET_STEPS = [2_000, 8_000, 32_000] as const;
/** The Claude CLI raises any smaller budget to this. */
const MIN_BUDGET = 1_024;

function budgetValues(control: { min?: number; max?: number }): string[] {
  const floor = Math.max(MIN_BUDGET, control.min ?? 0);
  const values = BUDGET_STEPS.map((step) => {
    const raw = Math.max(floor, step);
    return String(control.max !== undefined ? Math.min(raw, Math.max(control.max, floor)) : raw);
  });
  return [...new Set(values)];
}

function controlValues(control: ReasoningControl): string[] {
  if (control.type === 'levels') return control.values;
  if (control.type === 'budget') return budgetValues(control);
  return ['off', 'on'];
}

function pickControl(reasoning: ModelReasoning | undefined, allowed: readonly ReasoningControl['type'][] = ['levels']): ReasoningControl | null {
  if (!reasoning?.thinks) return null;
  const order: ReasoningControl['type'][] = reasoning.source === 'catalog' ? ['budget', 'levels', 'toggle'] : ['levels', 'budget', 'toggle'];
  for (const type of order) {
    if (!allowed.includes(type)) continue;
    const control = reasoning.controls.find((item) => item.type === type);
    if (control && (control.type !== 'levels' || control.values.length)) return control;
  }
  return null;
}

/** Exact slug first, then the levels of the slug's family on a backend that
 *  claims it by prefix, then the levels all its models share. */
function levelsFor(entry: CatalogBackend, model: string): string[] {
  const own = entry.models.find((m) => m.slug === model)?.supportedReasoningLevels;
  if (own) return own;
  if (!entry.slugPrefixes?.some((prefix) => model.startsWith(prefix))) return [];
  const withLevels = entry.models.filter((m) => m.slug !== model && m.supportedReasoningLevels?.length);
  const tokens = model.split('-');
  const family = withLevels.filter((m) => tokens.includes(m.slug));
  const pool = family.length > 0 ? family : withLevels;
  const [first, ...rest] = pool.map((m) => m.supportedReasoningLevels ?? []);
  if (!first) return [];
  return first.filter((level) => rest.every((levels) => levels.includes(level)));
}

/** What `model` on `backend` accepts as `reasoningEffort`; empty when its
 *  thinking cannot be set (or the backend is not active right now). */
export function reasoningEffortsFor(backend: string, model: string): string[] {
  const entry = catalogBackend(backend);
  if (!entry || !model) return [];
  const reasoning = entry.models.find((item) => item.slug === model)?.reasoning;
  if (reasoning?.source === 'declared') {
    const declared = pickControl(reasoning, entry.thinkingControls);
    return declared ? controlValues(declared) : [];
  }
  const levels = levelsFor(entry, model);
  if (levels.length) return levels;
  const control = pickControl(reasoning, entry.thinkingControls);
  return control ? controlValues(control) : [];
}

type Pair = { backend?: unknown; model?: unknown };

/**
 * Checks the `reasoningEffort` of a config PATCH against the pair the agent
 * will run on once patched. Returns the value to store (null clears it) or a
 * refusal message.
 */
export function checkReasoningEffort(
  value: unknown,
  patch: Pair,
  current: Pair | null,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === null || value === '') return { ok: true, value: null };
  if (typeof value !== 'string' || value.length > 40) return { ok: false, error: 'reasoningEffort must be a string or null' };
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const backend = str(patch.backend) || str(current?.backend) || implicitBackendName();
  const model = str(patch.model) || str(current?.model) || catalogBackend(backend)?.defaultModel || '';
  const accepted = reasoningEffortsFor(backend, model);
  if (accepted.includes(value)) return { ok: true, value };
  return {
    ok: false,
    error: accepted.length
      ? `reasoningEffort must be one of ${accepted.join(', ')} for ${model || 'this model'}`
      : `the reasoning effort of ${model || 'this model'} cannot be set`,
  };
}
