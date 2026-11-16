// Gathers the Blender exports of the 3D mascot into the app's model data,
// app/src/components/mascot/three/agent-data.json, quantised: positions and UVs on 16 bits, normals and
// weights on 8, rig poses in half floats. At avatar sizes the loss cannot be seen, and the file weighs a
// third of its float32 form.
//
//   node tools/mascot-3d/gen-data.mjs <exports dir>
//
// <exports dir> holds what build-all.mjs wrote: agent_<shape>.json (blender/export_web.py, one per skull)
// and accessories.json (blender/build_accessories.py). The output is deterministic: the same exports give
// the same file, byte for byte.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(repo, 'app', 'src', 'components', 'mascot', 'three', 'agent-data.json');
const dir = process.argv[2] ? resolve(process.argv[2]) : null;
if (!dir) {
  console.error('usage: node tools/mascot-3d/gen-data.mjs <exports dir>');
  process.exit(2);
}

const f32 = (b) => { const u = Buffer.from(b, 'base64'); return new Float32Array(u.buffer, u.byteOffset, u.length / 4); };
const u32 = (b) => { const u = Buffer.from(b, 'base64'); return new Uint32Array(u.buffer, u.byteOffset, u.length / 4); };
const b64 = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');

/** A float as IEEE half precision: the rig poses lose nothing visible and weigh half. */
const f1 = new Float32Array(1);
const i1 = new Uint32Array(f1.buffer);
function half(v) {
  f1[0] = v;
  const x = i1[0], sg = (x >>> 16) & 0x8000, e = ((x >>> 23) & 0xff) - 112, m = x & 0x7fffff;
  if (e <= 0) return e < -10 ? sg : sg | ((((m | 0x800000) >> (1 - e)) + 0x1000) >> 13);
  if (e >= 31) return sg | 0x7c00;
  return (sg | (e << 10) | (m >> 13)) + ((m >> 12) & 1);
}

/** `n` components per item, each mapped from its own [lo, hi] onto the integer range of `T`. */
function quant(a, n, T) {
  const max = T === Uint16Array ? 65535 : 255;
  const lo = Array(n).fill(Infinity), hi = Array(n).fill(-Infinity);
  for (let i = 0; i < a.length; i++) { const c = i % n; lo[c] = Math.min(lo[c], a[i]); hi[c] = Math.max(hi[c], a[i]); }
  const q = new T(a.length);
  for (let i = 0; i < a.length; i++) { const c = i % n; q[i] = hi[c] > lo[c] ? Math.round(((a[i] - lo[c]) / (hi[c] - lo[c])) * max) : 0; }
  return { k: max === 255 ? 'q8' : 'q16', n, lo, hi, d: b64(q) };
}
const raw8 = (a) => ({ k: 'u8', d: b64(Uint8Array.from(a)) });
function index(b) {
  const a = u32(b);
  if (a.some((v) => v > 65535)) throw new Error('mesh too large for 16-bit indices');
  return { k: 'u16', d: b64(Uint16Array.from(a)) };
}
function body(B) {
  return {
    pos: quant(f32(B.pos), 3, Uint16Array), nrm: quant(f32(B.nrm), 3, Uint8Array),
    fur: quant(f32(B.fur), 1, Uint8Array), ear: quant(f32(B.ear), 1, Uint8Array),
    // Bone indices stay exact integers: the shader reads them with int().
    j: raw8(f32(B.j)), w: quant(f32(B.w), 2, Uint8Array), idx: index(B.idx),
  };
}

const shapes = {};
for (const f of readdirSync(dir).filter((n) => /^agent_[a-z]+\.json$/.test(n)).sort()) {
  const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  shapes[f.slice(6, -5)] = {
    ...d, body: body(d.body), bodyLo: body(d.bodyLo), anim: { ...d.anim, data: b64(Uint16Array.from(f32(d.anim.data), half)) },
    visor: { pos: quant(f32(d.visor.pos), 3, Uint16Array), nrm: quant(f32(d.visor.nrm), 3, Uint8Array), uv: quant(f32(d.visor.uv), 2, Uint16Array), idx: index(d.visor.idx) },
  };
}
if (!shapes.squircle) throw new Error('the classic skull (agent_squircle.json) is missing');
// The accessories (blender/build_accessories.py): colours are already bytes, indices already 16-bit.
const acc = JSON.parse(readFileSync(join(dir, 'accessories.json'), 'utf8'));
const accessories = {};
for (const [name, a] of Object.entries(acc)) {
  accessories[name] = { tilt: a.tilt, pos: quant(f32(a.pos), 3, Uint16Array), nrm: quant(f32(a.nrm), 3, Uint8Array), col: a.col, idx: { k: 'u16', d: a.idx } };
}
const generated = 'Generated from the Blender exports of the 3D plush mascot (seven skulls, their rig poses and visors, and the accessories). Do not edit by hand.';
const text = JSON.stringify({ generated, shapes, accessories });
writeFileSync(out, text);
console.log('agent-data.json:', Object.keys(shapes).join(' '), '+', Object.keys(accessories).length, 'accessories,', Math.round(text.length / 1024), 'KB');
