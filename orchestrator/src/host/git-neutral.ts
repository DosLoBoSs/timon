/**
 * The daemon's own `git`, made unable to run anything a mission wrote
 * (GHSA-f58g, V6 of the mission fence).
 *
 * The daemon runs git in mission worktrees and in the repositories they come
 * from: code gate, worktree refresh and merge, statusline, Git widget, push.
 * A mission writes its worktree, the repository's `.git` (it commits there, the
 * fence keeps it writable) and, as long as no fence applies, `~/.gitconfig`.
 * Git executes a lot from those files: hooks, `core.fsmonitor`, filter and
 * merge drivers named in `.gitattributes`, credential helpers, the SSH command,
 * `uploadpack` on a local remote, the signing program. Each one is code the
 * mission chose, run by the daemon, outside any fence.
 *
 * Every git call of the adapter therefore goes through `neutralGitCall`:
 *
 * - **Fixed overrides**, whatever the configuration says: no fsmonitor, a hooks
 *   folder that never holds anything, no editor, no pager, no `ext::` transport,
 *   no signature check in `log`. The daemon never needs any of them.
 * - **Diff drivers**: `--no-ext-diff --no-textconv` on `diff`, `log` and `show`,
 *   the only porcelain commands of the daemon that render a diff.
 * - **Scanned overrides**: the configuration is read once per call, with the
 *   scope of each value (`git config --list --show-scope`). A command-running
 *   key set by a scope a mission writes (`local`, `worktree`, a file they
 *   include) is replaced by the value system or global configuration gives it,
 *   else by a neutral one. The user's own credential helper, SSH command or Git
 *   LFS keep working; the one a mission planted in `.git/config` never runs.
 *   Pure ref reads skip the scan: they run nothing configurable.
 * - **PATH** loses every entry a mission can write (`mission-writable.ts`), so
 *   the `ssh`, `gpg` or `git-lfs` git starts cannot be one a mission planted.
 *
 * Known gaps, kept for the fence (V3, V4) to close: the configuration of a
 * submodule is not scanned; the hooks and configuration of a local remote
 * (`file://`) run on its side of a push; a value can change between the scan
 * and the call.
 */
import { lstatSync, rmSync } from 'node:fs';
import { delimiter, join, win32 } from 'node:path';
import { TIMON_HOME } from '../paths.js';
import { missionWritableProblem } from './mission-writable.js';

/** A configuration value and the scope git read it from. `value` is null for
 *  a key written without `=` (an implicit `true`). */
export type GitConfigEntry = { scope: string; key: string; value: string | null };

/** Scopes a mission cannot write once fenced. `command` is `-c` or
 *  `GIT_CONFIG_PARAMETERS` from the daemon's own environment. */
const TRUSTED_SCOPES: ReadonlySet<string> = new Set(['system', 'global', 'command']);

/** The values `git lfs install` writes: kept from any scope, so a repository
 *  set up with `git lfs install --local` still reads its files as content. */
const LFS_FILTER_VALUES: Readonly<Record<string, string>> = Object.freeze({
  clean: 'git-lfs clean -- %f',
  smudge: 'git-lfs smudge -- %f',
  process: 'git-lfs filter-process',
});

/** What git's built-in text merge does, as an external driver: a planted
 *  driver is replaced by the merge it stands in for, not by a conflict. */
const NEUTRAL_MERGE_DRIVER = 'git merge-file --marker-size=%L %A %O %B';

type KeyRule = {
  match: RegExp;
  /** The value to pass when no trusted scope sets one. */
  neutral: (key: string, value: string | null) => string;
  /** A value safe to keep even from a scope a mission writes. */
  keep?: (key: string, value: string | null) => boolean;
  /** Multi-valued key: an empty value resets the list, trusted values follow. */
  list?: true;
};

const KEY_RULES: readonly KeyRule[] = [
  { match: /^core\.sshcommand$/, neutral: () => 'ssh' },
  { match: /^core\.askpass$/, neutral: () => '' },
  {
    match: /^filter\..+\.(clean|smudge|process)$/,
    neutral: () => '',
    keep: (key, value) => {
      const m = /^filter\.lfs\.(clean|smudge|process)$/.exec(key);
      return !!m && value === LFS_FILTER_VALUES[m[1]!];
    },
  },
  {
    match: /^merge\..+\.driver$/,
    neutral: () => NEUTRAL_MERGE_DRIVER,
    keep: (_key, value) => value === 'true' || value === 'false',
  },
  { match: /^credential\.(.+\.)?helper$/, neutral: () => '', list: true },
  { match: /^gpg\.program$/, neutral: () => 'gpg' },
  { match: /^gpg\.openpgp\.program$/, neutral: () => 'gpg' },
  { match: /^gpg\.x509\.program$/, neutral: () => 'gpgsm' },
  { match: /^gpg\.ssh\.program$/, neutral: () => 'ssh-keygen' },
  { match: /^gpg\.ssh\.defaultkeycommand$/, neutral: () => '' },
  {
    match: /^submodule\..+\.update$/,
    neutral: () => 'checkout',
    keep: (_key, value) => !value?.startsWith('!'),
  },
];

/** Subcommands that only read refs, objects or settings: nothing they do runs a
 *  configured command, so they skip the scan (the fixed overrides still apply). */
const SCAN_FREE: ReadonlySet<string> = new Set([
  'rev-parse', 'rev-list', 'merge-base', 'for-each-ref', 'show-ref', 'symbolic-ref',
  'config', 'ls-tree', 'var', 'version', 'check-ignore', 'check-ref-format',
  'update-ref', 'branch',
]);

/** Porcelain commands that may render a diff through a configured driver. */
const DIFF_COMMANDS: ReadonlySet<string> = new Set(['diff', 'log', 'show']);

/** `remote.<name>.uploadpack` and `receivepack` keep the FIRST value read, so
 *  `-c` cannot outrank a planted one: the command-line option can, on the
 *  commands that take it. The others that may start a transport are refused. */
const UPLOAD_PACK_COMMANDS: ReadonlySet<string> = new Set(['fetch', 'pull', 'ls-remote', 'clone']);
const RECEIVE_PACK_COMMANDS: ReadonlySet<string> = new Set(['push']);
const OTHER_TRANSPORT_COMMANDS: ReadonlySet<string> = new Set(['remote', 'submodule', 'archive', 'fetch-pack', 'send-pack']);

/** Never created: a hooks folder that does not exist holds no hook. Removed
 *  when something appears there, the daemon being its only user. */
export function gitHooksNoneDir(home = TIMON_HOME): string {
  return join(home, 'run', 'git-hooks-none');
}

function emptyHooksDir(dir: string): void {
  try {
    lstatSync(dir);
  } catch {
    return;
  }
  rmSync(dir, { recursive: true, force: true });
}

/** `-c` pairs applied to every call of the daemon. */
export function fixedGitConfig(home = TIMON_HOME): string[] {
  return [
    'core.fsmonitor=false',
    `core.hooksPath=${gitHooksNoneDir(home)}`,
    'core.editor=:',
    'sequence.editor=:',
    'core.pager=cat',
    'protocol.ext.allow=never',
    'log.showSignature=false',
  ];
}

type ParsedCall = {
  /** Options before the subcommand that say WHERE git works (`-C`, `--git-dir`…). */
  location: string[];
  /** Index of the subcommand in `args`, -1 when there is none (`--version`). */
  commandIndex: number;
};

const GLOBAL_WITH_VALUE: ReadonlySet<string> = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
const LOCATION_OPTIONS: ReadonlySet<string> = new Set(['-C', '--git-dir', '--work-tree', '--namespace', '--bare']);

function parseCall(args: readonly string[]): ParsedCall {
  const location: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('-')) return { location, commandIndex: i };
    const name = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    const takesNext = !arg.includes('=') && GLOBAL_WITH_VALUE.has(arg);
    if (LOCATION_OPTIONS.has(name)) location.push(...(takesNext ? [arg, args[i + 1] ?? ''] : [arg]));
    if (takesNext) i++;
  }
  return { location, commandIndex: -1 };
}

/**
 * The `git config` reads that tell where each value comes from, for a call
 * that needs them: the scoped listing (git ≥ 2.26), then the plain one, whose
 * values count as untrusted. Null when the call runs nothing configurable.
 */
export function gitScanArgs(args: readonly string[]): { scoped: string[]; plain: string[] } | null {
  const { location, commandIndex } = parseCall(args);
  if (commandIndex < 0 || SCAN_FREE.has(args[commandIndex]!)) return null;
  const base = [...location, '--no-pager', 'config', '--list', '-z'];
  return { scoped: [...base, '--show-scope'], plain: base };
}

/** `git config --list -z [--show-scope]`: `[scope NUL] key LF value NUL`, or
 *  `key NUL` for a key written without a value. */
export function parseGitConfigList(raw: string, scoped: boolean): GitConfigEntry[] {
  const fields = raw.split('\0');
  if (fields[fields.length - 1] === '') fields.pop();
  const out: GitConfigEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const scope = scoped ? fields[i++] ?? '' : 'unknown';
    const field = fields[i];
    if (field === undefined) break;
    const newline = field.indexOf('\n');
    out.push(newline < 0
      ? { scope, key: field, value: null }
      : { scope, key: field.slice(0, newline), value: field.slice(newline + 1) });
  }
  return out;
}

/**
 * `-c` pairs replacing every command-running value an untrusted scope set.
 * `refused` names a key `-c` cannot reach: git splits `-c` at the first `=`,
 * so a subsection holding one (`[credential "https://a=b"]`) would override
 * another key and leave the planted value in force.
 */
export type ScannedGitConfig = {
  config: string[];
  env: Record<string, string>;
  /** A scope a mission writes names the program a transport starts. */
  plantedUploadPack?: true;
  plantedReceivePack?: true;
  refused?: string;
};

export function scannedGitConfig(entries: readonly GitConfigEntry[]): ScannedGitConfig {
  const config: string[] = [];
  const env: Record<string, string> = {};
  const out: ScannedGitConfig = { config, env };
  const byKey = new Map<string, GitConfigEntry[]>();
  for (const entry of entries) {
    const key = entry.key;
    byKey.set(key, [...(byKey.get(key) ?? []), entry]);
  }
  const neutralizedFilters = new Set<string>();
  for (const [key, list] of byKey) {
    // `core.gitProxy` keeps the FIRST matching value, so a later `-c` cannot
    // outrank a planted one; the environment variable is read before any file.
    if (key === 'core.gitproxy') {
      if (list.some((e) => !TRUSTED_SCOPES.has(e.scope))) env.GIT_PROXY_COMMAND = '';
      continue;
    }
    if (/^remote\..+\.(uploadpack|receivepack)$/.test(key)) {
      if (!list.some((e) => !TRUSTED_SCOPES.has(e.scope))) continue;
      if (key.endsWith('.uploadpack')) out.plantedUploadPack = true;
      else out.plantedReceivePack = true;
      continue;
    }
    const rule = KEY_RULES.find((r) => r.match.test(key));
    if (!rule) continue;
    const untrusted = list.filter((e) => !TRUSTED_SCOPES.has(e.scope) && !rule.keep?.(key, e.value));
    if (untrusted.length === 0) continue;
    if (key.includes('=')) return { config: [], env: {}, refused: key };
    const trusted = list.filter((e) => TRUSTED_SCOPES.has(e.scope));
    if (rule.list) {
      config.push(`${key}=`, ...trusted.map((e) => `${key}=${e.value ?? ''}`));
    } else {
      const last = trusted[trusted.length - 1];
      config.push(`${key}=${last ? last.value ?? 'true' : rule.neutral(key, untrusted[0]!.value)}`);
    }
    const filter = /^filter\.(.+)\.(clean|smudge|process)$/.exec(key);
    if (filter) neutralizedFilters.add(filter[1]!);
  }
  // A filter left without a command must not fail the checkout it guards.
  for (const name of neutralizedFilters) config.push(`filter.${name}.required=false`);
  return out;
}

/** The environment's PATH minus every entry a mission can write, a relative
 *  entry first of all: git resolves `ssh` or `git-lfs` in the worktree it runs
 *  in when PATH holds `.` or an empty entry. */
export function neutralGitEnv(
  base: NodeJS.ProcessEnv,
  options: { platform?: NodeJS.Platform; timonHome?: string } = {},
): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  const separator = platform === 'win32' ? ';' : platform === process.platform ? delimiter : ':';
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(env)) {
    if (!(platform === 'win32' ? key.toUpperCase() === 'PATH' : key === 'PATH')) continue;
    const entries = (env[key] ?? '').split(separator);
    env[key] = entries.filter((dir) => !missionWritableProblem(
      platform === 'win32' ? win32.normalize(dir || '.') : dir,
      { platform, ...(options.timonHome ? { timonHome: options.timonHome } : {}) },
    )).join(separator);
  }
  return env;
}

/**
 * The arguments and environment of a daemon git call. `entries` is the result
 * of the scan `gitScanArgs` asked for, null when none was needed: a scan that
 * failed stops the call instead (`generic.ts`). `refused`: the call must not
 * run at all.
 */
export function neutralGitCall(
  args: readonly string[],
  entries: readonly GitConfigEntry[] | null,
  baseEnv: NodeJS.ProcessEnv,
  options: { platform?: NodeJS.Platform; timonHome?: string } = {},
): { args: string[]; env: NodeJS.ProcessEnv } | { refused: string } {
  const home = options.timonHome ?? TIMON_HOME;
  emptyHooksDir(gitHooksNoneDir(home));
  const scanned: ScannedGitConfig = entries ? scannedGitConfig(entries) : { config: [], env: {} };
  if (scanned.refused) {
    return { refused: `git refused: the repository configuration sets "${scanned.refused}", which Timon cannot neutralize` };
  }
  const config = [...fixedGitConfig(home), ...scanned.config].flatMap((pair) => ['-c', pair]);
  const out = [...args];
  const { commandIndex } = parseCall(args);
  const command = commandIndex >= 0 ? args[commandIndex]! : '';
  const flags: string[] = [];
  if (DIFF_COMMANDS.has(command)) flags.push(...['--no-ext-diff', '--no-textconv'].filter((flag) => !args.includes(flag)));
  if (scanned.plantedUploadPack && UPLOAD_PACK_COMMANDS.has(command)) flags.push('--upload-pack=git-upload-pack');
  if (scanned.plantedReceivePack && RECEIVE_PACK_COMMANDS.has(command)) flags.push('--receive-pack=git-receive-pack');
  if ((scanned.plantedUploadPack || scanned.plantedReceivePack) && OTHER_TRANSPORT_COMMANDS.has(command)) {
    return { refused: `git refused: the repository configuration names the program "git ${command}" would start on the remote side` };
  }
  out.splice(commandIndex + 1, 0, ...flags);
  const env = neutralGitEnv(baseEnv, options);
  for (const [key, value] of Object.entries(scanned.env)) {
    if (env[key] === undefined) env[key] = value;
  }
  return { args: ['--no-pager', ...config, ...out], env };
}
