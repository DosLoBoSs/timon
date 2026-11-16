// Rebuilds the 3D mascot from its sources: the seven skulls (build, rig, export, check renders), the accessories,
// then the app's model data (gen-data.mjs). Blender 4.4, run headless.
//
//   node tools/mascot-3d/build-all.mjs --blender <path to blender> --work <dir> [--skip-renders]
//
// <dir> receives the .blend files (Agent_<shape>.blend, Accessories.blend), the check renders and the JSON exports
// (exports/). Nothing is written in the repository except app/src/components/mascot/three/agent-data.json.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SHAPES = ['squircle', 'tri', 'gem', 'round', 'bean', 'cloud', 'hex'];

function option(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const blender = option('--blender');
const workArg = option('--work');
if (!blender || !workArg) {
  console.error('usage: node tools/mascot-3d/build-all.mjs --blender <path to blender> --work <dir> [--skip-renders]');
  process.exit(2);
}
const work = resolve(workArg);
const exportsDir = join(work, 'exports');
const renders = join(work, 'renders');
mkdirSync(exportsDir, { recursive: true });
mkdirSync(renders, { recursive: true });

/** Runs one Blender script headless; stops the whole build on the first failure. */
function run(script, args) {
  const r = spawnSync(blender, ['-b', '--factory-startup', '-P', join(here, 'blender', script), '--', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const log = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  for (const line of log.split(/\r?\n/)) if (/^(STRANDS|EXPORT)|Traceback|Error/.test(line)) console.log(`  ${line}`);
  if (r.error || r.status !== 0 || /Traceback/.test(log)) {
    console.error(`${script} failed${r.error ? `: ${r.error.message}` : ''}`);
    process.exit(1);
  }
}

for (const shape of SHAPES) {
  const blend = join(work, `Agent_${shape}.blend`);
  run('build_agent.py', ['--shape', shape, '--out', work]);
  run('rig_agent.py', ['--file', blend]);
  run('export_web.py', ['--file', blend, '--out', exportsDir]);
  if (!process.argv.includes('--skip-renders')) run('render_check.py', ['--file', blend, '--out', renders]);
  console.log(`done ${shape}`);
}
run('build_accessories.py', ['--out', work, '--data', exportsDir]);
console.log('done accessories');

const gen = spawnSync(process.execPath, [join(here, 'gen-data.mjs'), exportsDir], { stdio: 'inherit' });
process.exit(gen.status ?? 1);
