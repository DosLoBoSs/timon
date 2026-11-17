// ---------------------------------------------------------------------------
// three.js scene of the vault graph — instanced rendering.
//
// WHY THIS MODULE EXISTS
//
// `3d-force-graph` creates one three.js object PER graph element: a sphere
// `Mesh` per node and — as soon as `linkWidth` is non-zero — a cylinder `Mesh`
// per link. On the vault (496 nodes, 2,415 links) that is 2,911 objects in the
// scene, so ~2,900 draw calls and as many world-matrix updates, frustum tests
// and uniform uploads, ON EVERY FRAME.
//
// Measured on 2026-08-26: 25,212 draw calls/s, 17,000 `uniformMatrix4fv`/s.
// Above all, with draw calls neutralised at the WebGL context level, the cost
// only fell from 18.5% to 16.8% of a core: the GPU was doing almost nothing,
// all the time went into three.js per-object CPU work. The cost is therefore
// proportional to the NUMBER OF OBJECTS, not to pixels (the canvas is
// 374×377) nor to triangles.
//
// Hence this module: the 496 nodes become ONE `InstancedMesh`, the 2,415 links
// ONE `LineSegments`. Two objects, two draw calls, whatever the vault size.
// The force simulation stays `d3-force-3d`, the same one `3d-force-graph` used
// under the hood — the layout does not change.
//
// This module deliberately has no React: it is an imperative handle that the
// component drives. It imports `three`, so it must never be evaluated on the
// server — callers get it through `await import()`.
// ---------------------------------------------------------------------------
import {
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DynamicDrawUsage,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  MeshLambertMaterial,
  PerspectiveCamera,
  Raycaster,
  Scene,
  SphereGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import {
  forceCenter,
  forceLink,
  forceManyBody,
  forceRadial,
  forceSimulation,
} from 'd3-force-3d';

export interface SceneNode {
  id: string;
  title: string;
  folder: string;
  degree: number;
  // Written by the simulation.
  x?: number;
  y?: number;
  z?: number;
  fx?: number | null;
  fy?: number | null;
  fz?: number | null;
}

export interface SceneLink {
  source: string | SceneNode;
  target: string | SceneNode;
}

export interface SceneOptions {
  container: HTMLElement;
  width: number;
  height: number;
  nodes: SceneNode[];
  links: SceneLink[];
  /** CSS colour of a node, resolved once at construction. */
  nodeColor: (node: SceneNode) => string;
  /** Apparent radius of a node. */
  nodeRadius: (node: SceneNode) => number;
  linkColor: string;
  linkOpacity: number;
  /** Cruising frame rate at the wide framing. The scene raises it itself when
   *  zooming in — see `targetFrameRate`. */
  baseFrameRate: number;
  onClick: (node: SceneNode) => void;
  /** Any user gesture — used to pause the automatic rotation. */
  onInteract: () => void;
}

// Lighting copied as is from `3d-force-graph` so nodes look exactly as they did
// before the switch (ambient strongly dominant).
const AMBIENT_LIGHT = 0xcccccc;
const DIRECTIONAL_LIGHT = 0xffffff;

// `nodeResolution` was 6: a coarse sphere, invisible at the size nodes are
// drawn. With instancing the geometry is shared by the 496 instances — so we
// can afford to be a little finer without costing anything in draw calls.
const SEGMENTS_SPHERE = 8;

/** Step budget of the force engine.
 *
 *  240 + 60, taken from the old library, were NOT enough: measured, the cloud
 *  topped out at a radius of ~79 — d3's initial spiral — instead of the 180
 *  aimed at by the radial force. With `velocityDecay` at 0.75 nodes are heavily
 *  damped and need many more iterations to spread out.
 *
 *  Warm-up is pure computation, run in one go before the first frame: 300
 *  steps on 496 nodes cost a few tens of milliseconds and nothing on screen.
 *  The rest plays out during the first frames. */
const COOLING_STEPS = 600;
const WARMUP_STEPS = 300;
const ALPHA_DECAY = 0.015;
const VELOCITY_DECAY = 0.75;

const SPHERE_RADIUS = 180;
const SPHERE_FORCE = 0.12;

/** Rotation: degrees per second, independent of the render rate. */
export const ROTATION_SPEED_DEG_S = 1.2;

/** How long rendering stays at full vsync after the last gesture. Long enough
 *  to cover the gaps between two mouse events and the controls settling,
 *  short enough not to prolong the cost. */
const GESTURE_TAIL_MS = 400;

/** Ceiling of the zoom-adaptive frame rate — see `targetFrameRate`. */
const MAX_FRAME_RATE = 60;

/** Hover delay before a node's label shows.
 *
 *  Without it, sweeping across the graph flashes a label for every node
 *  crossed. Half a second separates "passing over" from "looking at this one",
 *  and the count restarts from zero whenever the hovered node changes. */
const LABEL_DELAY_MS = 500;

export class VaultGraphScene {
  private readonly opts: SceneOptions;
  private readonly renderer: WebGLRenderer;
  private readonly scene: Scene;
  private readonly camera: PerspectiveCamera;
  private readonly controls: TrackballControls;
  private readonly nodeMesh: InstancedMesh;
  private readonly linkLines: LineSegments;
  private readonly linkPositions: Float32Array;
  private readonly linkGeometry: BufferGeometry;
  private readonly simulation: ReturnType<typeof forceSimulation<SceneNode>>;
  private readonly matrix = new Matrix4();
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private readonly radii: number[];
  /** Label following the cursor. Driven through the DOM directly rather than
   *  React state: the position changes on every `pointermove`, and state would
   *  trigger one React render per mouse move. */
  private readonly label: HTMLDivElement;

  private elapsedSteps = 0;
  private simulationActive = true;
  /** Positions only moved if the simulation ran or a node is being dragged.
   *  Otherwise a frame rewrites NO buffer: that is what makes a high frame
   *  rate truly free. */
  private positionsDirty = true;
  private rotationActive = true;
  private lastRenderAt = 0;

  private hovered: SceneNode | null = null;
  private dragged: SceneNode | null = null;
  private dragDepth = 0;
  private destroyed = false;
  /** Press position, to tell a click from a drag on release. */
  private pressedAt: { x: number; y: number } | null = null;
  private hasMoved = false;
  /** True from the first camera gesture on: stops the automatic reframing. */
  private cameraTaken = false;
  /** Timestamp of the last user gesture (orbit, wheel, drag).
   *
   *  During a gesture the cruising rate is not tenable: `TrackballControls`
   *  accumulates mouse input but only applies it to the camera on its
   *  `update()`, called once per frame. At RENDER_FPS, orbiting the graph with
   *  the mouse gave a rotation that advanced only twelve times per second —
   *  it felt like "2 fps". A gesture must render at full vsync. */
  private lastGestureMs = 0;
  /** Camera distance kept from the last automatic framing: the reference for
   *  the zoom factor of the adaptive frame rate. */
  private framingDistance = 0;
  /** Timer of the hover delay, for the node it is waiting to announce. */
  private labelTimer: ReturnType<typeof setTimeout> | null = null;
  /** Visible ids, or `null` when no filter is active. */
  private filter: Set<string> | null = null;

  constructor(opts: SceneOptions) {
    this.opts = opts;

    this.renderer = new WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(opts.width, opts.height, false);
    this.renderer.setClearColor(0x000000, 0);
    opts.container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';

    // Recreates the label `3d-force-graph` showed near the cursor. Its native
    // version wrote in light lavender, unreadable on the graph's light
    // background: hence these inline styles, copied as is from the old
    // `nodeLabel`.
    this.label = document.createElement('div');
    Object.assign(this.label.style, {
      position: 'absolute', zIndex: '20', pointerEvents: 'none', display: 'none',
      padding: '3px 8px', borderRadius: '6px',
      background: 'rgba(28,26,24,0.88)', color: '#fdf6f0',
      border: '1px solid rgba(255,255,255,0.12)',
      fontFamily: 'var(--font-sans), system-ui, sans-serif', fontSize: '11px',
      whiteSpace: 'nowrap', textShadow: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    opts.container.appendChild(this.label);

    this.scene = new Scene();
    this.scene.add(new AmbientLight(AMBIENT_LIGHT, Math.PI));
    this.scene.add(new DirectionalLight(DIRECTIONAL_LIGHT, 0.6 * Math.PI));

    this.camera = new PerspectiveCamera(50, opts.width / opts.height, 0.1, 20000);
    this.camera.position.set(0, 0, 600);

    this.controls = new TrackballControls(this.camera, this.renderer.domElement);
    this.controls.minDistance = 10;
    this.controls.maxDistance = 5000;
    this.controls.rotateSpeed = 1.2;
    this.controls.zoomSpeed = 1.2;
    // Without damping the camera stops dead on release; with it, it keeps
    // drifting — and would therefore need continuous rendering. Disabled on
    // purpose: that is the price of a scene that only draws on demand.
    this.controls.staticMoving = true;

    // ---- nodes: a single InstancedMesh ------------------------------------
    const nodeGeometry = new SphereGeometry(1, SEGMENTS_SPHERE, SEGMENTS_SPHERE);
    const nodeMaterial = new MeshLambertMaterial();
    this.nodeMesh = new InstancedMesh(nodeGeometry, nodeMaterial, opts.nodes.length);
    this.nodeMesh.instanceMatrix.setUsage(DynamicDrawUsage);
    // An InstancedMesh's bounding sphere is computed from the GEOMETRY (here a
    // radius of 1), not from the instances spread over ~400 units. Leaving
    // culling on would make the whole graph vanish as soon as the camera moves
    // away from the origin — and that reads as a controls bug.
    this.nodeMesh.frustumCulled = false;

    const color = new Color();
    this.radii = opts.nodes.map((n) => opts.nodeRadius(n));
    opts.nodes.forEach((n, i) => {
      color.set(opts.nodeColor(n));
      this.nodeMesh.setColorAt(i, color);
    });
    if (this.nodeMesh.instanceColor) this.nodeMesh.instanceColor.needsUpdate = true;
    this.scene.add(this.nodeMesh);

    // ---- links: a single LineSegments --------------------------------------
    // Two vertices per link, written flat. `LineBasicMaterial.linewidth` is
    // ignored by WebGL on every platform: links become one-pixel filaments
    // instead of the former 0.35 tubes. That is the only visual difference of
    // the switch, and it is deliberate — the tube cost one three.js object per
    // link, 83% of the scene's budget.
    this.linkPositions = new Float32Array(opts.links.length * 2 * 3);
    this.linkGeometry = new BufferGeometry();
    const attribute = new BufferAttribute(this.linkPositions, 3);
    attribute.setUsage(DynamicDrawUsage);
    this.linkGeometry.setAttribute('position', attribute);
    this.linkLines = new LineSegments(
      this.linkGeometry,
      new LineBasicMaterial({
        color: new Color(opts.linkColor),
        transparent: true,
        opacity: opts.linkOpacity,
        depthWrite: false,
      }),
    );
    this.linkLines.frustumCulled = false;
    this.scene.add(this.linkLines);

    // ---- simulation --------------------------------------------------------
    // CRITICAL ORDER. `forceSimulation` itself places the nodes on an initial
    // spiral (radius 10·∛n, ~79 for 496 nodes) AS SOON AS IT IS CONSTRUCTED.
    // The "is this layout already computed?" test must therefore run BEFORE
    // it: placed after, it is always true, warm-up is skipped and the graph
    // stays frozen on that spiral, never relaxed — 496 nodes packed into a
    // ball three times too small.
    const alreadyComputed = opts.nodes.length > 0 && opts.nodes[0]!.x !== undefined;

    // Same forces `3d-force-graph` installed by default, plus the radial force
    // that rounds the vault into a ball. The `3` is not decorative:
    // `forceSimulation` works in 2D by default.
    this.simulation = forceSimulation<SceneNode>(opts.nodes, 3)
      .force('link', forceLink<SceneNode>(opts.links).id((n) => n.id))
      .force('charge', forceManyBody())
      .force('center', forceCenter())
      .force('radial', forceRadial(SPHERE_RADIUS).strength(SPHERE_FORCE))
      .alphaDecay(ALPHA_DECAY)
      .velocityDecay(VELOCITY_DECAY)
      .stop();

    // An already relaxed layout is reused as is: switching to full screen must
    // not replay the settling. `forceLink` does not mind, it only resolves
    // `source`/`target` when they are not already node objects.
    if (alreadyComputed) {
      this.simulationActive = false;
      this.elapsedSteps = COOLING_STEPS;
    } else {
      // Warm-up runs in one go, before the first frame: without it the initial
      // cloud would be seen unfolding.
      this.simulation.tick(WARMUP_STEPS);
      this.elapsedSteps = WARMUP_STEPS;
    }

    this.attachEvents();
    this.updatePositions();
    this.frameCloud();
  }

  // -------------------------------------------------------------------------
  // Render loop — called by the component, never self-scheduled here.
  // -------------------------------------------------------------------------
  render(): void {
    if (this.destroyed) return;

    const now = performance.now();
    const dt = this.lastRenderAt ? (now - this.lastRenderAt) / 1000 : 0;
    this.lastRenderAt = now;

    if (this.simulationActive) {
      this.simulation.tick();
      this.elapsedSteps++;
      this.positionsDirty = true;
      if (this.elapsedSteps >= COOLING_STEPS) this.simulationActive = false;
      // The cloud keeps spreading throughout cooling: framing it only once at
      // construction let it overflow the panel. So we follow its spread —
      // unless the user has already taken the camera, in which case snatching
      // their framing away would be worse than anything.
      if (!this.cameraTaken) this.frameCloud();
    }

    if (this.positionsDirty) {
      this.updatePositions();
      this.positionsDirty = false;
    }

    if (this.rotationActive && dt > 0) {
      // Speed is in degrees per SECOND, derived from elapsed time: it does not
      // depend on the render rate. Changing that rate changes smoothness, never
      // the apparent speed.
      const p = this.camera.position;
      const d = Math.sqrt(p.x * p.x + p.z * p.z);
      const a = Math.atan2(p.x, p.z) + (ROTATION_SPEED_DEG_S * Math.PI) / 180 * dt;
      p.x = d * Math.sin(a);
      p.z = d * Math.cos(a);
      this.camera.lookAt(0, 0, 0);
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  /** Copies the simulation positions into the two GPU buffers. It is the only
   *  place that writes to video memory, and it is only called when something
   *  actually moved. */
  private updatePositions(): void {
    const nodes = this.opts.nodes;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!;
      const r = this.visible(n) ? this.radii[i]! : 0;
      this.matrix.makeScale(r, r, r);
      this.matrix.setPosition(n.x ?? 0, n.y ?? 0, n.z ?? 0);
      this.nodeMesh.setMatrixAt(i, this.matrix);
    }
    this.nodeMesh.instanceMatrix.needsUpdate = true;

    const links = this.opts.links;
    const pos = this.linkPositions;
    for (let i = 0; i < links.length; i++) {
      const l = links[i]!;
      // `forceLink` replaces ids with node objects during its initialisation;
      // before that pass, source/target are still strings and there is nothing
      // to draw.
      const s = l.source as SceneNode;
      const t = l.target as SceneNode;
      const o = i * 6;
      // A link is drawn only if BOTH ends are visible: otherwise it is reduced
      // to a point, which draws nothing.
      const drawn = s && t && this.visible(s) && this.visible(t);
      pos[o] = s?.x ?? 0;
      pos[o + 1] = s?.y ?? 0;
      pos[o + 2] = s?.z ?? 0;
      pos[o + 3] = drawn ? (t?.x ?? 0) : (s?.x ?? 0);
      pos[o + 4] = drawn ? (t?.y ?? 0) : (s?.y ?? 0);
      pos[o + 5] = drawn ? (t?.z ?? 0) : (s?.z ?? 0);
    }
    this.linkGeometry.attributes.position!.needsUpdate = true;
  }

  // -------------------------------------------------------------------------
  // Interaction
  // -------------------------------------------------------------------------
  private attachEvents(): void {
    const el = this.renderer.domElement;
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('pointerleave', this.onPointerLeave);
    el.addEventListener('wheel', this.onInteraction, { passive: true });
  }

  /** The cursor leaves the canvas: release any drag AND clear the hover,
   *  otherwise the label would stay stuck to the panel edge. */
  private onPointerLeave = (ev: PointerEvent): void => {
    this.onPointerUp(ev);
    this.hovered = null;
    this.hideLabel();
  };

  private onInteraction = (): void => {
    this.cameraTaken = true;
    this.lastGestureMs = performance.now();
    this.opts.onInteract();
  };

  /** Returns the node under the pointer, or null. A raycast on an
   *  `InstancedMesh` provides `instanceId`, which is the index in our array. */
  private nodeUnder(ev: PointerEvent): SceneNode | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
    this.pointer.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.nodeMesh, false);
    const first = hits[0];
    if (!first || first.instanceId == null) return null;
    return this.opts.nodes[first.instanceId] ?? null;
  }

  private onPointerMove = (ev: PointerEvent): void => {
    if (this.pressedAt) {
      const d = Math.hypot(ev.clientX - this.pressedAt.x, ev.clientY - this.pressedAt.y);
      // 4 px of tolerance: even a clean click always moves a little.
      if (d > 4) this.hasMoved = true;
      // Button held = gesture in progress: keep the full frame rate.
      this.lastGestureMs = performance.now();
    }
    if (this.dragged) {
      this.moveDragged(ev);
      return;
    }
    // During an orbit hovering means nothing, and the raycast would cost 496
    // instance tests on every mouse move, for nothing.
    if (this.pressedAt) return;
    const n = this.nodeUnder(ev);
    if (n !== this.hovered) {
      this.hovered = n;
      this.renderer.domElement.style.cursor = n ? 'pointer' : '';
      // New node = the count restarts. Crossing the graph therefore shows no
      // label until the pointer stops on one of them.
      this.hideLabel();
      if (n) {
        const x = ev.clientX, y = ev.clientY;
        this.labelTimer = setTimeout(() => {
          this.labelTimer = null;
          if (this.hovered !== n || this.destroyed) return;
          this.label.textContent = n.title;
          this.label.style.display = 'block';
          this.placeLabelAt(x, y);
        }, LABEL_DELAY_MS);
      }
    }
    // Once shown, the label follows the cursor without rearming the delay.
    if (this.label.style.display === 'block') this.placeLabel(ev);
  };

  private hideLabel(): void {
    if (this.labelTimer) {
      clearTimeout(this.labelTimer);
      this.labelTimer = null;
    }
    this.label.style.display = 'none';
  }

  /** Sticks the label to the cursor, flipping it to the left or above when it
   *  would overflow the panel — otherwise it would be cut near the edges. */
  private placeLabel(ev: PointerEvent): void {
    this.placeLabelAt(ev.clientX, ev.clientY);
  }

  private placeLabelAt(clientX: number, clientY: number): void {
    const r = this.renderer.domElement.getBoundingClientRect();
    let x = clientX - r.left + 12;
    let y = clientY - r.top + 12;
    const l = this.label.offsetWidth;
    const h = this.label.offsetHeight;
    if (x + l > r.width) x = Math.max(0, clientX - r.left - l - 12);
    if (y + h > r.height) y = Math.max(0, clientY - r.top - h - 12);
    this.label.style.left = `${x}px`;
    this.label.style.top = `${y}px`;
  }

  private onPointerDown = (ev: PointerEvent): void => {
    this.onInteraction();
    this.pressedAt = { x: ev.clientX, y: ev.clientY };
    this.hasMoved = false;
    const n = this.nodeUnder(ev);
    if (!n) return;
    // A press on a node starts a drag; the controls are disabled so the camera
    // does not move along with the node.
    this.dragged = n;
    this.controls.enabled = false;
    this.dragDepth = new Vector3(n.x ?? 0, n.y ?? 0, n.z ?? 0)
      .project(this.camera).z;
    this.renderer.domElement.setPointerCapture(ev.pointerId);
  };

  private moveDragged(ev: PointerEvent): void {
    const n = this.dragged;
    if (!n) return;
    const r = this.renderer.domElement.getBoundingClientRect();
    // Unproject the pointer at the screen depth the node had when pressed: the
    // node follows the mouse in the plane that faced it, without jumping
    // towards or away from the camera.
    const p = new Vector3(
      ((ev.clientX - r.left) / r.width) * 2 - 1,
      -((ev.clientY - r.top) / r.height) * 2 + 1,
      this.dragDepth,
    ).unproject(this.camera);
    n.fx = p.x;
    n.fy = p.y;
    n.fz = p.z;
    // A moved node must pull its neighbours: reheat the simulation.
    this.simulation.alpha(0.3);
    this.simulationActive = true;
    this.elapsedSteps = 0;
    this.positionsDirty = true;
  }

  private onPointerUp = (ev: PointerEvent): void => {
    // Release without drag on a node = click: open the note. Handled here
    // rather than with a separate `click` listener, which would also fire at
    // the end of a drag and open the note that was just moved.
    if (this.pressedAt && !this.hasMoved) {
      const n = this.nodeUnder(ev);
      if (n) {
        // The modal covers the canvas: without this the label would stay frozen
        // behind it, since `pointerleave` never happens.
        this.hideLabel();
        this.opts.onClick(n);
      }
    }
    if (this.pressedAt) {
      // The full-rate tail runs from the RELEASE, not from the last move: the
      // controls still have a few frames to play.
      this.lastGestureMs = performance.now();
    }
    this.pressedAt = null;

    if (!this.dragged) return;
    const n = this.dragged;
    // Release the constraint: the node returns to its place under the forces
    // instead of staying pinned where it was dropped.
    n.fx = null;
    n.fy = null;
    n.fz = null;
    this.dragged = null;
    this.controls.enabled = true;
    try {
      this.renderer.domElement.releasePointerCapture(ev.pointerId);
    } catch {
      // the pointer may already have been released (pointerleave)
    }
  };

  // -------------------------------------------------------------------------
  // Driven from the component
  // -------------------------------------------------------------------------
  resize(width: number, height: number): void {
    if (this.destroyed || width <= 0 || height <= 0) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.controls.handleResize();
    // Framing depends on the aspect ratio: the HUD panel is resizable, and a
    // cloud framed to the pixel would overflow otherwise.
    if (!this.cameraTaken) this.frameCloud();
  }

  setRotation(active: boolean): void {
    this.rotationActive = active;
  }

  /** Reframes the camera on the actual extent of the cloud.
   *
   *  The HUD panel is almost square and can become taller than wide: so the
   *  tighter of the two half field-of-view angles is used. Settling for the
   *  vertical field let the cloud overflow sideways. */
  frameCloud(margin = 1.3): void {
    let max = 0;
    for (const n of this.opts.nodes) {
      const d = Math.sqrt((n.x ?? 0) ** 2 + (n.y ?? 0) ** 2 + (n.z ?? 0) ** 2);
      if (d > max) max = d;
    }
    if (max <= 0) return;
    const halfVertical = (this.camera.fov * Math.PI) / 360;
    const halfHorizontal = Math.atan(Math.tan(halfVertical) * this.camera.aspect);
    const half = Math.min(halfVertical, halfHorizontal);
    const distance = (max * margin) / Math.sin(half);
    const p = this.camera.position;
    const current = p.length() || 1;
    p.multiplyScalar(distance / current);
    this.camera.lookAt(0, 0, 0);
    this.framingDistance = distance;
  }

  /** True when the scene must render at full vsync rather than RENDER_FPS:
   *  layout settling, a node being dragged, or a camera gesture in progress.
   *
   *  The tail after the last gesture covers two things: mouse events do not
   *  arrive at regular intervals (dropping the rate between two `pointermove`
   *  would make the orbit stutter), and `TrackballControls` needs a few frames
   *  after release to settle. */
  get isMoving(): boolean {
    return this.simulationActive
      || this.dragged !== null
      || performance.now() - this.lastGestureMs < GESTURE_TAIL_MS;
  }

  /** Cruising frame rate to aim for, in frames per second.
   *
   *  It must GO UP when zooming in. Rotation advances by a fixed angular step,
   *  but the displacement that step produces ON SCREEN is inversely
   *  proportional to the camera distance: at the wide framing 12 frames/s are
   *  enough and motion is smooth; zoomed four times, the same step covers four
   *  times more pixels per frame and the rotation stutters. Checked by
   *  measurement: the rate did stay at 12 fps and 2 draw calls per frame while
   *  zooming — the defect is perceptual, not a lack of performance, so it is
   *  fixed by the frame rate, not by rendering.
   *
   *  The cost grows linearly (~0.7% of a core per frame/second), but it is
   *  only paid when zoomed in, that is when someone really looks at the graph. */
  get targetFrameRate(): number {
    const base = this.opts.baseFrameRate;
    if (!this.framingDistance) return base;
    const distance = this.camera.position.length() || this.framingDistance;
    const zoom = this.framingDistance / distance;
    return Math.min(MAX_FRAME_RATE, Math.max(base, base * zoom));
  }

  /** Restricts the display to the given ids — `null` lifts the filter.
   *
   *  NEITHER the simulation NOR the scene structure is touched: hidden nodes
   *  go to scale 0 and their links become zero-length segments, hence
   *  invisible. The layout does not move (nothing is more disorienting than a
   *  graph that rearranges at every typed letter), and the draw call count
   *  stays at two. A node at scale 0 has a zero radius: the raycast no longer
   *  reaches it, so it also becomes unhoverable and unclickable, for free. */
  setFilter(ids: Set<string> | null): void {
    this.filter = ids;
    this.positionsDirty = true;
    this.hideLabel();
  }

  private visible(n: SceneNode): boolean {
    return this.filter === null || this.filter.has(n.id);
  }

  /** Recolours the scene without rebuilding anything.
   *
   *  The theme changes colours, never geometry: rebuilding the scene would
   *  replay the layout for a mere light/dark switch. So the instances' colour
   *  attribute and the links' material are rewritten instead. */
  setTheme(theme: {
    nodeColor: (node: SceneNode) => string;
    linkColor: string;
    linkOpacity: number;
  }): void {
    const color = new Color();
    this.opts.nodes.forEach((n, i) => {
      color.set(theme.nodeColor(n));
      this.nodeMesh.setColorAt(i, color);
    });
    if (this.nodeMesh.instanceColor) this.nodeMesh.instanceColor.needsUpdate = true;

    const mat = this.linkLines.material as LineBasicMaterial;
    mat.color.set(theme.linkColor);
    mat.opacity = theme.linkOpacity;
    mat.needsUpdate = true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    const el = this.renderer.domElement;
    el.removeEventListener('pointermove', this.onPointerMove);
    el.removeEventListener('pointerdown', this.onPointerDown);
    el.removeEventListener('pointerup', this.onPointerUp);
    el.removeEventListener('pointerleave', this.onPointerLeave);
    el.removeEventListener('wheel', this.onInteraction);

    if (this.labelTimer) clearTimeout(this.labelTimer);
    this.simulation.stop();
    this.controls.dispose();

    this.nodeMesh.geometry.dispose();
    (this.nodeMesh.material as MeshLambertMaterial).dispose();
    this.linkGeometry.dispose();
    (this.linkLines.material as LineBasicMaterial).dispose();

    // The container is unmounted/remounted on every state change of the
    // component. Without an explicit release each pass would leave a WebGL
    // context alive — and a browser caps their number per page (~16), after
    // which the oldest is killed and the canvas goes black.
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    el.remove();
    this.label.remove();
  }
}
