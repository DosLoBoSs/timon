/**
 * The inline scripts a page renders carry the response's nonce (TODO #1002):
 * `script-src` no longer allows `'unsafe-inline'`, so one without it is
 * blocked by the browser, silently for the user — a theme painted late, an
 * import map missing and every plugin's browser half failing to load.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { ThemeProvider } from '../components/theme-provider';

// The components predate the automatic JSX runtime and expect `React` in scope.
Object.defineProperty(globalThis, 'React', { value: React, configurable: true, writable: true });

const SRC = fileURLToPath(new URL('..', import.meta.url));

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return path.endsWith('.tsx') ? [path] : [];
  });
}

test('every <script> element written in JSX takes a nonce', () => {
  const missing: string[] = [];
  let scripts = 0;
  for (const file of tsxFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('<script')) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node): void => {
      const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
      if (opening && opening.tagName.getText(source) === 'script') {
        scripts += 1;
        const named = opening.attributes.properties.some((p) => ts.isJsxAttribute(p) && p.name.getText(source) === 'nonce');
        if (!named) {
          const { line } = source.getLineAndCharacterOfPosition(opening.getStart(source));
          missing.push(`${relative(SRC, file)}:${line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.ok(scripts >= 2, 'the root layout writes the import map and the onboarding scheme script');
  assert.deepEqual(missing, [], 'inline <script> without a nonce: the browser blocks it');
});

test('the theme script next-themes writes carries the nonce on the server', () => {
  const nonce = 'q2xV0rN6aYk3f8Lm1PzT4w==';
  const html = renderToStaticMarkup(React.createElement(ThemeProvider, { nonce, initialScheme: 'dark', children: React.createElement('main') }));
  const tags = html.match(/<script\b[^>]*>/g) ?? [];
  assert.ok(tags.length > 0, 'next-themes renders its pre-paint script');
  for (const tag of tags) assert.ok(tag.includes(`nonce="${nonce}"`), tag);
});
