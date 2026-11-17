/**
 * A 3D head is opaque wherever its body is: the fur drawn over the skin must
 * never let the background, or a head behind, show through. Every screen that
 * copies a head as a bitmap (the welcome's avalanche) shows the slightest
 * see-through alpha, so the fur's blending is checked here as GL would apply
 * it, without a GPU.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { furOpaqueOverSkin } from './engine';

type Rgba = readonly [number, number, number, number];

function factor(f: THREE.BlendingSrcFactor | THREE.BlendingDstFactor, src: Rgba, dst: Rgba): number {
  switch (f) {
    case THREE.ZeroFactor: return 0;
    case THREE.OneFactor: return 1;
    case THREE.SrcAlphaFactor: return src[3];
    case THREE.OneMinusSrcAlphaFactor: return 1 - src[3];
    case THREE.DstAlphaFactor: return dst[3];
    case THREE.OneMinusDstAlphaFactor: return 1 - dst[3];
    default: throw new Error(`blend factor ${String(f)} not modelled`);
  }
}

function combine(eq: THREE.BlendingEquation, s: number, d: number, sf: number, df: number): number {
  switch (eq) {
    case THREE.AddEquation: return s * sf + d * df;
    case THREE.MaxEquation: return Math.max(s, d);
    case THREE.MinEquation: return Math.min(s, d);
    default: throw new Error(`blend equation ${String(eq)} not modelled`);
  }
}

/** One sample a fragment covers, blended as WebGL's blendEquationSeparate / blendFuncSeparate would. */
function blend(mat: THREE.Material, src: Rgba, dst: Rgba): Rgba {
  assert.equal(mat.blending, THREE.CustomBlending);
  const eqA = mat.blendEquationAlpha ?? mat.blendEquation;
  const srcA = mat.blendSrcAlpha ?? mat.blendSrc;
  const dstA = mat.blendDstAlpha ?? mat.blendDst;
  const rgb = [0, 1, 2].map((i) => combine(mat.blendEquation, src[i] ?? 0, dst[i] ?? 0, factor(mat.blendSrc, src, dst), factor(mat.blendDst, src, dst)));
  return [rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0, combine(eqA, src[3], dst[3], factor(srcA, src, dst), factor(dstA, src, dst))];
}

function furMaterial(): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial();
  furOpaqueOverSkin(mat);
  return mat;
}

const SKIN: Rgba = [0.4, 0.25, 0.15, 1];
const EMPTY: Rgba = [0, 0, 0, 0];

test('a faint strand over the skin leaves the body opaque', () => {
  const mat = furMaterial();
  for (const a of [0.03, 0.2, 0.5, 0.97]) {
    const out = blend(mat, [0.6, 0.4, 0.3, a], SKIN);
    assert.equal(out[3], 1, `strand alpha ${a}`);
  }
});

test("a strand's colour replaces the skin's below it", () => {
  const out = blend(furMaterial(), [0.6, 0.4, 0.3, 0.2], SKIN);
  assert.deepEqual(out.slice(0, 3), [0.6, 0.4, 0.3]);
});

test('past the silhouette a strand keeps its own alpha, so the outline stays soft', () => {
  const out = blend(furMaterial(), [0.6, 0.4, 0.3, 0.2], EMPTY);
  assert.equal(out[3], 0.2);
});

test('the fur is drawn with alpha to coverage, among the opaque meshes', () => {
  const mat = furMaterial();
  assert.equal(mat.alphaToCoverage, true);
  // Sorted with the opaque meshes: the glass accessories, drawn after them, blend over a finished head.
  assert.equal(mat.transparent, false);
});
