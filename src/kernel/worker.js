// Geometry kernel worker: rebuilds the parametric timeline with OpenCascade (via replicad)
// and returns render meshes. Runs off the UI thread so the interface never freezes.
import opencascade from 'https://cdn.jsdelivr.net/npm/replicad-opencascadejs@1.1.0/dist/replicad_single.js';
import * as R from 'https://cdn.jsdelivr.net/npm/replicad@1.1.0/+esm';
import { evaluate, evaluateParams } from '../model/expr.js';
import { evalEntity, computeRegions, polygonVerts, slotFrame } from '../model/profiles.js';
import { primsOf, arcMid } from '../model/sketchgeom.js';
import { planeFrame, scale, dist, norm, cross, dot } from '../model/geom.js';

const WASM_URL = 'https://cdn.jsdelivr.net/npm/replicad-opencascadejs@1.1.0/dist/replicad_single.wasm';
const WASM_SIZE = 22980267;

const post = (msg) => self.postMessage(msg);

async function fetchWasm() {
  const res = await fetch(WASM_URL);
  if (!res.ok || !res.body) throw new Error(`Could not download the kernel (${res.status})`);
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0, lastPost = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    const now = performance.now();
    if (now - lastPost > 80) { lastPost = now; post({ type: 'progress', loaded, total: WASM_SIZE }); }
  }
  const bin = new Uint8Array(loaded);
  let o = 0;
  for (const c of chunks) { bin.set(c, o); o += c.length; }
  post({ type: 'progress', loaded, total: loaded });
  return bin;
}

const ready = (async () => {
  let oc;
  try {
    const bin = await fetchWasm();
    oc = await opencascade({ wasmBinary: bin.buffer, locateFile: () => WASM_URL });
  } catch (e) {
    console.warn('Streaming kernel load failed, retrying directly', e);
    oc = await opencascade({ locateFile: () => WASM_URL });
  }
  R.setOC(oc);
  post({ type: 'ready' });
})().catch((e) => post({ type: 'fatal', error: String(e && e.message || e) }));

// ---------------------------------------------------------------- helpers

const KERNEL_FAIL = 'The geometry kernel could not compute this operation — try different values or selections';
function errMsg(e) {
  if (typeof e === 'number') return KERNEL_FAIL;
  if (typeof WebAssembly !== 'undefined' && WebAssembly.Exception && e instanceof WebAssembly.Exception) return KERNEL_FAIL;
  const m = (e && e.message) || String(e);
  return /^\d+$/.test(m) || /WebAssembly|RuntimeError|unreachable|memory access/i.test(m) ? KERNEL_FAIL : m;
}

/** Run a kernel operation and translate low-level failures into a helpful message. */
function attempt(fn, friendly) {
  try { return fn(); } catch (e) {
    const m = errMsg(e);
    throw new Error(m === KERNEL_FAIL ? friendly : m);
  }
}

function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(36);
}

const AXES = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };
const neg = (v) => [-v[0], -v[1], -v[2]];
const tuple = (vec) => { const t = [vec.x, vec.y, vec.z]; vec.delete?.(); return t; };

function polyDrawing(pts) {
  if (pts.length < 3) throw new Error('A closed profile needs at least 3 points');
  let pen = R.draw(pts[0]);
  for (let i = 1; i < pts.length; i++) pen = pen.lineTo(pts[i]);
  return pen.close();
}

/** Closed path of lines and bulge arcs → replicad drawing. */
function primsDrawing(prims) {
  if (!prims.length) throw new Error('Empty profile');
  let pen = R.draw(prims[0].a);
  for (const p of prims) pen = p.k === 'A' ? pen.threePointsArcTo(p.b, arcMid(p.a, p.b, p.bulge)) : pen.lineTo(p.b);
  return pen.close();
}

function srcDrawing(src) {
  return src.type === 'loop' ? primsDrawing(src.prims) : entityDrawing(src.ent);
}

function entityDrawing(e) {
  if (e.type === 'polyline') return primsDrawing(primsOf(e).prims);
  switch (e.type) {
    case 'rect': return R.drawRectangle(Math.abs(e.w), Math.abs(e.h)).translate(e.x + e.w / 2, e.y + e.h / 2);
    case 'circle': return R.drawCircle(e.d / 2).translate(e.cx, e.cy);
    case 'polygon': return polyDrawing(polygonVerts(e));
    case 'slot': {
      const { ux, uy, px, py, r } = slotFrame(e);
      const A = [e.x1 + px * r, e.y1 + py * r], B = [e.x2 + px * r, e.y2 + py * r];
      const C = [e.x2 - px * r, e.y2 - py * r], D = [e.x1 - px * r, e.y1 - py * r];
      return R.draw(A).lineTo(B).threePointsArcTo(C, [e.x2 + ux * r, e.y2 + uy * r])
        .lineTo(D).threePointsArcTo(A, [e.x1 - ux * r, e.y1 - uy * r]).close();
    }
    default: throw new Error(`Entity "${e.type}" is not a closed profile`);
  }
}

function sketchContext(sketch, scope) {
  if (!sketch) throw new Error('The referenced sketch no longer exists');
  const frame = planeFrame(sketch.plane, scope);
  const ents = sketch.entities.map((e) => evalEntity(e, scope));
  const bad = ents.find((e) => e.error);
  if (bad) throw new Error(`Sketch "${sketch.name}": ${bad.error}`);
  return { frame, ents, regions: computeRegions(ents) };
}

function profileDrawing(ctx, profileIds) {
  const chosen = ctx.regions.filter((r) => profileIds.includes(r.id));
  if (!chosen.length) throw new Error('Select at least one profile');
  let drawing = null;
  for (const r of chosen) {
    let d = srcDrawing(r.src);
    for (const cs of r.childSrcs) d = d.cut(srcDrawing(cs));
    drawing = drawing ? drawing.fuse(d) : d;
  }
  return drawing;
}

const makePlane = (f) => new R.Plane(f.origin, f.xDir, f.normal);

function isEmpty(shape) {
  if (!shape || shape.isNull) return true;
  try { return shape.faces.length === 0; } catch { return true; }
}

function bboxOverlap(a, b) {
  const ba = a.boundingBox, bb = b.boundingBox;
  const out = ba.isOut(bb);
  ba.delete?.(); bb.delete?.();
  return !out;
}

// ---------------------------------------------------------------- state

class State {
  constructor(prev) {
    this.bodies = new Map(prev ? prev.bodies : []); // id -> { shape, n }
    this.count = prev ? prev.count : 0;
  }
  add(id, shape) { this.count += 1; this.bodies.set(id, { shape, n: this.count }); }
  get(id) {
    const b = this.bodies.get(id);
    if (!b) throw new Error('A selected body no longer exists');
    return b.shape;
  }
  set(id, shape) { const b = this.bodies.get(id); this.bodies.set(id, { shape, n: b.n }); }
}

function applyOperation(state, f, tool) {
  const op = f.operation || 'new';
  if (op === 'new') { state.add(`b:${f.id}`, tool); return; }
  let targets = (f.targets || []).filter((t) => state.bodies.has(t));
  if (!targets.length) targets = [...state.bodies.keys()].filter((id) => bboxOverlap(state.get(id), tool));
  if (!targets.length) {
    if (op === 'join') { state.add(`b:${f.id}`, tool); return; }
    throw new Error(`Nothing to ${op} — the new shape doesn't touch any body`);
  }
  if (op === 'join') {
    let acc = attempt(() => state.get(targets[0]).fuse(tool), 'Join failed');
    for (const t of targets.slice(1)) { acc = attempt(() => acc.fuse(state.get(t)), 'Join failed'); state.bodies.delete(t); }
    state.set(targets[0], acc);
    return;
  }
  for (const t of targets) {
    const res = attempt(() => (op === 'cut' ? state.get(t).cut(tool) : state.get(t).intersect(tool)), `${op === 'cut' ? 'Cut' : 'Intersect'} failed`);
    if (isEmpty(res)) state.bodies.delete(t); else state.set(t, res);
  }
}

function edgeInfo(e) {
  const type = e.geomType;
  const mid = tuple(e.pointAt(0.5));
  let dir = null;
  if (type === 'LINE') dir = norm(tuple(e.tangentAt(0.5)));
  return { type, mid, dir, len: e.length };
}

function bounds(shape) {
  const bb = shape.boundingBox;
  const [lo, hi] = bb.bounds;
  bb.delete?.();
  const ext = [0, 1, 2].map((k) => Math.max(hi[k] - lo[k], 1e-6));
  return { lo, hi, ext, diag: Math.hypot(...ext) || 1, np: (p) => [0, 1, 2].map((k) => (p[k] - lo[k]) / ext[k]) };
}

/**
 * Topology-aware description of every edge: geometry type, midpoint, direction,
 * position normalised to the body's bounding box, and the types of the faces it joins.
 * These let edge references survive upstream parameter changes much better than raw positions.
 */
function describeEdges(shape) {
  const edges = shape.edges;
  const bb = bounds(shape);
  const byHash = new Map();
  edges.forEach((e, i) => { const k = e.hashCode; if (!byHash.has(k)) byHash.set(k, []); byHash.get(k).push(i); });
  const adj = edges.map(() => []);
  for (const f of shape.faces) {
    const t = f.geomType;
    for (const fe of f.edges) {
      for (const i of byHash.get(fe.hashCode) || []) if (edges[i].isSame(fe)) { adj[i].push(t); break; }
      fe.delete?.();
    }
    f.delete?.();
  }
  const infos = edges.map((e, i) => {
    const info = edgeInfo(e);
    return { ...info, np: bb.np(info.mid), adj: adj[i].sort().join('+') };
  });
  return { edges, infos, bb };
}

function matchEdges(shape, refs) {
  const { edges, infos, bb } = describeEdges(shape);
  const used = new Set();
  const matched = [];
  let missing = 0;
  for (const ref of refs) {
    let best = -1, bs = Infinity;
    infos.forEach((info, i) => {
      if (used.has(i) || info.type !== ref.type) return;
      if (ref.adj && info.adj && ref.adj !== info.adj) return;
      if (ref.dir && info.dir && Math.abs(dot(ref.dir, info.dir)) < 0.95) return;
      const dAbs = dist(info.mid, ref.p);
      if (dAbs > Math.max(2, 0.6 * (ref.len || 0), 0.5 * bb.diag)) return;
      const s = ref.np ? dist(info.np, ref.np) * bb.diag + 0.25 * dAbs : dAbs;
      if (s < bs) { bs = s; best = i; }
    });
    if (best >= 0) { used.add(best); matched.push(edges[best]); } else missing++;
  }
  return { matched, missing };
}

function matchFaces(shape, refs) {
  const faces = shape.faces;
  const bb = bounds(shape);
  const infos = faces.map((f) => {
    const c = tuple(f.center);
    let n = null;
    try { n = tuple(f.normalAt(c)); } catch { /* ignore */ }
    return { c, n, np: bb.np(c), type: f.geomType };
  });
  const used = new Set();
  const matched = [];
  let missing = 0;
  for (const ref of refs) {
    let best = -1, bs = Infinity;
    infos.forEach((info, i) => {
      if (used.has(i)) return;
      if (ref.planar && (info.type !== 'PLANE' || !info.n || dot(norm(info.n), ref.n) < 0.98)) return;
      const dAbs = dist(info.c, ref.p);
      if (dAbs > Math.max(2, ref.size || 0, 0.5 * bb.diag)) return;
      const s = ref.np ? dist(info.np, ref.np) * bb.diag + 0.25 * dAbs : dAbs;
      if (s < bs) { bs = s; best = i; }
    });
    if (best >= 0) { used.add(best); matched.push(faces[best]); } else missing++;
  }
  return { matched, missing };
}

function groupBy(list, key) {
  const m = new Map();
  for (const x of list) { const k = x[key]; if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
}

// ---------------------------------------------------------------- features

function applyFeature(f, state, scope, sketches, warn) {
  const E = (v) => evaluate(v, scope);
  switch (f.type) {
    case 'sketch': return;

    case 'extrude': {
      const ctx = sketchContext(sketches.get(f.sketch), scope);
      const drawing = profileDrawing(ctx, f.profiles || []);
      let d = E(f.distance);
      let dir = ctx.frame.normal;
      if (f.flip && f.extent !== 'symmetric') dir = neg(dir);
      if (d < 0) { d = -d; dir = neg(dir); }
      if (d < 1e-6) throw new Error('Distance must not be zero');
      const make = (dd, dv) => drawing.clone().sketchOnPlane(makePlane(ctx.frame)).extrude(dd, { extrusionDirection: dv });
      let solid;
      if (f.extent === 'symmetric') solid = make(d, dir).translate(scale(dir, -d / 2));
      else if (f.extent === 'two') {
        const d2 = Math.abs(E(f.distance2));
        solid = make(d, dir);
        if (d2 > 1e-6) solid = solid.fuse(make(d2, neg(dir)));
      } else solid = make(d, dir);
      applyOperation(state, f, solid);
      return;
    }

    case 'revolve': {
      const sk = sketches.get(f.sketch);
      const ctx = sketchContext(sk, scope);
      const drawing = profileDrawing(ctx, f.profiles || []);
      const angle = E(f.angle);
      if (Math.abs(angle) < 1e-6) throw new Error('Angle must not be zero');
      let axis, origin = ctx.frame.origin;
      if (f.axis === 'x') axis = ctx.frame.xDir;
      else if (f.axis === 'y') axis = ctx.frame.yDir;
      else {
        const line = ctx.ents.find((e) => e.id === f.axis && e.type === 'line');
        if (!line) throw new Error('The revolve axis line no longer exists');
        const fr = ctx.frame;
        const w = (x, y) => [0, 1, 2].map((k) => fr.origin[k] + fr.xDir[k] * x + fr.yDir[k] * y);
        const a = w(line.x1, line.y1), b = w(line.x2, line.y2);
        axis = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
        origin = a;
      }
      const solid = drawing.sketchOnPlane(makePlane(ctx.frame)).revolve(axis, { origin, angle: Math.min(360, Math.abs(angle)) * Math.sign(angle) });
      applyOperation(state, f, solid);
      return;
    }

    case 'box': {
      const w = E(f.w), d = E(f.d), h = E(f.h), x = E(f.x), y = E(f.y), z = E(f.z);
      if (!w || !d || !h) throw new Error('Box dimensions must not be zero');
      const a = [x - Math.abs(w) / 2, y - Math.abs(d) / 2, Math.min(z, z + h)];
      const b = [x + Math.abs(w) / 2, y + Math.abs(d) / 2, Math.max(z, z + h)];
      applyOperation(state, f, R.makeBox(a, b));
      return;
    }
    case 'cylinder': {
      const d = E(f.d), h = E(f.h);
      if (d <= 0 || !h) throw new Error('Diameter and height must be positive');
      let dir = AXES[f.axis || 'Z'];
      if (h < 0) dir = neg(dir);
      applyOperation(state, f, R.makeCylinder(d / 2, Math.abs(h), [E(f.x), E(f.y), E(f.z)], dir));
      return;
    }
    case 'sphere': {
      const d = E(f.d);
      if (d <= 0) throw new Error('Diameter must be positive');
      applyOperation(state, f, R.makeSphere(d / 2).translate([E(f.x), E(f.y), E(f.z)]));
      return;
    }
    case 'torus': {
      const D = E(f.d), t = E(f.t);
      if (t <= 0 || D <= t) throw new Error('Ring diameter must be larger than the tube diameter');
      const axis = AXES[f.axis || 'Z'];
      const radial = f.axis === 'X' ? [0, 1, 0] : [1, 0, 0];
      const center = [E(f.x), E(f.y), E(f.z)];
      const plane = new R.Plane(center, radial, cross(radial, axis));
      const solid = R.drawCircle(t / 2).translate(D / 2, 0).sketchOnPlane(plane).revolve(axis, { origin: center });
      applyOperation(state, f, solid);
      return;
    }

    case 'fillet':
    case 'chamfer': {
      const r = E(f.type === 'fillet' ? f.radius : f.distance);
      if (r <= 0) throw new Error('Size must be positive');
      if (!f.edges?.length) throw new Error('Select at least one edge');
      for (const [bodyId, refs] of groupBy(f.edges, 'body')) {
        const shape = state.get(bodyId);
        const { matched, missing } = matchEdges(shape, refs);
        if (!matched.length) throw new Error('The selected edges could not be found (the model changed upstream)');
        if (missing) warn(`${missing} edge(s) could not be found and were skipped`);
        const pick = (e) => (matched.some((m) => m.isSame(e)) ? r : null);
        const res = attempt(() => (f.type === 'fillet' ? shape.fillet(pick) : shape.chamfer(pick)),
          `${f.type === 'fillet' ? 'Fillet' : 'Chamfer'} failed — the size may be too large for the selected edges, or an edge can't be ${f.type === 'fillet' ? 'rounded' : 'bevelled'}`);
        state.set(bodyId, res);
      }
      return;
    }

    case 'shell': {
      const t = E(f.thickness);
      if (t <= 0) throw new Error('Thickness must be positive');
      if (!f.faces?.length) throw new Error('Select at least one face to remove');
      for (const [bodyId, refs] of groupBy(f.faces, 'body')) {
        const shape = state.get(bodyId);
        const { matched, missing } = matchFaces(shape, refs);
        if (!matched.length) throw new Error('The selected faces could not be found');
        if (missing) warn(`${missing} face(s) could not be found and were skipped`);
        state.set(bodyId, attempt(() => shape.shell(t, (finder) => finder.inList(matched)), 'Shell failed — try a thinner wall or different faces'));
      }
      return;
    }

    case 'move': {
      const dx = E(f.dx), dy = E(f.dy), dz = E(f.dz), ang = E(f.angle);
      (f.bodies || []).forEach((id, i) => {
        let s = state.get(id).clone();
        if (Math.abs(ang) > 1e-9) s = s.rotate(ang, [0, 0, 0], AXES[f.axis || 'Z']);
        if (dx || dy || dz) s = s.translate([dx, dy, dz]);
        if (f.copy) state.add(`b:${f.id}:${i}`, s); else state.set(id, s);
      });
      if (!f.bodies?.length) throw new Error('Select at least one body');
      return;
    }

    case 'mirror': {
      if (!f.bodies?.length) throw new Error('Select at least one body');
      f.bodies.forEach((id, i) => {
        const src = state.get(id);
        const m = src.clone().mirror(f.plane || 'YZ', [0, 0, 0]);
        if (f.join) state.set(id, src.fuse(m)); else state.add(`b:${f.id}:${i}`, m);
      });
      return;
    }

    case 'pattern': {
      if (!f.bodies?.length) throw new Error('Select at least one body');
      const copiesOf = (src) => {
        const out = [];
        if (f.kind === 'rect') {
          const nx = Math.max(1, Math.round(E(f.countX))), ny = Math.max(1, Math.round(E(f.countY)));
          const sx = E(f.spacingX), sy = E(f.spacingY);
          if (nx * ny > 400) throw new Error('Too many instances (max 400)');
          for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) if (i || j) out.push(src.clone().translate([i * sx, j * sy, 0]));
        } else {
          const n = Math.max(1, Math.round(E(f.count)));
          const total = E(f.angle);
          if (n > 400) throw new Error('Too many instances (max 400)');
          const full = Math.abs(Math.abs(total) - 360) < 1e-6;
          const step = full ? total / n : total / Math.max(1, n - 1);
          for (let i = 1; i < n; i++) out.push(src.clone().rotate(step * i, [0, 0, 0], AXES[f.axis || 'Z']));
        }
        return out;
      };
      f.bodies.forEach((id, bi) => {
        const src = state.get(id);
        const copies = copiesOf(src);
        if (f.join) {
          let acc = src;
          for (const c of copies) acc = acc.fuse(c);
          state.set(id, acc);
        } else copies.forEach((c, i) => state.add(`b:${f.id}:${bi}:${i}`, c));
      });
      return;
    }

    case 'combine': {
      const target = (f.target || [])[0];
      if (!target) throw new Error('Select a target body');
      const tools = (f.tools || []).filter((t) => t !== target);
      if (!tools.length) throw new Error('Select at least one tool body');
      let acc = state.get(target);
      for (const t of tools) {
        const ts = state.get(t);
        acc = f.operation === 'cut' ? acc.cut(ts) : f.operation === 'intersect' ? acc.intersect(ts) : acc.fuse(ts);
        if (!f.keepTools) state.bodies.delete(t);
      }
      if (isEmpty(acc)) state.bodies.delete(target); else state.set(target, acc);
      return;
    }

    case 'remove': {
      if (!f.bodies?.length) throw new Error('Select at least one body');
      for (const id of f.bodies) state.bodies.delete(id);
      return;
    }
    default:
      throw new Error(`Unknown feature type "${f.type}"`);
  }
}

// ---------------------------------------------------------------- rebuild + meshing

// one build cache per document key ('main' for the open part, library ids for assembly parts)
const stores = new Map();
const store = (key = 'main') => {
  if (!stores.has(key)) stores.set(key, { cache: [], lastState: new State() }); // cache: [{ hash, state, error, warning }]
  return stores.get(key);
};
const meshCache = new WeakMap();
let meshSeq = 0;

function meshShape(shape, quality) {
  let m = meshCache.get(shape);
  if (m && m.quality === quality) return m;
  const bb0 = shape.boundingBox;
  const [lo, hi] = bb0.bounds;
  bb0.delete?.();
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  const tol = Math.max(0.005, diag * (quality === 'fine' ? 0.0002 : 0.0006));
  const ang = quality === 'fine' ? 0.1 : 0.2;
  const mesh = shape.mesh({ tolerance: tol, angularTolerance: ang });
  const { edges, infos } = describeEdges(shape);
  const pts = [];
  const info = [];
  for (const [ix, e] of edges.entries()) {
    const ei = infos[ix];
    const start = pts.length / 3;
    if (ei.type === 'LINE') {
      pts.push(...tuple(e.pointAt(0)), ...tuple(e.pointAt(1)));
    } else {
      const n = Math.max(8, Math.min(64, Math.ceil(ei.len / 1.5)));
      for (let i = 0; i <= n; i++) pts.push(...tuple(e.pointAt(i / n)));
    }
    info.push({ start, count: pts.length / 3 - start, ...ei });
    e.delete?.();
  }
  let volume = 0, area = 0;
  try { volume = R.measureVolume(shape); } catch { /* not a solid */ }
  try { area = R.measureArea(shape); } catch { /* ignore */ }
  const bb = shape.boundingBox;
  const bbox = bb.bounds;
  bb.delete?.();
  m = {
    quality,
    key: ++meshSeq,
    vertices: new Float32Array(mesh.vertices),
    normals: new Float32Array(mesh.normals),
    triangles: new Uint32Array(mesh.triangles),
    groups: mesh.faceGroups.map((g) => [g.start, g.count]),
    edgePts: new Float32Array(pts),
    edgeInfo: info,
    volume, area, bbox,
  };
  meshCache.set(shape, m);
  return m;
}

function rebuild({ params, features, quality, key }) {
  const t0 = performance.now();
  const st = store(key);
  const cache = st.cache;
  const scope = evaluateParams(params || []);
  const scopeKey = JSON.stringify(scope, (k, v) => (v instanceof Error ? `!${v.message}` : v));
  const sketches = new Map(features.filter((f) => f.type === 'sketch').map((f) => [f.id, f]));
  const newCache = [];
  let state = new State();
  let h = hashStr(scopeKey);
  let reuse = true;
  const errors = {}, warnings = {};
  features.forEach((f, i) => {
    h = hashStr(h + JSON.stringify(f));
    const c = cache[i];
    if (reuse && c && c.hash === h) {
      state = c.state;
      if (c.error) errors[f.id] = c.error;
      if (c.warning) warnings[f.id] = c.warning;
      newCache.push(c);
      return;
    }
    reuse = false;
    const next = new State(state);
    let error = null, warning = null;
    if (!f.suppressed) {
      try {
        applyFeature(f, next, scope, sketches, (w) => { warning = warning ? `${warning}; ${w}` : w; });
        state = next;
      } catch (e) {
        error = errMsg(e);
        console.warn(`Feature ${f.name} failed`, e);
      }
    }
    if (error) errors[f.id] = error;
    if (warning) warnings[f.id] = warning;
    newCache.push({ hash: h, state, error, warning });
  });

  // free shapes that are no longer referenced by any cached state
  const live = new Set();
  for (const c of newCache) for (const b of c.state.bodies.values()) live.add(b.shape);
  const dead = new Set();
  for (const c of cache) for (const b of c.state.bodies.values()) if (!live.has(b.shape)) dead.add(b.shape);
  st.cache = newCache;
  st.lastState = state;
  for (const s of dead) { try { s.delete(); } catch { /* already freed */ } }

  const bodies = [];
  for (const [id, b] of state.bodies) {
    try {
      const m = meshShape(b.shape, quality || 'normal');
      bodies.push({ id, n: b.n, ...m });
    } catch (e) {
      console.warn('Meshing failed', e);
    }
  }
  return { bodies, errors, warnings, ms: Math.round(performance.now() - t0) };
}

function writeExport(format, list) {
  if (!list.length) throw new Error('There are no bodies to export');
  if (format === 'step') {
    return R.exportSTEP(list.map((b) => ({ shape: b.shape, name: b.name, color: b.color })), { unit: 'mm' });
  }
  const shape = list.length === 1 ? list[0].shape : R.makeCompound(list.map((b) => b.shape));
  return shape.blobSTL({ binary: true, tolerance: 0.01, angularTolerance: 0.1 });
}

function exportShapes({ format, bodies }) {
  const st = store('main');
  return writeExport(format, bodies.map((b) => ({ ...b, shape: st.lastState.bodies.get(b.id)?.shape })).filter((b) => b.shape));
}

/** Build every distinct part of an assembly (each with its own cache). */
function rebuildAssembly({ parts, quality }) {
  const t0 = performance.now();
  const out = {};
  for (const p of parts) out[p.key] = rebuild({ params: p.params, features: p.features, quality, key: p.key });
  return { parts: out, ms: Math.round(performance.now() - t0) };
}

/** instances: [{ key, bodyId, name, color, t:[x,y,z], axis:[..], angle (deg) }] — placed copies of part bodies. */
function exportAssembly({ format, instances }) {
  const list = [];
  for (const it of instances) {
    const src = store(it.key).lastState.bodies.get(it.bodyId)?.shape;
    if (!src) continue;
    let s = src.clone();
    if (Math.abs(it.angle) > 1e-9) s = s.rotate(it.angle, [0, 0, 0], it.axis);
    s = s.translate(it.t);
    list.push({ shape: s, name: it.name, color: it.color });
  }
  return writeExport(format, list);
}

self.onmessage = async (ev) => {
  const { id, type, payload } = ev.data;
  try {
    await ready;
    let result;
    if (type === 'rebuild') result = rebuild(payload);
    else if (type === 'assembly') result = rebuildAssembly(payload);
    else if (type === 'export') result = exportShapes(payload);
    else if (type === 'exportAssembly') result = exportAssembly(payload);
    else throw new Error(`Unknown request ${type}`);
    post({ id, ok: true, result });
  } catch (e) {
    console.error(e);
    post({ id, ok: false, error: errMsg(e) });
  }
};
