// Main 3D viewport: rendering, camera navigation, picking and highlighting.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { Grid } from './grid.js';
import { ViewCube } from './viewcube.js';
import { STD_PLANES, cross } from '../model/geom.js';
import { outline, isOpenOutline } from '../model/profiles.js';
import { icon } from '../ui/icons.js';

export const BODY_COLORS = ['#a9b3c1', '#c8a27c', '#8fb5a6', '#b39bcb', '#d49d9b', '#9cb8da', '#cdbf86', '#8ea0b8'];
const ACCENT = new THREE.Color('#4f8cff');
const HOVER = new THREE.Color('#7fb0ff');

const VIEWS = {
  front: [0, -1, 0], back: [0, 1, 0], right: [1, 0, 0], left: [-1, 0, 0],
  top: [0, -1e-4, 1], bottom: [0, -1e-4, -1], home: [1, -1.25, 0.95],
};

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class Viewport {
  constructor(container, cubeContainer) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.localClippingEnabled = true;
    container.append(this.renderer.domElement);

    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.85;

    this.persp = new THREE.PerspectiveCamera(35, 1, 0.1, 100000);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -100000, 100000);
    for (const c of [this.persp, this.ortho]) c.up.set(0, 0, 1);
    this.camera = this.persp;
    this.camera.position.set(180, -220, 160);
    this.keyLight = new THREE.DirectionalLight(0xffffff, 1.1);
    this.keyLight.position.set(0.4, 0.6, 1);
    this.persp.add(this.keyLight.clone());
    this.ortho.add(this.keyLight.clone());
    this.scene.add(this.persp, this.ortho);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8890a0, 0.35));

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.zoomToCursor = true;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.18;
    this.controls.rotateSpeed = 0.9;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('change', () => { this.dirty = true; this.onCameraChange?.(); });

    this.grid = new Grid();
    this.grid.setFrame({ origin: [0, 0, 0], xDir: [1, 0, 0], yDir: [0, 1, 0], normal: [0, 0, 1] });
    this.scene.add(this.grid.mesh);

    this.bodyGroup = new THREE.Group();
    this.sketchGroup = new THREE.Group();
    this.previewGroup = new THREE.Group();
    this.highlightGroup = new THREE.Group();
    this.planeGroup = new THREE.Group();
    this.measureGroup = new THREE.Group();
    this.dimGroup = new THREE.Group();
    this.markerGroup = new THREE.Group();
    this.scene.add(this.bodyGroup, this.sketchGroup, this.previewGroup, this.highlightGroup, this.planeGroup, this.measureGroup, this.dimGroup, this.markerGroup);
    this.dims = { frame: null, list: [], onEdit: null, labels: [], ps: 0, key: '' };
    this.dimEditing = null;
    this._buildOriginPlanes();

    this.bodies = new Map();
    this.sketchPickables = [];
    this.displayMode = 'shadedEdges';
    this.pickFilter = 'idle';
    this.hover = null;
    this.highlight = { bodies: new Set(), faces: [], edges: [], hoverBody: null };
    this.labels = [];
    this.section = null;
    this.raycaster = new THREE.Raycaster();
    this.lineMaterials = [];
    this.dirty = true;
    this.anim = null;

    this.cube = new ViewCube(cubeContainer, { onSelect: (v) => this.setView(v) });
    this._bindPointer();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.setView('home', false);
    const loop = () => { requestAnimationFrame(loop); this._frame(); };
    loop();
  }

  // ------------------------------------------------------------ theme / sizing
  setTheme(dark) {
    this.dark = dark;
    this.grid.setTheme(dark);
    this.cube.setTheme(dark);
    this.edgeColor = new THREE.Color(dark ? '#101216' : '#2a2f38');
    for (const b of this.bodies.values()) b.edges.material.color.copy(this.edgeColor);
    this.dirty = true;
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    this._updateOrthoFrustum();
    for (const m of this.lineMaterials) m.resolution.set(w, h);
    this.dirty = true;
  }

  _updateOrthoFrustum() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    const dist = this.camera.position.distanceTo(this.controls.target);
    const height = this.orthoHeight || 2 * dist * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2));
    this.ortho.left = (-height * (w / h)) / 2; this.ortho.right = (height * (w / h)) / 2;
    this.ortho.top = height / 2; this.ortho.bottom = -height / 2;
    this.ortho.updateProjectionMatrix();
  }

  /** Visible height (world units) at the orbit target. */
  viewHeight() {
    if (this.camera.isOrthographicCamera) return (this.ortho.top - this.ortho.bottom) / this.ortho.zoom;
    const dist = this.camera.position.distanceTo(this.controls.target);
    return 2 * dist * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2));
  }

  pixelSize() { return this.viewHeight() / (this.container.clientHeight || 1); }

  // ------------------------------------------------------------ camera
  setProjection(ortho) {
    if (!!ortho === this.camera.isOrthographicCamera) return;
    const from = this.camera, to = ortho ? this.ortho : this.persp;
    const target = this.controls.target.clone();
    if (ortho) {
      this.orthoHeight = this.viewHeight();
      to.zoom = 1;
      to.position.copy(from.position);
    } else {
      const height = this.viewHeight();
      const dist = height / (2 * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2)));
      const dir = new THREE.Vector3().subVectors(from.position, target).normalize();
      to.position.copy(target).addScaledVector(dir, dist);
    }
    to.up.copy(from.up);
    to.lookAt(target);
    this.camera = to;
    this.controls.object = to;
    this._updateOrthoFrustum();
    this.controls.update();
    this.dirty = true;
  }

  get isOrtho() { return this.camera.isOrthographicCamera; }

  sceneBounds() {
    const box = new THREE.Box3();
    for (const b of this.bodies.values()) if (b.mesh.visible) box.expandByObject(b.mesh);
    for (const o of this.sketchGroup.children) if (o.visible) box.expandByObject(o);
    return box;
  }

  setView(name, animate = true, dirOverride) {
    const box = this.sceneBounds();
    const sphere = box.isEmpty() ? new THREE.Sphere(new THREE.Vector3(0, 0, 0), 60) : box.getBoundingSphere(new THREE.Sphere());
    sphere.radius = Math.max(sphere.radius, 5);
    const dir = new THREE.Vector3(...(dirOverride || VIEWS[name] || VIEWS.home)).normalize();
    this._flyTo(sphere.center, dir, sphere.radius, animate);
  }

  fit(animate = true) {
    const dir = new THREE.Vector3().subVectors(this.camera.position, this.controls.target).normalize();
    this.setView(null, animate, dir.toArray());
  }

  lookAtFrame(frame, animate = true) {
    const box = this.sceneBounds();
    let r = 60, center = new THREE.Vector3(...frame.origin);
    if (!box.isEmpty()) {
      const s = box.getBoundingSphere(new THREE.Sphere());
      r = Math.max(s.radius, 20);
      const n = new THREE.Vector3(...frame.normal);
      center = s.center.clone().sub(n.clone().multiplyScalar(n.dot(s.center.clone().sub(new THREE.Vector3(...frame.origin)))));
    }
    let n = new THREE.Vector3(...frame.normal);
    if (Math.abs(n.z) > 0.999) n = new THREE.Vector3(0, -1e-4 * Math.sign(n.z), n.z).normalize();
    this._flyTo(center, n, r, animate);
  }

  _flyTo(center, dir, radius, animate) {
    const fov = THREE.MathUtils.degToRad(this.persp.fov);
    const dist = (radius / Math.sin(fov / 2)) * 1.05;
    const endPos = center.clone().addScaledVector(dir, dist);
    const endHeight = radius * 2.3;
    if (!animate) {
      this.anim = null;
      this.controls.target.copy(center);
      this.camera.position.copy(endPos);
      this.orthoHeight = endHeight; this.ortho.zoom = 1;
      this._updateOrthoFrustum();
      this.camera.lookAt(center);
      this.controls.update();
      this.dirty = true;
      return;
    }
    const startPos = this.camera.position.clone(), startTarget = this.controls.target.clone();
    const startZoom = this.ortho.zoom, startHeight = this.viewHeight();
    // spherical interpolation of the view direction keeps the motion pleasant
    const startDir = startPos.clone().sub(startTarget);
    const startDist = startDir.length();
    startDir.normalize();
    const t0 = performance.now(), dur = 420;
    this.anim = (now) => {
      const t = Math.min(1, (now - t0) / dur), k = ease(t);
      const d = new THREE.Vector3().copy(startDir).lerp(dir, k);
      if (d.lengthSq() < 1e-8) d.copy(dir);
      d.normalize();
      const target = startTarget.clone().lerp(center, k);
      this.controls.target.copy(target);
      this.camera.position.copy(target).addScaledVector(d, THREE.MathUtils.lerp(startDist, dist, k));
      if (this.camera.isOrthographicCamera) {
        this.ortho.zoom = 1;
        this.orthoHeight = THREE.MathUtils.lerp(startHeight, endHeight, k);
        this._updateOrthoFrustum();
      }
      this.camera.lookAt(target);
      this.dirty = true;
      if (t >= 1) { this.anim = null; this.controls.update(); }
      void startZoom;
    };
  }

  // ------------------------------------------------------------ origin planes
  _buildOriginPlanes() {
    const colors = { XY: '#4f8cff', XZ: '#3fb950', YZ: '#e5534b' };
    for (const [name, P] of Object.entries(STD_PLANES)) {
      const g = new THREE.PlaneGeometry(60, 60);
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: colors[name], transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false }));
      const yDir = cross(P.normal, P.xDir);
      m.matrix.makeBasis(new THREE.Vector3(...P.xDir), new THREE.Vector3(...yDir), new THREE.Vector3(...P.normal));
      m.matrixAutoUpdate = false;
      const border = new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color: colors[name], transparent: true, opacity: 0.6 }));
      m.add(border);
      m.userData = { plane: name, color: colors[name] };
      m.renderOrder = 2;
      this.planeGroup.add(m);
    }
    this.planeGroup.visible = false;
  }

  showOriginPlanes(show) { this.planeGroup.visible = show; this.dirty = true; }

  // ------------------------------------------------------------ bodies
  setBodies(list) {
    const seen = new Set();
    for (const b of list) {
      seen.add(b.id);
      let entry = this.bodies.get(b.id);
      if (entry && (entry.data === b.data || (b.data.key && entry.data.key === b.data.key))) { this._styleBody(entry, b); continue; }
      if (entry) this._disposeBody(entry);
      entry = this._makeBody(b);
      this.bodies.set(b.id, entry);
      this._styleBody(entry, b);
    }
    for (const [id, e] of this.bodies) if (!seen.has(id)) { this._disposeBody(e); this.bodies.delete(id); }
    this._refreshHighlights();
    this.dirty = true;
  }

  _makeBody({ id, data }) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(data.vertices, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    g.setIndex(new THREE.BufferAttribute(data.triangles, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    const mat = new THREE.MeshStandardMaterial({ color: '#a9b3c1', metalness: 0.15, roughness: 0.48, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.FrontSide });
    const mesh = new THREE.Mesh(g, mat);
    mesh.userData = { bodyId: id };
    const capMat = new THREE.MeshBasicMaterial({ color: '#ff7a1a', side: THREE.BackSide });
    const cap = new THREE.Mesh(g, capMat);
    cap.visible = false;
    cap.userData.noPick = true;
    mesh.add(cap);
    // edges as segment pairs
    const segs = [];
    const P = data.edgePts;
    for (const e of data.edgeInfo) {
      for (let i = 0; i < e.count - 1; i++) {
        const a = (e.start + i) * 3, b = (e.start + i + 1) * 3;
        segs.push(P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2]);
      }
    }
    const eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3));
    const edges = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: this.edgeColor || '#101216' }));
    edges.userData.noPick = true;
    this.bodyGroup.add(mesh, edges);
    // group start lookup for triangle -> face
    const groupStarts = data.groups.map((g2) => g2[0]);
    return { id, data, mesh, edges, cap, groupStarts, faceCache: new Map(), matrix: new THREE.Matrix4(), identity: true };
  }

  _styleBody(entry, b) {
    if (b.matrix) {
      // component placement (assemblies): instances share mesh data but have their own pose
      entry.matrix.fromArray(b.matrix);
      entry.identity = entry.matrix.equals(new THREE.Matrix4());
      for (const o of [entry.mesh, entry.edges]) { o.matrixAutoUpdate = false; o.matrix.copy(entry.matrix); o.updateMatrixWorld(true); }
    }
    entry.mesh.material.color.set(b.color);
    entry.visible = b.visible !== false;
    entry.mesh.visible = entry.visible;
    entry.edges.visible = entry.visible && this.displayMode !== 'shaded';
    entry.mesh.material.transparent = this.displayMode === 'wire' || !!b.ghost;
    entry.mesh.material.opacity = this.displayMode === 'wire' ? 0.07 : b.ghost ? 0.35 : 1;
    entry.mesh.material.depthWrite = !entry.mesh.material.transparent;
    entry.mesh.material.needsUpdate = true;
    entry.cap.visible = !!this.section;
    entry.ghost = !!b.ghost;
  }

  _disposeBody(e) {
    this.bodyGroup.remove(e.mesh, e.edges);
    e.mesh.geometry.dispose(); e.mesh.material.dispose(); e.cap.material.dispose();
    e.edges.geometry.dispose(); e.edges.material.dispose();
  }

  setDisplayMode(mode) {
    this.displayMode = mode;
    for (const e of this.bodies.values()) this._styleBody(e, { color: '#' + e.mesh.material.color.getHexString(), visible: e.visible, ghost: e.ghost });
    this.dirty = true;
  }

  setSection(section) {
    this.section = section;
    if (section) {
      const n = { X: [-1, 0, 0], Y: [0, -1, 0], Z: [0, 0, -1] }[section.axis];
      this.renderer.clippingPlanes = [new THREE.Plane(new THREE.Vector3(...n), section.offset)];
    } else this.renderer.clippingPlanes = [];
    for (const e of this.bodies.values()) e.cap.visible = !!section;
    this.dirty = true;
  }

  faceIndexOf(entry, triIndex) {
    const s = entry.groupStarts;
    const t = triIndex * 3;
    let lo = 0, hi = s.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (s[mid] <= t) lo = mid; else hi = mid - 1; }
    return lo;
  }

  /** Planarity, normal, centroid and size of a face (from its triangles). */
  faceInfo(entry, fi) {
    if (entry.faceCache.has(fi)) return entry.faceCache.get(fi);
    const { vertices: V, normals: N, triangles: T, groups } = entry.data;
    const [start, count] = groups[fi];
    let planar = true;
    const n0 = [N[T[start] * 3], N[T[start] * 3 + 1], N[T[start] * 3 + 2]];
    let cx = 0, cy = 0, cz = 0, area = 0;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = start; i < start + count; i += 3) {
      const a = T[i] * 3, b = T[i + 1] * 3, c = T[i + 2] * 3;
      for (const k of [a, b, c]) {
        if (Math.abs(N[k] * n0[0] + N[k + 1] * n0[1] + N[k + 2] * n0[2]) < 0.9995) planar = false;
        for (let j = 0; j < 3; j++) { lo[j] = Math.min(lo[j], V[k + j]); hi[j] = Math.max(hi[j], V[k + j]); }
      }
      const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
      const vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
      const ar = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
      cx += ((V[a] + V[b] + V[c]) / 3) * ar; cy += ((V[a + 1] + V[b + 1] + V[c + 1]) / 3) * ar; cz += ((V[a + 2] + V[b + 2] + V[c + 2]) / 3) * ar;
      area += ar;
    }
    const info = {
      planar, normal: n0, area,
      center: area > 0 ? [cx / area, cy / area, cz / area] : [V[T[start] * 3], V[T[start] * 3 + 1], V[T[start] * 3 + 2]],
      size: Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]),
      point: [V[T[start] * 3], V[T[start] * 3 + 1], V[T[start] * 3 + 2]],
    };
    entry.faceCache.set(fi, info);
    return info;
  }

  findFace(bodyId, ref) {
    const entry = this.bodies.get(bodyId);
    if (!entry) return -1;
    let best = -1, bd = Infinity;
    entry.data.groups.forEach((_, fi) => {
      const f = this.faceInfo(entry, fi);
      if (ref.planar && (!f.planar || f.normal[0] * ref.n[0] + f.normal[1] * ref.n[1] + f.normal[2] * ref.n[2] < 0.98)) return;
      const d = Math.hypot(f.center[0] - ref.p[0], f.center[1] - ref.p[1], f.center[2] - ref.p[2]);
      if (d < bd) { bd = d; best = fi; }
    });
    return bd < Math.max(1, (ref.size || 0) * 0.5) ? best : -1;
  }

  findEdge(bodyId, ref) {
    const entry = this.bodies.get(bodyId);
    if (!entry) return -1;
    let best = -1, bd = Infinity;
    entry.data.edgeInfo.forEach((e, i) => {
      if (e.type !== ref.type) return;
      const d = Math.hypot(e.mid[0] - ref.p[0], e.mid[1] - ref.p[1], e.mid[2] - ref.p[2]);
      if (d < bd) { bd = d; best = i; }
    });
    return bd < 1e-3 + 0.02 * (ref.len || 1) ? best : -1;
  }

  // ------------------------------------------------------------ highlights
  setHighlights(h) {
    this.highlight = { bodies: new Set(), faces: [], edges: [], ...h };
    this._refreshHighlights();
  }

  _fatLines(positions, color, width) {
    const g = new LineSegmentsGeometry();
    g.setPositions(positions);
    const m = new LineMaterial({ color, linewidth: width, depthTest: false, transparent: true });
    m.resolution.set(this.container.clientWidth, this.container.clientHeight);
    this.lineMaterials.push(m);
    const l = new LineSegments2(g, m);
    l.renderOrder = 10;
    l.userData.noPick = true;
    return l;
  }

  /** Edge polyline as world-space segment pairs (applies the body's placement). */
  _edgeSegments(entry, ei) {
    const e = entry.data.edgeInfo[ei], P = entry.data.edgePts, out = [];
    const v = new THREE.Vector3();
    const push = (k) => { v.set(P[k], P[k + 1], P[k + 2]); if (!entry.identity) v.applyMatrix4(entry.matrix); out.push(v.x, v.y, v.z); };
    for (let i = 0; i < e.count - 1; i++) { push((e.start + i) * 3); push((e.start + i + 1) * 3); }
    return out;
  }

  _faceMesh(entry, fi, color, opacity) {
    const [start, count] = entry.data.groups[fi];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', entry.mesh.geometry.getAttribute('position'));
    g.setIndex(new THREE.BufferAttribute(entry.data.triangles.slice(start, start + count), 1));
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    m.userData.noPick = true;
    m.renderOrder = 5;
    if (!entry.identity) { m.matrixAutoUpdate = false; m.matrix.copy(entry.matrix); }
    return m;
  }

  /** Body-local → world for a point (or a direction when dir = true). */
  toWorldOf(bodyId, p, dir = false) {
    const e = this.bodies.get(bodyId);
    const v = new THREE.Vector3(...p);
    if (e && !e.identity) { if (dir) v.transformDirection(e.matrix); else v.applyMatrix4(e.matrix); }
    return v.toArray();
  }

  /** Center, axis and radius of a circular edge (body-local), from three of its points. */
  circleOf(entry, ei) {
    const e = entry.data.edgeInfo[ei], P = entry.data.edgePts;
    if (e.type !== 'CIRCLE' || e.count < 3) return null;
    const pt = (i) => { const k = (e.start + i) * 3; return new THREE.Vector3(P[k], P[k + 1], P[k + 2]); };
    const a = pt(0), b = pt(Math.floor((e.count - 1) / 3)), c = pt(Math.floor((2 * (e.count - 1)) / 3));
    const ab = b.clone().sub(a), ac = c.clone().sub(a);
    const n = ab.clone().cross(ac);
    const n2 = n.lengthSq();
    if (n2 < 1e-12) return null;
    const center = a.clone().add(n.clone().cross(ab).multiplyScalar(ac.lengthSq()).add(ac.clone().cross(n).multiplyScalar(ab.lengthSq())).divideScalar(2 * n2));
    return { c: center.toArray(), axis: n.normalize().toArray(), r: center.distanceTo(a) };
  }

  /** Joint frame markers: [{ p, z, color }] in world space. */
  setMarkers(list = []) {
    for (const o of this.markerGroup.children) { o.geometry?.dispose(); o.material?.dispose(); }
    this.markerGroup.clear();
    const s = this.pixelSize() * 34;
    for (const m of list) {
      const p = new THREE.Vector3(...m.p), z = new THREE.Vector3(...m.z).normalize();
      const ring = new THREE.Mesh(new THREE.RingGeometry(s * 0.32, s * 0.42, 32), new THREE.MeshBasicMaterial({ color: m.color, side: THREE.DoubleSide, depthTest: false, transparent: true }));
      ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), z);
      ring.position.copy(p);
      const axis = new THREE.Line(new THREE.BufferGeometry().setFromPoints([p, p.clone().addScaledVector(z, s)]), new THREE.LineBasicMaterial({ color: m.color, depthTest: false }));
      const dot = new THREE.Points(new THREE.BufferGeometry().setFromPoints([p]), new THREE.PointsMaterial({ color: m.color, size: 8, sizeAttenuation: false, depthTest: false }));
      for (const o of [ring, axis, dot]) { o.renderOrder = 13; o.userData.noPick = true; this.markerGroup.add(o); }
    }
    this.dirty = true;
  }

  _refreshHighlights() {
    for (const o of this.highlightGroup.children) { o.geometry?.dispose(); o.material?.dispose(); }
    this.highlightGroup.clear();
    this.lineMaterials = [];
    const H = this.highlight;
    for (const [id, e] of this.bodies) {
      const sel = H.bodies.has(id), hov = this.hover && this.hover.kind === 'body' && this.hover.bodyId === id;
      e.mesh.material.emissive.set(sel ? ACCENT : hov ? HOVER : 0x000000);
      e.mesh.material.emissiveIntensity = sel ? 0.35 : hov ? 0.18 : 0;
    }
    const edgePos = [];
    for (const { bodyId, index } of H.edges) {
      const e = this.bodies.get(bodyId);
      if (e && index >= 0) edgePos.push(...this._edgeSegments(e, index));
    }
    if (edgePos.length) this.highlightGroup.add(this._fatLines(edgePos, ACCENT, 3.5));
    for (const { bodyId, index } of H.faces) {
      const e = this.bodies.get(bodyId);
      if (e && index >= 0) this.highlightGroup.add(this._faceMesh(e, index, ACCENT, 0.45));
    }
    const hv = this.hover;
    if (hv && hv.kind === 'edge') {
      const e = this.bodies.get(hv.bodyId);
      if (e) this.highlightGroup.add(this._fatLines(this._edgeSegments(e, hv.index), HOVER, 3));
    }
    if (hv && hv.kind === 'face') {
      const e = this.bodies.get(hv.bodyId);
      if (e) this.highlightGroup.add(this._faceMesh(e, hv.index, HOVER, 0.3));
    }
    for (const p of this.planeGroup.children) {
      const on = hv && hv.kind === 'plane' && hv.plane === p.userData.plane;
      p.material.opacity = on ? 0.32 : 0.1;
    }
    this.dirty = true;
  }

  setHover(hit) {
    const key = (h) => (h ? `${h.kind}:${h.bodyId || ''}:${h.index ?? ''}:${h.plane || ''}:${h.regionId || ''}:${h.sketchId || ''}` : '');
    if (key(hit) === key(this.hover)) return;
    this.hover = hit;
    this._refreshHighlights();
    this.onHoverChange?.(hit);
  }

  // ------------------------------------------------------------ sketches
  /** sketches: [{ id, frame, ents, regions, active, selectedEnts, selectedRegions, hoverRegion, hoverEnt, showProfiles }] */
  setSketches(list) {
    for (const o of this.sketchGroup.children) o.traverse((c) => { c.geometry?.dispose(); c.material?.dispose(); });
    this.sketchGroup.clear();
    this.sketchPickables = [];
    for (const s of list) this.sketchGroup.add(this._buildSketch(s));
    this.dirty = true;
  }

  _frameMatrix(frame, lift = 0) {
    const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...frame.xDir), new THREE.Vector3(...frame.yDir), new THREE.Vector3(...frame.normal));
    m.setPosition(new THREE.Vector3(...frame.origin).addScaledVector(new THREE.Vector3(...frame.normal), lift));
    return m;
  }

  _buildSketch(s) {
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    group.matrix.copy(this._frameMatrix(s.frame, 0.02));
    const dark = this.dark;
    const lineCol = s.active ? (dark ? '#e8ecf3' : '#1b2330') : dark ? '#c9d1de' : '#3b4556';
    const consCol = '#ff9a3c';
    if (s.showProfiles !== false) {
      for (const r of s.regions) {
        const shape = new THREE.Shape(r.outer.map(([x, y]) => new THREE.Vector2(x, y)));
        for (const hole of r.holes) shape.holes.push(new THREE.Path(hole.map(([x, y]) => new THREE.Vector2(x, y))));
        const sel = s.selectedRegions?.has(r.id), hov = s.hoverRegion === r.id;
        const mat = new THREE.MeshBasicMaterial({
          color: sel ? '#4f8cff' : hov ? '#7fb0ff' : (dark ? '#8fa6c8' : '#6d8fc4'),
          transparent: true, opacity: sel ? 0.5 : hov ? 0.35 : 0.13, side: THREE.DoubleSide, depthWrite: false,
          depthTest: !s.active,
        });
        const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape, 24), mat);
        mesh.renderOrder = 3;
        mesh.userData = { sketchId: s.id, regionId: r.id };
        this.sketchPickables.push(mesh);
        group.add(mesh);
      }
    }
    const st = s.active ? s.status : null;
    for (const e of s.ents) {
      if (e.error) continue;
      const pts = outline(e).map(([x, y]) => new THREE.Vector3(x, y, 0));
      if (pts.length < 2) continue;
      const sel = s.selectedEnts?.has(e.id), hov = s.hoverEnt === e.id;
      let color;
      if (sel) color = '#ffb020';
      else if (hov) color = '#ffd27a';
      else if (st && st.conflictEnts.has(e.id)) color = '#ef5350';
      else if (e.construction) color = consCol;
      else if (!st) color = lineCol;
      else if (e.fixed) color = '#3fb950';
      else color = st.determined.has(e.id) ? (dark ? '#f1f4f9' : '#141a24') : (dark ? '#6fa8ff' : '#2463d6');
      const g = new THREE.BufferGeometry().setFromPoints(isOpenOutline(e) ? pts : [...pts, pts[0]]);
      const mat = e.construction
        ? new THREE.LineDashedMaterial({ color, dashSize: this.pixelSize() * 6, gapSize: this.pixelSize() * 4, depthTest: !s.active, transparent: true })
        : new THREE.LineBasicMaterial({ color, depthTest: !s.active, transparent: true });
      const line = new THREE.Line(g, mat);
      if (e.construction) line.computeLineDistances();
      line.renderOrder = 6;
      line.userData.noPick = true;
      group.add(line);
    }
    if (s.active) {
      const pts = [];
      for (const e of s.ents) {
        if (e.error) continue;
        if (e.type === 'line') pts.push(e.x1, e.y1, 0, e.x2, e.y2, 0);
        else if (e.type === 'polyline') for (const p of e.pts) pts.push(p[0], p[1], 0);
        else if (e.type === 'circle' || e.type === 'polygon') pts.push(e.cx, e.cy, 0);
        else if (e.type === 'slot') pts.push(e.x1, e.y1, 0, e.x2, e.y2, 0);
        else if (e.type === 'rect') pts.push(e.x, e.y, 0, e.x + e.w, e.y, 0, e.x + e.w, e.y + e.h, 0, e.x, e.y + e.h, 0);
      }
      const pg = new THREE.BufferGeometry();
      pg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const pm = new THREE.Points(pg, new THREE.PointsMaterial({ color: this.dark ? '#e8ecf3' : '#1b2330', size: 5, sizeAttenuation: false, depthTest: false }));
      pm.renderOrder = 7;
      pm.userData.noPick = true;
      group.add(pm);
    }
    group.updateMatrixWorld(true);
    return group;
  }

  /** Transient drawing preview (sketch tools). items: [{pts:[[x,y]..], closed, color, dashed}] plus optional guide lines */
  setPreview(frame, items = [], points = []) {
    for (const o of this.previewGroup.children) { o.geometry?.dispose(); o.material?.dispose(); }
    this.previewGroup.clear();
    if (!frame) { this.dirty = true; return; }
    const m = this._frameMatrix(frame, 0.03);
    for (const it of items) {
      if (!it.pts || it.pts.length < 2) continue;
      const v = it.pts.map(([x, y]) => new THREE.Vector3(x, y, 0));
      const g = new THREE.BufferGeometry().setFromPoints(it.closed ? [...v, v[0]] : v);
      const ps = this.pixelSize();
      const mat = it.dashed
        ? new THREE.LineDashedMaterial({ color: it.color || '#4f8cff', dashSize: ps * 5, gapSize: ps * 4, depthTest: false, transparent: true, opacity: it.opacity ?? 1 })
        : new THREE.LineBasicMaterial({ color: it.color || '#4f8cff', depthTest: false, transparent: true, opacity: it.opacity ?? 1 });
      const l = new THREE.Line(g, mat);
      if (it.dashed) l.computeLineDistances();
      l.applyMatrix4(m);
      l.renderOrder = 9;
      this.previewGroup.add(l);
    }
    for (const p of points) {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(p.p[0], p.p[1], 0)]);
      const pm = new THREE.Points(g, new THREE.PointsMaterial({ color: p.color || '#4f8cff', size: p.size || 9, sizeAttenuation: false, depthTest: false }));
      pm.applyMatrix4(m);
      pm.renderOrder = 11;
      this.previewGroup.add(pm);
    }
    this.dirty = true;
  }

  // ------------------------------------------------------------ sketch dimensions
  /** dims from sketchDimensions(); handlers: { onEdit(dim, text), onRemove(dim) }. */
  setDimensions(frame, list = [], handlers = {}) {
    const key = frame ? JSON.stringify([frame, list.map((d) => [d.id, d.text, d.a, d.b, d.c, d.r, d.l1, d.l2, d.side, d.extra, d.driving, d.bad])]) : '';
    this.dims.pending = { frame, list, handlers, key };
    if (this.dimEditing) return; // don't yank the editor away mid-typing
    this._applyDims();
  }

  _applyDims() {
    const p = this.dims.pending;
    if (!p) return;
    this.dims.pending = null;
    if (p.key === this.dims.key && Math.abs(this.pixelSize() - this.dims.ps) / (this.dims.ps || 1) < 0.12) {
      this.dims.list = p.list; this.dims.handlers = p.handlers;
      return;
    }
    Object.assign(this.dims, { frame: p.frame, list: p.list, handlers: p.handlers, key: p.key });
    this._buildDims();
  }

  /** Open the inline editor of a dimension (used right after creating one). */
  editDimension(id) {
    const l = this.dims.labels.find((x) => x.d.id === id);
    if (l) this._editDim(l.el, l.d);
  }

  /** Constraint badges: glyphs = [{ cid, anchor, dir, icon, title, selected, bad }] */
  setGlyphs(frame, glyphs = [], handlers = {}) {
    const key = frame ? JSON.stringify([frame, glyphs.map((g) => [g.cid, g.anchor, g.selected, g.bad])]) : '';
    this.glyphs = this.glyphs || { labels: [], key: '', ps: 0 };
    this.glyphs.handlers = handlers;
    if (key === this.glyphs.key && Math.abs(this.pixelSize() - this.glyphs.ps) / (this.glyphs.ps || 1) < 0.12) return;
    Object.assign(this.glyphs, { frame, list: glyphs, key });
    this._buildGlyphs();
  }

  _buildGlyphs() {
    const G = this.glyphs;
    for (const l of G.labels) l.el.remove();
    G.labels = [];
    G.ps = this.pixelSize();
    if (!G.frame || !G.list || !G.list.length) return;
    const ps = G.ps;
    const stacks = new Map();
    const host = this.container.parentElement;
    for (const g of G.list) {
      const k = `${Math.round(g.anchor[0] / (ps * 6))}:${Math.round(g.anchor[1] / (ps * 6))}`;
      const n = stacks.get(k) || 0;
      stacks.set(k, n + 1);
      const off = (16 + n * 18) * ps;
      const at = [g.anchor[0] + g.dir[0] * off, g.anchor[1] + g.dir[1] * off];
      const el = document.createElement('div');
      el.className = `cglyph${g.selected ? ' selected' : ''}${g.bad ? ' bad' : ''}`;
      el.innerHTML = icon(g.icon);
      el.title = g.title;
      el.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      el.addEventListener('click', (ev) => { ev.stopPropagation(); G.handlers.onClick?.(g.cid, ev); });
      el.addEventListener('contextmenu', (ev) => { ev.preventDefault(); ev.stopPropagation(); G.handlers.onContext?.(g.cid, ev); });
      el.addEventListener('mouseenter', () => G.handlers.onHover?.(g.cid));
      el.addEventListener('mouseleave', () => G.handlers.onHover?.(null));
      host.append(el);
      const f = G.frame;
      G.labels.push({ el, pos: new THREE.Vector3(...[0, 1, 2].map((q) => f.origin[q] + f.xDir[q] * at[0] + f.yDir[q] * at[1])) });
    }
    this._placeLabels();
    this.dirty = true;
  }

  _buildDims() {
    for (const o of this.dimGroup.children) { o.geometry?.dispose(); o.material?.dispose(); }
    this.dimGroup.clear();
    for (const l of this.dims.labels) l.el.remove();
    this.dims.labels = [];
    const { frame, list } = this.dims;
    this.dims.ps = this.pixelSize();
    this.dirty = true;
    if (!frame || !list.length) return;
    const ps = this.dims.ps, off = 26 * ps, over = 5 * ps, gap = 3 * ps, arrow = 8 * ps;
    const segs = [];
    const line = (p, q) => segs.push(p[0], p[1], 0, q[0], q[1], 0);
    const sub = (p, q) => [p[0] - q[0], p[1] - q[1]];
    const addv = (p, v, k = 1) => [p[0] + v[0] * k, p[1] + v[1] * k];
    const unit = (v) => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };
    const arrowAt = (tip, dir) => { // dir points from the inside of the dimension towards the tip
      const n = [-dir[1], dir[0]];
      line(tip, addv(addv(tip, dir, -arrow), n, arrow * 0.32));
      line(tip, addv(addv(tip, dir, -arrow), n, -arrow * 0.32));
    };
    const labels = [];
    for (const d of list) {
      let P, Q, at;
      if (d.kind === 'h' || d.kind === 'v' || d.kind === 'aligned') {
        const A = d.a, B = d.b;
        let n;
        if (d.kind === 'h') {
          const y = d.side > 0 ? Math.max(A[1], B[1]) + off + d.extra : Math.min(A[1], B[1]) - off - d.extra;
          P = [A[0], y]; Q = [B[0], y]; n = [0, Math.sign(d.side)];
        } else if (d.kind === 'v') {
          const x = d.side > 0 ? Math.max(A[0], B[0]) + off + d.extra : Math.min(A[0], B[0]) - off - d.extra;
          P = [x, A[1]]; Q = [x, B[1]]; n = [Math.sign(d.side), 0];
        } else {
          const u = unit(sub(B, A));
          n = [-u[1] * d.side, u[0] * d.side];
          P = addv(A, n, off + d.extra); Q = addv(B, n, off + d.extra);
        }
        if (Math.hypot(Q[0] - P[0], Q[1] - P[1]) < 1e-9) continue;
        // extension lines (with a small gap at the geometry and a small overshoot)
        for (const [G, D] of [[A, P], [B, Q]]) {
          const v = sub(D, G), L = Math.hypot(v[0], v[1]);
          if (L > gap) { const uv = unit(v); line(addv(G, uv, gap), addv(D, uv, over)); }
        }
        line(P, Q);
        const u = unit(sub(Q, P));
        arrowAt(Q, u); arrowAt(P, [-u[0], -u[1]]);
        at = [(P[0] + Q[0]) / 2, (P[1] + Q[1]) / 2];
      } else if (d.kind === 'dia' || d.kind === 'rad') {
        const ang = ((d.kind === 'rad' ? d.angle : 45) * Math.PI) / 180;
        const u = [Math.cos(ang), Math.sin(ang)];
        const end = addv(d.c, u, d.r);
        const start = d.kind === 'dia' ? addv(d.c, u, -d.r) : d.c;
        line(start, end);
        arrowAt(end, u);
        if (d.kind === 'dia') arrowAt(start, [-u[0], -u[1]]);
        const lead = addv(end, u, off);
        line(end, lead);
        at = addv(lead, u, 14 * ps);
      } else if (d.kind === 'angle') {
        const [a1, b1] = d.l1, [a2, b2] = d.l2;
        const d1 = unit(sub(b1, a1)), d2 = unit(sub(b2, a2));
        const den = d1[0] * d2[1] - d1[1] * d2[0];
        if (Math.abs(den) < 1e-9) continue;
        const t = ((a2[0] - a1[0]) * d2[1] - (a2[1] - a1[1]) * d2[0]) / den;
        const V = addv(a1, d1, t);
        const raw = Math.atan2(den, d1[0] * d2[0] + d1[1] * d2[1]);
        const R = 38 * ps, t0 = Math.atan2(d1[1], d1[0]);
        const N = 24;
        let prev = null;
        for (let i = 0; i <= N; i++) {
          const ang = t0 + (raw * i) / N;
          const p = [V[0] + R * Math.cos(ang), V[1] + R * Math.sin(ang)];
          if (prev) line(prev, p);
          prev = p;
        }
        line(V, addv(V, d1, R + over)); line(V, addv(V, d2, R + over));
        const mid = t0 + raw / 2;
        at = [V[0] + (R + 16 * ps) * Math.cos(mid), V[1] + (R + 16 * ps) * Math.sin(mid)];
      } else continue;
      labels.push({ d, at });
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3));
    const mat = new THREE.LineBasicMaterial({ color: this.dark ? '#86a8e0' : '#3c64aa', depthTest: false, transparent: true, opacity: 0.95 });
    const ls = new THREE.LineSegments(g, mat);
    ls.applyMatrix4(this._frameMatrix(frame, 0.04));
    ls.renderOrder = 8;
    ls.userData.noPick = true;
    this.dimGroup.add(ls);
    const host = this.container.parentElement;
    for (const { d, at } of labels) {
      const el = document.createElement('div');
      el.className = `dim-label${d.pos ? ' pos' : ''}${d.driving === false ? ' ghost' : ''}${d.bad ? ' bad' : ''}`;
      el.innerHTML = `${d.fx ? '<span class="fx">fx</span>' : ''}${d.text}`;
      el.title = d.driving === false ? 'Measured value — click to set it as a dimension'
        : `${d.fx ? `${d.expr} — ` : ''}click to edit${d.remove ? ', right-click to remove' : ''}`;
      el.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      el.addEventListener('click', (ev) => { ev.stopPropagation(); this._editDim(el, d); });
      el.addEventListener('contextmenu', (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        if (d.remove && d.driving) this.dims.handlers?.onRemove?.(d);
      });
      host.append(el);
      const w = [0, 1, 2].map((k) => frame.origin[k] + frame.xDir[k] * at[0] + frame.yDir[k] * at[1]);
      this.dims.labels.push({ el, d, pos: new THREE.Vector3(...w) });
    }
    this._placeLabels();
  }

  _editDim(el, d) {
    if (this.dimEditing) return;
    this.dimEditing = d.id;
    el.classList.add('editing');
    const input = document.createElement('input');
    input.value = d.expr && d.fx ? d.expr : d.text.replace(/^[⌀R]/, '').replace(/°$/, '');
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Dimension value');
    el.innerHTML = '';
    el.append(input);
    input.style.width = `${Math.max(64, input.value.length * 8 + 16)}px`;
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      this.dimEditing = null;
      const text = input.value.trim();
      if (commit && text && this.dims.handlers?.onEdit) this.dims.handlers.onEdit(d, text); // usually triggers setDimensions → rebuild
      if (this.dims.pending) this._applyDims();
      if (el.isConnected) this._buildDims(); // cancelled or rejected: put the label back
    };
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') finish(true);
      if (ev.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('input', () => { input.style.width = `${Math.max(64, input.value.length * 8 + 16)}px`; });
    setTimeout(() => { input.focus(); input.select(); });
  }

  _placeLabels() {
    const all = [...this.labels, ...this.dims.labels, ...(this.glyphs ? this.glyphs.labels : [])];
    if (!all.length) return;
    const r = this.renderer.domElement.getBoundingClientRect(), pr = this.container.parentElement.getBoundingClientRect();
    for (const l of all) {
      const v = l.pos.clone().project(this.camera);
      l.el.style.left = `${r.left - pr.left + ((v.x + 1) / 2) * r.width}px`;
      l.el.style.top = `${r.top - pr.top + ((1 - v.y) / 2) * r.height}px`;
    }
  }

  // ------------------------------------------------------------ measure overlay
  setMeasure(a, b) {
    for (const o of this.measureGroup.children) { o.geometry?.dispose(); o.material?.dispose(); }
    this.measureGroup.clear();
    const pts = [a, b].filter(Boolean).map((p) => new THREE.Vector3(...p));
    if (pts.length) {
      const g = new THREE.BufferGeometry().setFromPoints(pts);
      const pm = new THREE.Points(g, new THREE.PointsMaterial({ color: '#ff7a1a', size: 9, sizeAttenuation: false, depthTest: false }));
      pm.renderOrder = 12;
      this.measureGroup.add(pm);
    }
    if (pts.length === 2) {
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: '#ff7a1a', dashSize: this.pixelSize() * 6, gapSize: this.pixelSize() * 4, depthTest: false }));
      l.computeLineDistances();
      l.renderOrder = 12;
      this.measureGroup.add(l);
    }
    this.dirty = true;
  }

  setLabels(labels) {
    for (const l of this.labels) l.el.remove();
    this.labels = labels.map((l) => {
      const el = document.createElement('div');
      el.className = 'vp-label';
      el.textContent = l.text;
      this.container.parentElement.append(el);
      return { pos: new THREE.Vector3(...l.pos), el };
    });
    this.dirty = true;
  }

  // ------------------------------------------------------------ coordinate helpers
  ndc(clientX, clientY) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  }

  toScreen(p) {
    const v = new THREE.Vector3(...p).project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height, v.z];
  }

  /** Intersect the pointer ray with a sketch plane; returns local [x, y] or null. */
  rayToPlane(clientX, clientY, frame) {
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.camera);
    const n = new THREE.Vector3(...frame.normal), o = new THREE.Vector3(...frame.origin);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, o);
    const hit = this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    if (!hit) return null;
    hit.sub(o);
    return [hit.dot(new THREE.Vector3(...frame.xDir)), hit.dot(new THREE.Vector3(...frame.yDir))];
  }

  // ------------------------------------------------------------ picking
  pick(clientX, clientY, filter = this.pickFilter) {
    if (filter === 'none') return null;
    const ndc = this.ndc(clientX, clientY);
    this.raycaster.setFromCamera(ndc, this.camera);
    const wants = (k) => {
      switch (filter) {
        case 'idle': return k === 'face' || k === 'body';
        case 'sketchPlane': return k === 'plane' || k === 'planarFace';
        case 'profiles': return k === 'profile';
        case 'edges': return k === 'edge';
        case 'faces': return k === 'face';
        case 'bodies': case 'body': return k === 'body';
        case 'measure': return k === 'edge' || k === 'face' || k === 'vertex';
        case 'joint': return k === 'edge' || k === 'planarFace';
        default: return false;
      }
    };
    if (wants('profile')) {
      const hit = this.raycaster.intersectObjects(this.sketchPickables, false)[0];
      return hit ? { kind: 'profile', sketchId: hit.object.userData.sketchId, regionId: hit.object.userData.regionId } : null;
    }
    const meshes = [...this.bodies.values()].filter((e) => e.mesh.visible && !e.ghost).map((e) => e.mesh);
    const faceHit = this.raycaster.intersectObjects(meshes, false).find((h) => !this._clipped(h.point));
    const faceDist = faceHit ? faceHit.distance : Infinity;

    if (wants('edge') || wants('vertex')) {
      const e = this._pickEdge(clientX, clientY, faceDist);
      if (e) return e;
    }
    if (wants('plane') && this.planeGroup.visible) {
      const ph = this.raycaster.intersectObjects(this.planeGroup.children, false)[0];
      if (ph && (!faceHit || ph.distance < faceHit.distance - 1e-6)) return { kind: 'plane', plane: ph.object.userData.plane };
    }
    if (!faceHit) return null;
    const entry = this.bodies.get(faceHit.object.userData.bodyId);
    const index = this.faceIndexOf(entry, faceHit.faceIndex);
    const info = this.faceInfo(entry, index);
    if (wants('body')) return { kind: 'body', bodyId: entry.id };
    if (wants('planarFace') && !info.planar) return null;
    if (wants('face') || wants('planarFace')) return { kind: 'face', bodyId: entry.id, index, point: faceHit.point.toArray(), info };
    return null;
  }

  _clipped(p) {
    if (!this.section) return false;
    const pl = this.renderer.clippingPlanes[0];
    return pl.distanceToPoint(p) < 0;
  }

  _pickEdge(clientX, clientY, faceDist) {
    const tolPx = 7;
    let best = null, bd = tolPx;
    const camPos = this.camera.position;
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    const r = this.renderer.domElement.getBoundingClientRect();
    const toPx = (v) => [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
    for (const entry of this.bodies.values()) {
      if (!entry.mesh.visible || entry.ghost) continue;
      const P = entry.data.edgePts;
      entry.data.edgeInfo.forEach((e, ei) => {
        for (let i = 0; i < e.count - 1; i++) {
          const ia = (e.start + i) * 3, ib = ia + 3;
          a.set(P[ia], P[ia + 1], P[ia + 2]); b.set(P[ib], P[ib + 1], P[ib + 2]);
          if (!entry.identity) { a.applyMatrix4(entry.matrix); b.applyMatrix4(entry.matrix); }
          const wa = a.clone(), wb = b.clone();
          a.project(this.camera); b.project(this.camera);
          if (a.z > 1 || b.z > 1) continue;
          const [ax, ay] = toPx(a), [bx, by] = toPx(b);
          const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
          let t = L2 > 0 ? ((clientX - ax) * dx + (clientY - ay) * dy) / L2 : 0;
          t = Math.max(0, Math.min(1, t));
          const d = Math.hypot(clientX - (ax + t * dx), clientY - (ay + t * dy));
          if (d >= bd) continue;
          const wp = wa.clone().lerp(wb, t);
          if (this._clipped(wp)) continue;
          const dist = this.camera.isOrthographicCamera
            ? wp.clone().sub(camPos).dot(this.camera.getWorldDirection(new THREE.Vector3()))
            : wp.distanceTo(camPos);
          const occl = this.camera.isOrthographicCamera ? faceDist : faceDist;
          if (dist > occl + Math.max(0.05, occl * 0.004)) continue;
          bd = d;
          best = { kind: 'edge', bodyId: entry.id, index: ei, info: e, point: wp.toArray() };
        }
      });
    }
    return best;
  }

  // ------------------------------------------------------------ pointer plumbing
  _bindPointer() {
    const el = this.renderer.domElement;
    let down = null;
    el.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, button: e.button, t: performance.now() };
      this.anim = null;
      if (e.button === 0) {
        const intercepted = this.interceptor?.wantsLeft?.();
        // left-drag on empty space orbits; on geometry it selects
        const hit = intercepted ? true : this.pick(e.clientX, e.clientY, this.pickFilter === 'none' ? 'idle' : this.pickFilter);
        this.controls.mouseButtons.LEFT = hit || intercepted ? null : THREE.MOUSE.ROTATE;
      }
      if (this.interceptor?.pointerdown?.(e)) return;
    }, true);
    el.addEventListener('pointermove', (e) => {
      this._lastMove = e;
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) down.moved = true;
      if (!this._moveQueued) {
        this._moveQueued = true;
        requestAnimationFrame(() => {
          this._moveQueued = false;
          const ev = this._lastMove;
          if (this.interceptor?.pointermove?.(ev)) return;
          if (down && down.moved) return;
          this.setHover(this.pick(ev.clientX, ev.clientY));
        });
      }
    });
    el.addEventListener('pointerup', (e) => {
      if (!down) return;
      const click = !down.moved && performance.now() - down.t < 600;
      const d = down;
      down = null;
      if (this.interceptor?.pointerup?.(e, click)) return;
      if (!click) return;
      if (d.button === 0) this.onPick?.(this.pick(e.clientX, e.clientY), e);
      if (d.button === 2) this.onContext?.(this.pick(e.clientX, e.clientY, 'idle'), e);
    });
    el.addEventListener('pointerleave', () => { if (!this.interceptor?.pointerleave?.()) this.setHover(null); });
    el.addEventListener('dblclick', (e) => this.interceptor?.dblclick?.(e));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // ------------------------------------------------------------ render loop
  _frame() {
    const now = performance.now();
    if (this.anim) this.anim(now);
    if (this.controls.enableDamping && this.controls.update()) this.dirty = true;
    if (!this.dirty) return;
    this.dirty = false;
    if (this.camera.isOrthographicCamera) this._updateOrthoFrustum();
    const vh = this.viewHeight();
    this.gridStep = this.grid.update(this.camera, vh);
    const near = Math.max(0.01, vh / 2000);
    this.persp.near = near; this.persp.far = Math.max(10000, vh * 400);
    this.persp.updateProjectionMatrix();
    // dimension offsets are in screen pixels: rebuild them when the zoom changes noticeably
    if (this.dims.frame && !this.dimEditing && Math.abs(this.pixelSize() - this.dims.ps) / (this.dims.ps || 1) > 0.12) this._buildDims();
    if (this.glyphs && this.glyphs.frame && Math.abs(this.pixelSize() - this.glyphs.ps) / (this.glyphs.ps || 1) > 0.12) this._buildGlyphs();
    this.renderer.render(this.scene, this.camera);
    this.cube.render(this.camera, this.controls.target);
    this._placeLabels();
    this.onAfterRender?.();
  }

  requestRender() { this.dirty = true; }
}
