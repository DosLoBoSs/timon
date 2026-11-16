#!/usr/bin/env node
/**
 * Gathers the build-summary.json of each OS of a release candidate and writes a
 * Markdown recap: version, commit, channel, expiry, then per OS the installers
 * with their size and SHA-256. rc.yml appends it to the run's step summary.
 *
 *   node scripts/release/rc-summary.mjs <dir> --version <x.y.z-rc.N> --commit <sha>
 *        [--os linux,mac,windows]
 *
 * <dir> is searched recursively for build-summary.json. Each one is validated
 * (validateBuildSummary) and must be of the expected version and commit: three
 * jobs that built different commits are not one release candidate. The recap
 * is written even when an OS is missing or wrong, then the exit code is 1.
 * With GITHUB_STEP_SUMMARY set, the recap is appended to it; it is printed too.
 */
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { OS_NAMES, SUMMARY_FILE, validateBuildSummary } from './build-package.mjs';

const USAGE = 'Usage: node scripts/release/rc-summary.mjs <dir> --version <x.y.z-rc.N> --commit <sha> [--os linux,mac,windows]';

export function parseArgs(argv) {
  const opts = { dir: null, version: null, commit: null, os: Object.values(OS_NAMES) };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--version' || arg === '--commit' || arg === '--os') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value\n${USAGE}`);
      if (arg === '--os') opts.os = value.split(',').map((os) => os.trim()).filter(Boolean);
      else opts[arg.slice(2)] = value;
    } else if (!arg.startsWith('--') && opts.dir === null) opts.dir = arg;
    else throw new Error(`unexpected argument ${arg}\n${USAGE}`);
  }
  if (!opts.dir || !opts.version || !opts.commit) throw new Error(USAGE);
  const known = Object.values(OS_NAMES);
  if (!opts.os.length || opts.os.some((os) => !known.includes(os))) throw new Error(`--os takes ${known.join(', ')}`);
  return opts;
}

/** Every build-summary.json under `dir`, sorted. */
export function findSummaries(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === SUMMARY_FILE)
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name))
    .sort();
}

/**
 * Reads and checks the summaries. Returns the valid ones by OS and the
 * problems, without throwing: the recap shows what did arrive.
 */
export function collect(files, { version, commit, os }, read = (file) => readFileSync(file, 'utf8')) {
  const byOs = new Map();
  const problems = [];
  for (const file of files) {
    let summary;
    try { summary = validateBuildSummary(JSON.parse(read(file))); } catch (error) {
      problems.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (summary.version !== version) problems.push(`${summary.os}: built ${summary.version}, expected ${version}`);
    else if (summary.kind !== 'rc') problems.push(`${summary.os}: ${summary.version} is not a release candidate`);
    else if (summary.commit !== commit) problems.push(`${summary.os}: built commit ${summary.commit}, expected ${commit}`);
    else if (byOs.has(summary.os)) problems.push(`${summary.os}: more than one build summary`);
    else byOs.set(summary.os, summary);
  }
  for (const name of os) if (!byOs.has(name) && !problems.some((p) => p.startsWith(`${name}:`))) problems.push(`${name}: no build summary (the job failed or did not run)`);
  const channels = new Set([...byOs.values()].map((s) => s.channel));
  if (channels.size > 1) problems.push(`the systems disagree on the channel: ${[...channels].join(', ')}`);
  const expiries = new Set([...byOs.values()].map((s) => s.expiresAt ?? 'never'));
  if (expiries.size > 1) problems.push(`the systems disagree on the expiry: ${[...expiries].join(', ')}`);
  return { byOs, problems };
}

function size(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : `${bytes} B`;
}

export function renderMarkdown({ byOs, problems }, { version, commit, os }) {
  const first = [...byOs.values()][0];
  const lines = [
    `## Release candidate ${version}`,
    '',
    `- Commit: \`${commit}\``,
    `- Channel: ${first ? first.channel : 'unknown'}`,
    `- Expires: ${first ? first.expiresAt ?? 'never' : 'unknown'}`,
    '- Published: nowhere. The installers are this run\'s artifacts only; their daemon is signed with a key made for this run, not the release key.',
    '',
  ];
  if (problems.length) lines.push('### Problems', '', ...problems.map((p) => `- ${p}`), '');
  for (const name of os) {
    const summary = byOs.get(name);
    if (!summary) continue;
    const signing = summary.signing?.mode === 'identity' ? 'OS identity' : `no OS identity${summary.signing?.mac ? ` (${summary.signing.mac})` : ''}`;
    lines.push(
      `### ${name} (${summary.arch})`,
      '',
      `Built ${summary.builtAt} with Node ${summary.node}; signing: ${signing}.`,
      '',
      '| File | Format | Size | SHA-256 |',
      '| --- | --- | --- | --- |',
      ...summary.files.map((file) => `| ${file.name} | ${file.format} | ${size(file.size)} | \`${file.sha256}\` |`),
      '',
    );
  }
  return lines.join('\n');
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const opts = parseArgs(argv);
  const result = collect(findSummaries(resolve(opts.dir)), opts);
  const markdown = renderMarkdown(result, opts);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, markdown + '\n');
  console.log(markdown);
  if (result.problems.length) process.exitCode = 1;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
