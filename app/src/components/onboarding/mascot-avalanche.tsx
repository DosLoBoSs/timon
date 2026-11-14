'use client';

/**
 * The welcome screen's avalanche on a canvas (docs/ONBOARDING.md). The scene
 * is `avalanche.ts`; this file paints it, lets the reader grab a mascot, and
 * flings them all out on `scatter()`.
 *
 * The mascots are the `agent.mascot` slot's drawing: each look is mounted once
 * through `AgentMascotHost` (so a plugin that replaces the mascot replaces it
 * here too) and copied into a bitmap — a hundred live heads would not hold
 * sixty frames a second. Each head starts as its 2D drawing (an SVG,
 * serialised and rasterised), so the scene falls at once; a 3D head's bitmap
 * is then swapped for its canvas once the engine has drawn the modelled head.
 * The cast stays mounted until every head is copied, and mounts again in the
 * other style when the mascot style changes (the welcome's 3D / 2D switch):
 * the falling heads keep their old bitmaps until the new ones are drawn.
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactElement } from 'react';
import { AgentMascotHost, usePrefersReducedMotion } from '@/components/mascot/agent-mascot';
import { skullSize } from '@/components/mascot/mascot-geometry';
import { useMascot3D, type MascotStyle } from '@/components/mascot/mascot-style-pref';
import {
  avalancheLooks, bodyAt, buildAvalanche, dragTo, drawOrder, grab, release, resizeAvalanche, scatter, stepAvalanche,
  type Avalanche,
} from './avalanche';

const BITMAP = 360;
/** Physics substep: small enough that a fast fall never skips through a head. */
const SUBSTEP = 0.008;
/** A window dragged to a new size fires dozens of resizes: the heaps are laid out once it stops. */
const RELAYOUT_MS = 120;

export type MascotAvalancheHandle = {
  /** "Continue": everyone is flung off screen. */
  scatter: () => void;
};

/** How long a 3D head may take to come (models loading on a slow machine): past it, the 2D head stays. */
const HEAD_WAIT_MS = 30000;

/** A 3D head's canvas copied into a bitmap once the engine has drawn the modelled head (`data-drawn`), else null. */
async function copyHead(head: HTMLCanvasElement): Promise<HTMLCanvasElement | null> {
  const start = performance.now();
  while (head.dataset.drawn !== '3d') {
    if (performance.now() - start > HEAD_WAIT_MS || !head.isConnected) return null;
    await new Promise<void>((resolve) => { setTimeout(resolve, 100); });
  }
  if (!head.width || !head.height) return null;
  const canvas = document.createElement('canvas');
  canvas.width = BITMAP;
  canvas.height = BITMAP;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(head, 0, 0, BITMAP, BITMAP);
  return canvas;
}

async function rasterize(svg: SVGSVGElement): Promise<HTMLCanvasElement | null> {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(BITMAP));
  clone.setAttribute('height', String(BITMAP));
  const markup = new XMLSerializer().serializeToString(clone);
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = BITMAP;
  canvas.height = BITMAP;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0, BITMAP, BITMAP);
  return canvas;
}

function paint(ctx: CanvasRenderingContext2D, world: Avalanche, bitmaps: readonly (HTMLCanvasElement | null)[], dpr: number, w: number, h: number): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  for (const b of drawOrder(world)) {
    const bitmap = bitmaps[b.look];
    if (!bitmap) continue;
    const sy = Math.max(0.7, Math.min(1.25, b.sq));
    const sx = 1 / Math.sqrt(sy);
    ctx.save();
    // Squash from the head's base, so a landing presses it into the heap.
    ctx.translate(b.x, b.y + b.vb + b.boff);
    ctx.rotate(b.lean);
    ctx.scale(sx, sy);
    ctx.drawImage(bitmap, -b.size / 2, -b.vb - b.oy - b.size / 2, b.size, b.size);
    ctx.restore();
  }
}

export const MascotAvalanche = forwardRef<MascotAvalancheHandle, { className?: string }>(function MascotAvalanche({ className }, ref): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const castRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<Avalanche | null>(null);
  const bitmaps = useRef<(HTMLCanvasElement | null)[]>([]);
  const [ready, setReady] = useState(false);
  /** The style whose bitmaps are all drawn: the cast is mounted while it differs from the one shown. */
  const [drawn, setDrawn] = useState<MascotStyle | null>(null);
  const style: MascotStyle = useMascot3D() ? '3d' : '2d';
  const reduced = usePrefersReducedMotion();
  const looks = useMemo(() => avalancheLooks(), []);

  useImperativeHandle(ref, () => ({
    scatter: () => { if (worldRef.current) scatter(worldRef.current); },
  }), []);

  // Rasterise the cast a frame after it mounted (a plugin's occupant may paint late), again at each change of style.
  useEffect(() => {
    let alive = true;
    const frame = requestAnimationFrame(() => {
      const cells = Array.from(castRef.current?.querySelectorAll<HTMLElement>('[data-avalanche-look]') ?? []);
      // Back to the style already drawn before the other one was: its bitmaps are still the ones falling.
      if (cells.length === 0) return;
      const next: (HTMLCanvasElement | null)[] = [];
      const heads: Promise<void>[] = [];
      void Promise.all(cells.map(async (cell, i) => {
        const head = cell.querySelector('canvas');
        const svg = cell.querySelector('svg');
        next[i] = svg ? await rasterize(svg).catch(() => null) : null;
        // The 3D head replaces it when it comes; the frame loop reads the array, so the swap shows by itself.
        if (head) heads.push(copyHead(head).then((bitmap) => { if (alive && bitmap) next[i] = bitmap; }).catch(() => undefined));
      })).finally(() => {
        if (!alive) return;
        // The whole set at once: a scene already falling never shows a gap between two styles.
        bitmaps.current = next;
        setReady(true);
        // Until its 3D heads are in, no style is fully drawn: a switch back must mount the cast again.
        setDrawn(null);
        void Promise.all(heads).then(() => { if (alive) setDrawn(style); });
      });
    });
    return () => { alive = false; cancelAnimationFrame(frame); };
  }, [style]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!ready || !canvas || !ctx) return undefined;
    let dpr = 1;
    let w = 0;
    let h = 0;
    const measure = (): void => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    };
    measure();
    const heads = looks.map((look) => skullSize(look.shape));
    let world = buildAvalanche({ width: w, height: h, looks: heads, still: reduced });
    worldRef.current = world;
    let relayout = 0;
    // The canvas follows the window at once (a stretched bitmap would blur); the heaps follow it once it stops.
    const resize = (): void => {
      measure();
      window.clearTimeout(relayout);
      relayout = window.setTimeout(() => {
        const next = resizeAvalanche(world, w, h, heads);
        if (next === world) return;
        // A mascot in hand is dropped with the old scene.
        world = next;
        worldRef.current = world;
        canvas.style.cursor = '';
      }, RELAYOUT_MS);
    };
    window.addEventListener('resize', resize);

    const point = (e: PointerEvent): { x: number; y: number; t: number } => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top, t: performance.now() };
    };
    const onDown = (e: PointerEvent): void => {
      const p = point(e);
      if (!grab(world, p.x, p.y, p.t)) return;
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'grabbing';
    };
    const onMove = (e: PointerEvent): void => {
      const p = point(e);
      if (world.drag) dragTo(world, p.x, p.y, p.t);
      else canvas.style.cursor = world.floor && bodyAt(world, p.x, p.y) ? 'grab' : '';
    };
    const onUp = (): void => {
      if (!world.drag) return;
      release(world);
      canvas.style.cursor = '';
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);

    let raf = 0;
    let prev = performance.now();
    const frame = (now: number): void => {
      const dt = Math.min(0.1, (now - prev) / 1000);
      prev = now;
      const n = Math.max(2, Math.ceil(dt / SUBSTEP));
      for (let k = 0; k < n; k += 1) stepAvalanche(world, dt / n);
      paint(ctx, world, bitmaps.current, dpr, w, h);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(relayout);
      window.removeEventListener('resize', resize);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      worldRef.current = null;
    };
    // The scene is built once: a change of motion preference mid-avalanche keeps the heaps where they are.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, looks]);

  return (
    <>
      <canvas ref={canvasRef} aria-hidden className={className} />
      {drawn !== style && (
        <div key={style} ref={castRef} aria-hidden data-avalanche-cast={style} className="pointer-events-none fixed left-0 top-0 h-0 w-0 overflow-hidden opacity-0">
          {looks.map((look, i) => (
            <div key={i} data-avalanche-look="">
              <AgentMascotHost look={look} size={200} fit shadow={false} />
            </div>
          ))}
        </div>
      )}
    </>
  );
});
