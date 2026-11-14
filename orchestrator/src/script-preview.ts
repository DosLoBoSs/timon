/**
 * What a shell command about to run would execute from the mission's own
 * folder, shown on its permission card.
 *
 * A card that shows only `./run_tests.sh` asks the human to approve a file
 * they never saw: a cloned repository can hide anything behind a familiar
 * name, and one click then runs it with the user's rights. When the command
 * runs a local file (a script by path, a script handed to an interpreter or to
 * `source`, an npm script, a make target), the card carries a bounded excerpt
 * of it and a fingerprint of the whole file.
 *
 * Nothing here ever executes anything: the command is parsed as text, the file
 * is opened read-only and non-blocking (a FIFO planted under a script's name
 * must not hang the daemon), and read no further than the bounds. Outside the
 * mission's folder, or behind a symbolic link that leads out of it, the file is
 * named but never read: the card says so instead.
 *
 * The parse is deliberately modest. It reads what an agent usually types
 * (`./x.sh`, `bash x.sh`, `cd sub && python run.py`, `npm test`, `make check`)
 * and says "could not be resolved" for what depends on the shell's own state
 * (`$VAR/x.sh`, `~/x`, globs). It is a reading aid for the human, not a
 * sandbox: the approval itself stays the human's.
 *
 * The fingerprint is checked again when the card is approved
 * (`scriptsChanged`): a file rewritten between the moment the human read it
 * and the moment they clicked is not what they approved.
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { safeResolve, sniffBinary } from './files.js';
import { toPosixRelative } from './host/portable-names.js';

export const PREVIEW_MAX_LINES = 40;
export const PREVIEW_MAX_BYTES = 4096;
/** A command chaining many scripts still gets a card of a readable size. */
export const MAX_PREVIEWS = 4;
/** Hashing stops there; past it the fingerprint adds the size and the mtime. */
const MAX_HASH_BYTES = 32 * 1024 * 1024;
/** A `package.json` larger than this is not parsed for its scripts. */
const MAX_MANIFEST_BYTES = 1024 * 1024;
/** npm scripts and make recipes are read for the files they run, this deep. */
const MAX_DEPTH = 2;

export type ScriptPreviewKind = 'file' | 'npm_script' | 'make_target';
/**
 * - `ok` / `binary`: read (a binary file shows no excerpt);
 * - `outside_cwd`, `symlink_outside`: named, never read;
 * - `missing`, `not_file`: nothing to read there;
 * - `unresolved`: the path depends on the shell (`$VAR`, `~`, a glob, a `cd` it cannot follow);
 * - `not_found`: the npm script is not in `package.json`.
 */
export type ScriptPreviewStatus =
  | 'ok' | 'binary' | 'outside_cwd' | 'symlink_outside' | 'missing' | 'not_file' | 'unresolved' | 'not_found';

export type ScriptPreview = {
  kind: ScriptPreviewKind;
  /** Relative to the mission's folder, forward slashes; as written by the agent when it was not read. */
  path: string;
  /** The npm script or the make target. */
  name?: string;
  status: ScriptPreviewStatus;
  size?: number;
  excerpt?: string;
  /** The excerpt stops before the end of the file. */
  truncated?: boolean;
  sha256?: string;
};

/** What the approval reads again. Kept in the daemon, never sent to the card. */
export type ScriptCheck = { root: string; rel: string; path: string; sha256: string };

export type ScriptPreviews = { previews: ScriptPreview[]; checks: ScriptCheck[] };

// ── Parsing ─────────────────────────────────────────────────────────────────

type Token = { word: string } | { op: string };

/** Shell words and operators, with quotes and escapes undone. No expansion. */
function tokenize(command: string): Token[] {
  const out: Token[] = [];
  let word = '';
  let started = false;
  const flush = (): void => {
    if (started) out.push({ word });
    word = '';
    started = false;
  };
  let i = 0;
  while (i < command.length) {
    const c = command[i]!;
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      word += command.slice(i + 1, end < 0 ? command.length : end);
      started = true;
      i = end < 0 ? command.length : end + 1;
      continue;
    }
    if (c === '"') {
      started = true;
      i++;
      while (i < command.length && command[i] !== '"') {
        const next = command[i + 1];
        if (command[i] === '\\' && next !== undefined && '"\\$`'.includes(next)) {
          word += next;
          i += 2;
          continue;
        }
        word += command[i];
        i++;
      }
      i++;
      continue;
    }
    if (c === '\\' && i + 1 < command.length) {
      if (command[i + 1] !== '\n') { word += command[i + 1]; started = true; }
      i += 2;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { flush(); i++; continue; }
    if (c === '<' || c === '>') {
      // `2>` names a descriptor, not a word of the command.
      if (/^\d+$/.test(word)) { word = ''; started = false; }
      flush();
      i++;
      if (command[i] === '>' || command[i] === '&' || command[i] === '<') i++;
      out.push({ op: 'redirect' });
      continue;
    }
    if (c === '\n' || c === ';' || c === '|' || c === '&' || c === '(' || c === ')') {
      flush();
      out.push({ op: c });
      i++;
      continue;
    }
    word += c;
    started = true;
    i++;
  }
  flush();
  return out;
}

/** The simple commands of a line, each as its words, redirections left out. */
function segments(command: string): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  let skipNext = false;
  for (const token of tokenize(command)) {
    if ('op' in token) {
      if (token.op === 'redirect') { skipNext = true; continue; }
      if (current.length) out.push(current);
      current = [];
      skipNext = false;
      continue;
    }
    if (skipNext) { skipNext = false; continue; }
    current.push(token.word);
  }
  if (current.length) out.push(current);
  return out;
}

/** `python3.12`, `/usr/bin/node`, `npm.cmd` → `python3.12`, `node`, `npm`. */
function commandName(word: string): string {
  const base = word.split(/[\\/]/).pop() ?? word;
  return base.toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Prefixes that run the command after them. */
const WRAPPERS = new Set(['env', 'time', 'nice', 'nohup', 'exec', 'command', 'builtin', 'sudo', 'doas']);
/** Their options that take a value as the next word. */
const WRAPPER_VALUE_FLAGS = new Set(['-u', '-g', '-C', '-D', '-h', '-U', '-r', '-t', '-n']);

/** The words of a simple command once its variable assignments and wrappers are dropped. */
function bareCommand(words: string[]): string[] {
  let i = 0;
  while (i < words.length) {
    const w = words[i]!;
    if (ASSIGNMENT.test(w)) { i++; continue; }
    if (!WRAPPERS.has(commandName(w))) break;
    i++;
    while (i < words.length && (words[i]!.startsWith('-') || ASSIGNMENT.test(words[i]!))) {
      if (WRAPPER_VALUE_FLAGS.has(words[i]!)) i++;
      i++;
    }
  }
  return words.slice(i);
}

type Interpreter = {
  /** Options whose code is on the command line itself: no file to show. */
  inline: ReadonlySet<string>;
  /** Options that take the next word as their value. */
  valued?: ReadonlySet<string>;
  /** Subcommands skipped before the file (`deno run x.ts`). */
  subcommands?: ReadonlySet<string>;
};

const SHELL: Interpreter = { inline: new Set(['-c']), valued: new Set(['-o', '-O']) };
const PYTHON: Interpreter = { inline: new Set(['-c', '-m']), valued: new Set(['-W', '-X']) };
const NODE: Interpreter = {
  inline: new Set(['-e', '--eval', '-p', '--print']),
  valued: new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions']),
  subcommands: new Set(['run']),
};
const PERL_RUBY: Interpreter = { inline: new Set(['-e', '-E']), valued: new Set(['-I', '-r']) };

function interpreterOf(name: string): Interpreter | null {
  if (['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'source', '.'].includes(name)) return SHELL;
  if (/^python[0-9.]*$/.test(name) || name === 'py' || name === 'pypy3') return PYTHON;
  if (['node', 'nodejs', 'tsx', 'ts-node', 'bun', 'deno'].includes(name)) return NODE;
  if (name === 'perl' || name === 'ruby') return PERL_RUBY;
  if (name === 'php') return { inline: new Set(['-r']) };
  return null;
}

/** The file an interpreter is handed, or null when its code is inline or on stdin. */
function interpretedFile(args: string[], interpreter: Interpreter): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-' || a === '--') return a === '--' ? args[i + 1] ?? null : null;
    if (interpreter.inline.has(a) || [...interpreter.inline].some((f) => f.startsWith('--') && a.startsWith(`${f}=`))) return null;
    if (a.startsWith('-')) {
      if (interpreter.valued?.has(a)) i++;
      continue;
    }
    if (i === 0 && interpreter.subcommands?.has(a)) continue;
    if (a === 'eval' || a === 'x') return null; // `deno eval`, `bun x`: no local file
    return a;
  }
  return null;
}

/** A path whose meaning depends on the shell: variable, home, glob, substitution. */
function shellDependent(path: string): boolean {
  return /[$`*?[\]{}]/.test(path) || path.startsWith('~');
}

function within(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

// ── Reading ─────────────────────────────────────────────────────────────────

type Located =
  | { status: 'ok'; real: string; rel: string }
  | { status: 'outside_cwd' | 'symlink_outside' | 'missing' | 'unresolved' };

/** Where `target` lands under `root`, through the same sandbox as the file browser. */
function locate(root: string, base: string | null, target: string): Located {
  if (shellDependent(target)) return { status: 'unresolved' };
  if (base === null && !isAbsolute(target)) return { status: 'unresolved' };
  const lexical = resolve(base ?? root, target);
  if (!within(root, lexical)) return { status: 'outside_cwd' };
  const rel = relative(root, lexical);
  let real: string;
  try {
    real = safeResolve(root, rel);
  } catch {
    return { status: 'symlink_outside' };
  }
  // A dangling link is not followed: `safeResolve` only resolves what exists.
  if (!existsSync(real)) return { status: 'missing' };
  return { status: 'ok', real, rel };
}

type Read = { kind: 'file'; size: number; head: Buffer; sha256: string } | { kind: 'missing' | 'not_file' };

function fingerprint(real: string): Read {
  let fd: number;
  try {
    // Non-blocking: opening a FIFO for reading would otherwise wait for a writer.
    fd = openSync(real, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch {
    return { kind: 'missing' };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { kind: 'not_file' };
    const hash = createHash('sha256');
    const chunk = Buffer.alloc(64 * 1024);
    const parts: Buffer[] = [];
    let kept = 0;
    let pos = 0;
    const limit = Math.min(st.size, MAX_HASH_BYTES);
    while (pos < limit) {
      const n = readSync(fd, chunk, 0, Math.min(chunk.length, limit - pos), pos);
      if (n <= 0) break;
      hash.update(chunk.subarray(0, n));
      if (kept < 8192) {
        const take = Math.min(n, 8192 - kept);
        parts.push(Buffer.from(chunk.subarray(0, take)));
        kept += take;
      }
      pos += n;
    }
    const digest = hash.digest('hex');
    const sha256 = st.size > MAX_HASH_BYTES ? `${digest}:${st.size}:${Math.round(st.mtimeMs)}` : digest;
    return { kind: 'file', size: st.size, head: Buffer.concat(parts), sha256 };
  } finally {
    closeSync(fd);
  }
}

/** The first lines of a text, within the bounds. */
function excerptOf(text: string, totalBytes: number): { excerpt: string; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8');
  const cut = bytes.length > PREVIEW_MAX_BYTES ? bytes.subarray(0, PREVIEW_MAX_BYTES).toString('utf8') : text;
  const lines = cut.split(/\r?\n/);
  const kept = lines.slice(0, PREVIEW_MAX_LINES);
  return {
    excerpt: kept.join('\n'),
    truncated: lines.length > PREVIEW_MAX_LINES || bytes.length > PREVIEW_MAX_BYTES || totalBytes > bytes.length,
  };
}

// ── Collecting ──────────────────────────────────────────────────────────────

type Collector = { root: string; previews: ScriptPreview[]; checks: ScriptCheck[]; seen: Set<string> };

function full(c: Collector): boolean {
  return c.previews.length >= MAX_PREVIEWS;
}

/** Records a file read through `locate` + `fingerprint`; null when it was not readable. */
function readInto(
  c: Collector, base: string | null, target: string, kind: ScriptPreviewKind, name?: string,
): { real: string; text: string | null; read: Extract<Read, { kind: 'file' }> } | null {
  const key = `${kind}:${base ?? ''}:${target}:${name ?? ''}`;
  if (c.seen.has(key) || full(c)) return null;
  c.seen.add(key);
  const located = locate(c.root, base, target);
  if (located.status !== 'ok') {
    c.previews.push({ kind, path: target, ...(name ? { name } : {}), status: located.status });
    return null;
  }
  const path = toPosixRelative(located.rel);
  const read = fingerprint(located.real);
  if (read.kind !== 'file') {
    c.previews.push({ kind, path, ...(name ? { name } : {}), status: read.kind });
    return null;
  }
  c.checks.push({ root: c.root, rel: located.rel, path, sha256: read.sha256 });
  const binary = sniffBinary(read.head);
  const preview: ScriptPreview = { kind, path, ...(name ? { name } : {}), status: binary ? 'binary' : 'ok', size: read.size, sha256: read.sha256 };
  c.previews.push(preview);
  return { real: located.real, text: binary ? null : read.head.toString('utf8'), read };
}

function previewFile(c: Collector, base: string | null, target: string): void {
  const got = readInto(c, base, target, 'file');
  if (!got || got.text === null) return;
  Object.assign(c.previews.at(-1)!, excerptOf(got.text, got.read.size));
}

const NPM_ALIASES: Record<string, string> = { t: 'test', tst: 'test', test: 'test', start: 'start', stop: 'stop', restart: 'restart' };
const RUN_WORDS = new Set(['run', 'run-script', 'rum', 'urn']);

/** The package script a package-manager command runs, or null. */
function packageScriptOf(manager: string, args: string[]): string | null {
  const words = args.filter((a) => !a.startsWith('-'));
  const sub = words[0];
  if (!sub) return null;
  if (RUN_WORDS.has(sub) && (manager === 'npm' || sub === 'run')) return words[1] ?? null;
  return NPM_ALIASES[sub] ?? null;
}

function previewPackageScript(c: Collector, base: string | null, manager: string, script: string, depth: number): void {
  const got = readInto(c, base, 'package.json', 'npm_script', script);
  if (!got || got.text === null) return;
  const preview = c.previews.at(-1)!;
  let scripts: Record<string, unknown> = {};
  try {
    if (got.read.size > MAX_MANIFEST_BYTES) throw new Error('too large');
    // Re-read in full only here: the head kept for the excerpt stops at 8 KB.
    const parsed = JSON.parse(readWhole(got.real, MAX_MANIFEST_BYTES)) as { scripts?: unknown };
    if (parsed.scripts && typeof parsed.scripts === 'object') scripts = parsed.scripts as Record<string, unknown>;
  } catch {
    Object.assign(preview, excerptOf(got.text, got.read.size));
    return;
  }
  // npm also runs `pre<name>` and `post<name>` around it; pnpm and yarn 2+ do not.
  const names = manager === 'npm' ? [`pre${script}`, script, `post${script}`] : [script];
  const lines = names.flatMap((n) => (typeof scripts[n] === 'string' ? [`${n}: ${scripts[n] as string}`] : []));
  if (typeof scripts[script] !== 'string') {
    preview.status = 'not_found';
    return;
  }
  Object.assign(preview, excerptOf(lines.join('\n'), 0));
  if (depth + 1 >= MAX_DEPTH) return;
  const dir = dirname(got.real);
  for (const n of names) {
    const body = scripts[n];
    if (typeof body === 'string') collect(c, body, dir, depth + 1);
  }
}

function readWhole(real: string, max: number): string {
  const fd = openSync(real, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) throw new Error('not readable');
    const buf = Buffer.alloc(st.size);
    let pos = 0;
    while (pos < st.size) {
      const n = readSync(fd, buf, pos, st.size - pos, pos);
      if (n <= 0) break;
      pos += n;
    }
    return buf.subarray(0, pos).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

const MAKEFILES = ['GNUmakefile', 'makefile', 'Makefile'];
const RULE = /^([^\s:#=][^:=#]*?)\s*::?(?!=)/;

/** The rule of `target` (its line and its recipe), or the first rule when no target is named. */
function makeRule(text: string, target: string | null): { name: string; block: string } | null {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = RULE.exec(lines[i]!);
    if (!m) continue;
    const names = m[1]!.trim().split(/\s+/);
    const hit = target ? names.includes(target) : names.find((n) => !n.startsWith('.') && !n.includes('%'));
    if (!hit) continue;
    const block = [lines[i]!];
    for (let j = i + 1; j < lines.length && (lines[j]!.startsWith('\t') || lines[j]!.trim() === ''); j++) {
      if (lines[j]!.trim() === '' && !(lines[j + 1] ?? '').startsWith('\t')) break;
      block.push(lines[j]!);
    }
    return { name: target ?? (hit as string), block: block.join('\n') };
  }
  return null;
}

function previewMakeTarget(c: Collector, base: string | null, args: string[], depth: number): void {
  let dir = base;
  let file: string | null = null;
  let target: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-C' || a === '--directory') { dir = changeDir(dir, args[++i]); continue; }
    if (a.startsWith('-C') && a.length > 2) { dir = changeDir(dir, a.slice(2)); continue; }
    if (a.startsWith('--directory=')) { dir = changeDir(dir, a.slice(12)); continue; }
    if (a === '-f' || a === '--file' || a === '--makefile') { file = args[++i] ?? null; continue; }
    if (a.startsWith('--file=') || a.startsWith('--makefile=')) { file = a.slice(a.indexOf('=') + 1); continue; }
    if (a.startsWith('-') || ASSIGNMENT.test(a)) continue;
    target ??= a;
  }
  // Probed only inside the folder: on Windows, testing a path on a share makes the machine authenticate to it.
  const probe = dir !== null && within(c.root, dir) ? dir : null;
  const name = file ?? (probe === null ? 'Makefile' : MAKEFILES.find((f) => existsSync(resolve(probe, f))) ?? 'Makefile');
  const got = readInto(c, dir, name, 'make_target', target ?? undefined);
  if (!got || got.text === null) return;
  const preview = c.previews.at(-1)!;
  let whole = got.text;
  try { whole = readWhole(got.real, MAX_MANIFEST_BYTES); } catch { /* the head is enough to show something */ }
  const rule = makeRule(whole, target);
  if (!rule) {
    Object.assign(preview, excerptOf(got.text, got.read.size));
    return;
  }
  preview.name = rule.name;
  Object.assign(preview, excerptOf(rule.block, 0));
  if (depth + 1 >= MAX_DEPTH) return;
  const makeDir = dirname(got.real);
  for (const line of rule.block.split('\n').slice(1)) {
    collect(c, line.replace(/^\t[@+-]*/, ''), makeDir, depth + 1);
  }
}

/** The folder after `cd <arg>`, or null when the shell alone knows it. */
function changeDir(dir: string | null, arg: string | undefined): string | null {
  if (!arg || arg === '-' || shellDependent(arg)) return null;
  if (isAbsolute(arg)) return resolve(arg);
  return dir === null ? null : resolve(dir, arg);
}

function collect(c: Collector, command: string, base: string | null, depth: number): void {
  let dir = base;
  for (const words of segments(command)) {
    if (full(c)) return;
    const w = bareCommand(words);
    const head = w[0];
    if (!head) continue;
    const name = commandName(head);
    const args = w.slice(1);
    if (name === 'cd' || name === 'pushd') { dir = changeDir(dir, args[0]); continue; }
    const interpreter = interpreterOf(name);
    if (interpreter) {
      const file = interpretedFile(args, interpreter);
      if (file !== null) previewFile(c, dir, file);
      continue;
    }
    if (name === 'npm' || name === 'pnpm' || name === 'yarn') {
      const script = packageScriptOf(name, args);
      if (script) previewPackageScript(c, dir, name, script, depth);
      continue;
    }
    if (name === 'make' || name === 'gmake') { previewMakeTarget(c, dir, args, depth); continue; }
    // A word with a separator names a file; a bare name is looked up on the PATH.
    if (/[\\/]/.test(head)) {
      // An absolute path outside the folder is an installed program, not the repository's.
      if (isAbsolute(head) && !shellDependent(head) && !within(c.root, resolve(head))) continue;
      previewFile(c, dir, head);
    }
  }
}

/**
 * The local files `command` would run from `cwd`, each with a bounded excerpt
 * and a fingerprint. Empty when it runs none (`ls`, `git status`). Never throws
 * for a file it cannot read: that is a status on the preview.
 */
export function scriptPreviews(command: string, cwd: string): ScriptPreviews {
  const root = realpathSync(cwd);
  const c: Collector = { root, previews: [], checks: [], seen: new Set() };
  collect(c, command, root, 0);
  return { previews: c.previews, checks: c.checks };
}

/**
 * The files whose content differs from the fingerprint the card showed, gone,
 * or now leading out of the folder. Empty when all still match.
 */
export function scriptsChanged(checks: readonly ScriptCheck[]): string[] {
  const changed: string[] = [];
  for (const check of checks) {
    const located = locate(check.root, check.root, check.rel);
    const read = located.status === 'ok' ? fingerprint(located.real) : null;
    if (!read || read.kind !== 'file' || read.sha256 !== check.sha256) changed.push(check.path);
  }
  return changed;
}
