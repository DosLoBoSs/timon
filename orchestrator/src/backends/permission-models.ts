/**
 * The three ways a CLI can be made to respect Timon's permission policy
 * (`PermissionModel`), and what a dialect owes for each.
 *
 *   mcp-bridge — the CLI asks an injected MCP tool before every tool use that is
 *                not pre-approved: the dialect passes that tool's name
 *                (`CLAUDE_PERMISSION_PROMPT_TOOL`) and declares `timon_ask`.
 *                The answer is an Allow/Deny card and a classifier.
 *   sandbox    — nothing can be asked mid-turn; privileges are frozen at spawn.
 *                The dialect turns `permission_mode` into the CLI's own level
 *                (`sandboxLevelForPermissionMode` is the usual three).
 *   protocol   — the agent asks through its protocol (ACP
 *                `session/request_permission`); the session driver forwards it
 *                to `SessionHost.requestPermission`.
 *
 * A leaf of the backends module: the mapping is moved verbatim out of
 * le plugin `provider-codex` (`official-providers/provider-codex/lib/codex.js`).
 */

/** Map our agent.permission_mode → a sandbox level, as Codex's `--sandbox` has
 *  them. Only three levels (read-only / workspace-write / danger-full-access),
 *  so this is a coarser knob than Claude's permission system. Any dialect whose
 *  permission model is `sandbox` can reuse it. */
export function sandboxLevelForPermissionMode(permissionMode: string | undefined): string {
  switch (permissionMode) {
    case 'plan':
    case 'read-only':
      return 'read-only';
    case 'bypassPermissions':
    case 'danger-full-access':
      return 'danger-full-access';
    case 'auto':
    case 'acceptEdits':
    case 'default':
    case undefined:
    default:
      return 'workspace-write';
  }
}

/** What a dialect declaring `model` must be able to do — as sentences, for the
 *  registration check and the docs. `none` owes nothing: it is an admission. */
export const PERMISSION_MODEL_OBLIGATIONS: Readonly<Record<'mcp-bridge' | 'sandbox' | 'protocol' | 'none', string>> = {
  'mcp-bridge': 'pass the permission tool to the CLI at spawn and declare the `timon_ask` MCP server',
  sandbox: 'freeze the privileges at spawn from `permission_mode`; there is no card and no classifier',
  protocol: 'supply `openSession`: its driver forwards the agent\'s permission requests to `host.requestPermission`',
  none: 'nothing — the CLI runs everything unguarded, which the UI says plainly',
};

/**
 * The permission modes an agent may be given, as stored in its config (the
 * Claude names: `canonicalPermissionMode` turns a sandbox name into one of
 * these before it is written). What a provider lists in
 * `PermissionStrategy.supportedModes`.
 */
export const PERMISSION_MODES = ['plan', 'default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** Where every mode a provider does not support lands: the one that runs no tool. */
export const UNSUPPORTED_MODE_FALLBACK: PermissionMode = 'plan';

/** The sandbox names, as the mode they mean (`canonicalPermissionMode`). */
const SANDBOX_NAMES: ReadonlyMap<string, PermissionMode> = new Map([
  ['read-only', 'plan'],
  ['workspace-write', 'auto'],
  ['danger-full-access', 'bypassPermissions'],
]);

/**
 * The mode an agent really runs in on a provider that declares the only modes
 * it can honour (`PermissionStrategy.supportedModes`).
 *
 * Fail-closed: a mode in the list (or the sandbox name of one) runs as itself,
 * anything else — another mode, an unset one, a typo — runs in `plan`. A mode
 * is never raised: a provider that cannot ask for an approval does not turn
 * `default` into `bypassPermissions`. No list = the provider honours every
 * mode, and `mode` is returned untouched.
 */
export function resolveSupportedPermissionMode(
  mode: string | null | undefined,
  supported: readonly string[] | null | undefined,
): string | undefined {
  if (!supported) return mode ?? undefined;
  if (typeof mode === 'string') {
    if (supported.includes(mode)) return mode;
    const named = SANDBOX_NAMES.get(mode);
    if (named && supported.includes(named)) return named;
  }
  return UNSUPPORTED_MODE_FALLBACK;
}
