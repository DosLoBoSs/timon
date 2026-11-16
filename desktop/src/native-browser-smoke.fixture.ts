/**
 * What every Electron smoke of the built-in browser lays out before it starts Electron: the engine
 * and its local modules transpiled into a temporary folder, the preloads, and the packages they import.
 */
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * Where the shell reads its languages from the sources. A transpiled `shell-i18n.js` looks for them
 * two folders above itself, which from a temporary folder is nowhere: a fixture that checks
 * translated text points the shell here (`useShellLocales`).
 */
export const SHELL_LOCALES_DIR = fileURLToPath(new URL('../../app/src/locales', import.meta.url));

/** `entries` and every local module they import, followed from their own import lines: a list kept by hand goes stale. */
export async function engineModules(entries: readonly string[] = ['native-browser']): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  const pending = [...entries];
  while (pending.length) {
    const name = pending.pop()!;
    if (sources.has(name)) continue;
    const source = await readFile(new URL(`./${name}.ts`, import.meta.url), 'utf8');
    sources.set(name, source);
    for (const match of source.matchAll(/(?:from|import) '\.\/([\w-]+)\.js'/g)) pending.push(match[1]!);
  }
  return sources;
}

export interface EngineLayout {
  /** The modules to start from, without extension; their local imports follow. */
  entries?: readonly string[];
  /** CommonJS preloads (`<name>.cts`), written as `<name>.cjs`. */
  preloads?: readonly string[];
  /** Appended to the compiled tab preload, for a spike that grafts its shape onto the production one. */
  preloadSuffix?: string;
}

/** Writes the engine into `root`, a fresh folder that Electron then runs a fixture from. */
export async function writeEngine(root: string, layout: EngineLayout = {}): Promise<void> {
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  // The engine's modules import packages (i18n) that resolve from the desktop's own dependencies.
  await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(root, 'node_modules'), 'junction');
  for (const [name, source] of await engineModules(layout.entries)) {
    await writeFile(join(root, `${name}.js`), ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText);
  }
  for (const name of layout.preloads ?? ['native-browser-preload']) {
    const compiled = ts.transpileModule(await readFile(new URL(`./${name}.cts`, import.meta.url), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    await writeFile(join(root, `${name}.cjs`), name === 'native-browser-preload' ? compiled + (layout.preloadSuffix ?? '') : compiled);
  }
}
