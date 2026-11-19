// 2D sketch geometry: arcs stored as "bulges", entity → primitive paths,
// intersections, trimming, extending, offsetting and corner fillets.
//
// Bulge (as in DXF) = tan(sweep / 4); positive = counter-clockwise. A path is a
// list of primitives: { k: 'L', a, b } or { k: 'A', a, b, bulge }.
import { fmt } from './expr.js';

const EPS = 1e-9;
const num = (v) => fmt(v, 6);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, s) => [a[0] * s, a[1] * s];
const len = (v) => Math.hypot(v[0], v[1]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const unit = (v) => { const l = len(v) || 1; return [v[0] / l, v[1] / l]; };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const TAU = Math.PI * 2;
const mod = (a, m) => ((a % m) + m) % m;

// ------------------------------------------------------------------ arcs
export function arcFromBulge(a, b, bulge) {
  const d = sub(b, a), c = len(d) || 1e-12;
  const sweep = 4 * Math.atan(bulge);
  const nL = [-d[1] / c, d[0] / c];
  const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const h = (c / 2) / Math.tan(sweep / 2);
  const center = add(m, mul(nL, h));
  return { c: center, r: dist(a, center), a0: Math.atan2(a[1] - center[1], a[0] - center[0]), sweep };
}

export const arcPoint = (arc, t) => { const ang = arc.a0 + arc.sweep * t; return [arc.c[0] + arc.r * Math.cos(ang), arc.c[1] + arc.r * Math.sin(ang)]; };
export const arcMid = (a, b, bulge) => arcPoint(arcFromBulge(a, b, bulge), 0.5);

/** Bulge of the arc that starts at a, passes through m and ends at b. */
export function bulgeFromThreePoints(a, m, b) {
  const turn = cross(sub(m, a), sub(b, m));
  if (Math.abs(turn) < 1e-12) return 0;
  const ax = a[0], ay = a[1], bx = m[0], by = m[1], cx = b[0], cy = b[1];
  const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / D;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / D;
  const angA = Math.atan2(ay - uy, ax - ux), angB = Math.atan2(cy - uy, cx - ux);
  const sweep = turn > 0 ? mod(angB - angA, TAU) : -mod(angA - angB, TAU);
  return Math.tan(sweep / 4);
}

/** Bulge of the arc leaving a in direction t (unit) and ending at b. */
export function tangentBulge(a, t, b) {
  const d = sub(b, a);
  const phi = Math.atan2(cross(t, d), dot(t, d));
  return Math.tan(phi / 2);
}

/** Tangent direction at the end of a primitive (for continuing tangent arcs). */
export function endTangent(p) {
  if (p.k === 'L' || Math.abs(p.bulge) < EPS) return unit(sub(p.b, p.a));
  const arc = arcFromBulge(p.a, p.b, p.bulge);
  const r = sub(p.b, arc.c);
  return unit(arc.sweep > 0 ? [-r[1], r[0]] : [r[1], -r[0]]);
}

// ------------------------------------------------------------------ entities → paths
function polygonVerts(e) {
  const out = [];
  for (let i = 0; i < e.n; i++) { const a = ((e.rot || 0) + (360 * i) / e.n) * Math.PI / 180; out.push([e.cx + e.r * Math.cos(a), e.cy + e.r * Math.sin(a)]); }
  return out;
}

export function primsOf(e) {
  const L = (a, b) => ({ k: 'L', a, b });
  const A = (a, b, bulge) => ({ k: 'A', a, b, bulge });
  const ring = (pts) => pts.map((p, i) => L(p, pts[(i + 1) % pts.length]));
  switch (e.type) {
    case 'line': return { prims: [L([e.x1, e.y1], [e.x2, e.y2])], closed: false };
    case 'rect': return { prims: ring([[e.x, e.y], [e.x + e.w, e.y], [e.x + e.w, e.y + e.h], [e.x, e.y + e.h]]), closed: true };
    case 'polygon': return { prims: ring(polygonVerts(e)), closed: true };
    case 'circle': {
      const r = e.d / 2, a = [e.cx + r, e.cy], b = [e.cx - r, e.cy];
      return { prims: [A(a, b, 1), A(b, a, 1)], closed: true };
    }
    case 'slot': {
      const dx = e.x2 - e.x1, dy = e.y2 - e.y1, l = Math.hypot(dx, dy) || 1;
      const px = -dy / l, py = dx / l, r = e.w / 2;
      const P = [e.x1 + px * r, e.y1 + py * r], Q = [e.x2 + px * r, e.y2 + py * r], R = [e.x2 - px * r, e.y2 - py * r], S = [e.x1 - px * r, e.y1 - py * r];
      return { prims: [L(P, Q), A(Q, R, -1), L(R, S), A(S, P, -1)], closed: true };
    }
    case 'polyline': {
      const n = e.pts.length, out = [];
      const segs = e.closed ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        const a = e.pts[i], b = e.pts[(i + 1) % n];
        if (dist(a, b) < 1e-9) continue;
        const bu = (e.bulges && e.bulges[i]) || 0;
        out.push(Math.abs(bu) > EPS ? A(a, b, bu) : L(a, b));
      }
      return { prims: out, closed: !!e.closed };
    }
    case 'arc': {
      const a0 = (e.a0 * Math.PI) / 180, a1 = (e.a1 * Math.PI) / 180;
      const p = (t) => [e.cx + e.r * Math.cos(t), e.cy + e.r * Math.sin(t)];
      return { prims: [A(p(a0), p(a1), Math.tan((a1 - a0) / 4))], closed: false };
    }
    default: return { prims: [], closed: false };
  }
}

/** Polyline points sampled along a path (closed paths don't repeat the first point). */
export function primsOutline(prims, closed) {
  const out = [];
  for (const p of prims) {
    if (p.k === 'L' || Math.abs(p.bulge) < EPS) { out.push(p.a); continue; }
    const arc = arcFromBulge(p.a, p.b, p.bulge);
    const n = Math.max(4, Math.ceil(Math.abs(arc.sweep) / (Math.PI / 36)));
    for (let i = 0; i < n; i++) out.push(arcPoint(arc, i / n));
  }
  if (!closed && prims.length) out.push(prims[prims.length - 1].b);
  return out;
}

export const reversePrim = (p) => (p.k === 'L' ? { k: 'L', a: p.b, b: p.a } : { k: 'A', a: p.b, b: p.a, bulge: -p.bulge });

// ------------------------------------------------------------------ primitive queries
export function primPoint(p, t) {
  if (p.k === 'L' || Math.abs(p.bulge) < EPS) return add(p.a, mul(sub(p.b, p.a), t));
  return arcPoint(arcFromBulge(p.a, p.b, p.bulge), t);
}

/** Sub-primitive between parameters t0 < t1. */
export function primSlice(p, t0, t1) {
  const a = t0 <= 0 ? p.a : t1 >= 1 && t0 >= 1 ? p.b : primPoint(p, t0);
  const b = t1 >= 1 ? p.b : primPoint(p, t1);
  if (p.k === 'L' || Math.abs(p.bulge) < EPS) return { k: 'L', a, b };
  const arc = arcFromBulge(p.a, p.b, p.bulge);
  return { k: 'A', a, b, bulge: Math.tan((arc.sweep * (t1 - t0)) / 4) };
}

/** Parameter of a point that lies on an arc's circle, or null when outside its sweep. */
function arcParam(arc, pt, tol = 1e-7) {
  const ang = Math.atan2(pt[1] - arc.c[1], pt[0] - arc.c[0]);
  const rel = arc.sweep > 0 ? mod(ang - arc.a0, TAU) : mod(arc.a0 - ang, TAU);
  const t = rel / Math.abs(arc.sweep);
  if (t <= 1 + tol) return Math.min(1, t);
  if (t * Math.abs(arc.sweep) >= TAU - tol * Math.abs(arc.sweep)) return 0; // just before the start
  return null;
}

export function nearestOnPrim(p, pt) {
  if (p.k === 'L' || Math.abs(p.bulge) < EPS) {
    const d = sub(p.b, p.a), L2 = dot(d, d) || 1e-12;
    const t = Math.max(0, Math.min(1, dot(sub(pt, p.a), d) / L2));
    return { t, d: dist(pt, add(p.a, mul(d, t))) };
  }
  const arc = arcFromBulge(p.a, p.b, p.bulge);
  let t = arcParam(arc, pt, 0);
  if (t === null) t = dist(pt, p.a) < dist(pt, p.b) ? 0 : 1;
  return { t, d: dist(pt, arcPoint(arc, t)) };
}

/** All intersections between two primitives: [{ ta, tb, p }]. */
export function intersectPrims(P, Q) {
  const out = [];
  const isL = (x) => x.k === 'L' || Math.abs(x.bulge) < EPS;
  const tol = 1e-9;
  if (isL(P) && isL(Q)) {
    const r = sub(P.b, P.a), s = sub(Q.b, Q.a), den = cross(r, s);
    if (Math.abs(den) < 1e-14) return out;
    const qp = sub(Q.a, P.a);
    const ta = cross(qp, s) / den, tb = cross(qp, r) / den;
    if (ta >= -tol && ta <= 1 + tol && tb >= -tol && tb <= 1 + tol) out.push({ ta: Math.max(0, Math.min(1, ta)), tb: Math.max(0, Math.min(1, tb)), p: add(P.a, mul(r, ta)) });
    return out;
  }
  if (!isL(P) && isL(Q)) return intersectPrims(Q, P).map((x) => ({ ta: x.tb, tb: x.ta, p: x.p }));
  if (isL(P)) {
    const arc = arcFromBulge(Q.a, Q.b, Q.bulge);
    const d = sub(P.b, P.a), f = sub(P.a, arc.c);
    const A2 = dot(d, d), B = 2 * dot(f, d), C = dot(f, f) - arc.r * arc.r;
    const disc = B * B - 4 * A2 * C;
    if (disc < -1e-12 || A2 < 1e-18) return out;
    const sq = Math.sqrt(Math.max(0, disc));
    for (const ta of disc < 1e-12 ? [-B / (2 * A2)] : [(-B - sq) / (2 * A2), (-B + sq) / (2 * A2)]) {
      if (ta < -tol || ta > 1 + tol) continue;
      const p = add(P.a, mul(d, ta));
      const tb = arcParam(arc, p);
      if (tb !== null) out.push({ ta: Math.max(0, Math.min(1, ta)), tb, p });
    }
    return out;
  }
  const A1 = arcFromBulge(P.a, P.b, P.bulge), A2c = arcFromBulge(Q.a, Q.b, Q.bulge);
  const dv = sub(A2c.c, A1.c), dd = len(dv);
  if (dd < 1e-12 || dd > A1.r + A2c.r + 1e-9 || dd < Math.abs(A1.r - A2c.r) - 1e-9) return out;
  const aa = (A1.r * A1.r - A2c.r * A2c.r + dd * dd) / (2 * dd);
  const hh = Math.sqrt(Math.max(0, A1.r * A1.r - aa * aa));
  const m = add(A1.c, mul(dv, aa / dd));
  const nrm = [-dv[1] / dd, dv[0] / dd];
  for (const p of hh < 1e-12 ? [m] : [add(m, mul(nrm, hh)), sub(m, mul(nrm, hh))]) {
    const ta = arcParam(A1, p), tb = arcParam(A2c, p);
    if (ta !== null && tb !== null) out.push({ ta, tb, p });
  }
  return out;
}

// ------------------------------------------------------------------ paths → stored entities
/** Turn primitives into a stored entity: a line, or a polyline with bulges. */
export function primsToEntity(prims, { closed = false, construction = false } = {}) {
  if (!prims.length) return null;
  let ent;
  if (prims.length === 1 && !closed && prims[0].k === 'L') {
    const p = prims[0];
    ent = { type: 'line', x1: num(p.a[0]), y1: num(p.a[1]), x2: num(p.b[0]), y2: num(p.b[1]) };
  } else {
    const pts = prims.map((p) => [num(p.a[0]), num(p.a[1])]);
    const bulges = prims.map((p) => (p.k === 'A' ? fmt(p.bulge, 9) : '0'));
    if (!closed) pts.push([num(prims[prims.length - 1].b[0]), num(prims[prims.length - 1].b[1])]);
    else if (bulges.length < pts.length) bulges.push('0');
    ent = { type: 'polyline', pts, bulges, closed };
  }
  if (construction) ent.construction = true;
  return ent;
}

function pathSlice(prims, s0, s1, closed) {
  const n = prims.length, out = [];
  if (closed && s1 <= s0) s1 += n;
  for (let i = Math.floor(s0); i < Math.ceil(s1); i++) {
    const p = prims[mod(i, n)];
    const t0 = Math.max(0, s0 - i), t1 = Math.min(1, s1 - i);
    if (t1 - t0 > 1e-9) out.push(primSlice(p, t0, t1));
  }
  return out;
}

function nearestOnPath(prims, pt) {
  let best = { s: 0, d: Infinity };
  prims.forEach((p, i) => { const r = nearestOnPrim(p, pt); if (r.d < best.d) best = { s: i + r.t, d: r.d }; });
  return best;
}

/** Intersection parameters of a path with every other entity's path. */
function cutParams(prims, others) {
  const S = [];
  for (const o of others) {
    const op = primsOf(o).prims;
    prims.forEach((p, i) => { for (const q of op) for (const x of intersectPrims(p, q)) S.push(i + x.ta); });
  }
  S.sort((a, b) => a - b);
  return S.filter((v, i) => i === 0 || v - S[i - 1] > 1e-7);
}

/**
 * Trim the piece of `target` nearest to `pt` between its neighbouring intersections.
 * Returns { pieces: [stored entities], removed: [prims] } or null when there is nothing to trim.
 */
export function trimEntity(target, others, pt) {
  const { prims, closed } = primsOf(target);
  if (!prims.length) return null;
  const n = prims.length;
  const at = nearestOnPath(prims, pt).s;
  const S = cutParams(prims, others.filter((o) => o.id !== target.id && !o.error));
  const opts = { construction: !!target.construction };
  if (!closed) {
    const below = S.filter((s) => s < at - 1e-9 && s > 1e-7);
    const above = S.filter((s) => s > at + 1e-9 && s < n - 1e-7);
    const lo = below.length ? below[below.length - 1] : 0;
    const hi = above.length ? above[0] : n;
    const pieces = [];
    if (lo > 1e-7) pieces.push(primsToEntity(pathSlice(prims, 0, lo, false), opts));
    if (hi < n - 1e-7) pieces.push(primsToEntity(pathSlice(prims, hi, n, false), opts));
    return { pieces, removed: pathSlice(prims, lo, hi, false) };
  }
  if (S.length < 2) return { pieces: [], removed: prims };
  const below = S.filter((s) => s < at), above = S.filter((s) => s > at);
  const lo = below.length ? below[below.length - 1] : S[S.length - 1];
  const hi = above.length ? above[0] : S[0];
  return { pieces: [primsToEntity(pathSlice(prims, hi, lo, true), opts)], removed: pathSlice(prims, lo, hi, true) };
}

/** Extend the open end of a line/polyline nearest `pt` to the next intersection. Returns a stored patch or null. */
export function extendEntity(target, stored, others, pt) {
  const { prims, closed } = primsOf(target);
  if (closed || !prims.length) return null;
  const first = prims[0], last = prims[prims.length - 1];
  const atEnd = dist(pt, last.b) <= dist(pt, first.a);
  const seg = atEnd ? last : first;
  if (seg.k !== 'L') return null;
  const origin = atEnd ? seg.b : seg.a;
  const dir = atEnd ? unit(sub(seg.b, seg.a)) : unit(sub(seg.a, seg.b));
  const ray = { k: 'L', a: origin, b: add(origin, mul(dir, 1e6)) };
  let best = null;
  for (const o of others) {
    if (o.id === target.id || o.error) continue;
    for (const q of primsOf(o).prims) for (const x of intersectPrims(ray, q)) {
      const u = x.ta * 1e6;
      if (u > 1e-6 && (!best || u < best.u)) best = { u, p: x.p };
    }
  }
  if (!best) return null;
  const p = [num(best.p[0]), num(best.p[1])];
  if (stored.type === 'line') return { patch: atEnd ? { x2: p[0], y2: p[1] } : { x1: p[0], y1: p[1] }, from: origin, to: best.p };
  const pts = stored.pts.map((q) => q.slice());
  if (atEnd) pts[pts.length - 1] = p; else pts[0] = p;
  return { patch: { pts }, from: origin, to: best.p };
}

// ------------------------------------------------------------------ offset
/** Positive for counter-clockwise outlines. */
function signedArea(pts) { let a = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1]; return a / 2; }

/** Offset copy of an entity. d > 0 = outward for closed shapes, left for open ones. Returns a stored entity or null. */
export function offsetEntity(e, d) {
  switch (e.type) {
    case 'circle': return e.d + 2 * d > 1e-6 ? { type: 'circle', cx: num(e.cx), cy: num(e.cy), d: num(e.d + 2 * d) } : null;
    case 'rect': {
      const x = Math.min(e.x, e.x + e.w), y = Math.min(e.y, e.y + e.h), w = Math.abs(e.w) + 2 * d, h = Math.abs(e.h) + 2 * d;
      return w > 1e-6 && h > 1e-6 ? { type: 'rect', x: num(x - d), y: num(y - d), w: num(w), h: num(h) } : null;
    }
    case 'polygon': { const r = e.r + d / Math.cos(Math.PI / e.n); return r > 1e-6 ? { type: 'polygon', cx: num(e.cx), cy: num(e.cy), r: num(r), n: String(e.n), rot: num(e.rot || 0) } : null; }
    case 'slot': return e.w + 2 * d > 1e-6 ? { type: 'slot', x1: num(e.x1), y1: num(e.y1), x2: num(e.x2), y2: num(e.y2), w: num(e.w + 2 * d) } : null;
    default: break;
  }
  const { prims, closed } = primsOf(e);
  if (!prims.length) return null;
  const s = closed ? (signedArea(primsOutline(prims, true)) > 0 ? -d : d) : d; // signed distance to the left
  const off = [];
  for (const p of prims) {
    if (p.k === 'L') {
      const u = unit(sub(p.b, p.a)), n = [-u[1] * s, u[0] * s];
      off.push({ k: 'L', a: add(p.a, n), b: add(p.b, n) });
    } else {
      const arc = arcFromBulge(p.a, p.b, p.bulge);
      const r = arc.r - s * Math.sign(arc.sweep);
      if (r <= 1e-6) return null;
      const q = { c: arc.c, r, a0: arc.a0, sweep: arc.sweep };
      off.push({ k: 'A', a: arcPoint(q, 0), b: arcPoint(q, 1), bulge: p.bulge });
    }
  }
  // joins: tangent → already continuous; line–line → miter; otherwise a round join around the original corner
  const out = [];
  const count = off.length;
  for (let i = 0; i < count; i++) {
    const cur = off[i];
    out.push(cur);
    const j = i + 1;
    if (j >= count && !closed) break;
    const nxt = off[j % count];
    if (dist(cur.b, nxt.a) < 1e-7) continue;
    if (cur.k === 'L' && nxt.k === 'L') {
      const r = sub(cur.b, cur.a), q = sub(nxt.b, nxt.a), den = cross(r, q);
      if (Math.abs(den) > 1e-12) {
        const t = cross(sub(nxt.a, cur.a), q) / den;
        const X = add(cur.a, mul(r, t));
        cur.b = X; nxt.a = X;
        continue;
      }
    }
    const V = prims[i].b;
    const mid = add(V, mul(unit(add(sub(cur.b, V), sub(nxt.a, V))), Math.abs(s)));
    out.push({ k: 'A', a: cur.b, b: nxt.a, bulge: bulgeFromThreePoints(cur.b, mid, nxt.a) });
  }
  return primsToEntity(out, { closed });
}

// ------------------------------------------------------------------ fillets
/**
 * Fillet two straight segments meeting at V (coming from P, going to N).
 * Returns { t1, t2, bulge } or an { error }.
 */
export function filletCorner(P, V, N, r) {
  const u1 = unit(sub(P, V)), u2 = unit(sub(N, V));
  const theta = Math.acos(Math.max(-1, Math.min(1, dot(u1, u2))));
  if (theta < 1e-3 || theta > Math.PI - 1e-3) return { error: 'Those segments are in line — there is no corner to round' };
  const t = r / Math.tan(theta / 2);
  if (t > dist(P, V) - 1e-7 || t > dist(N, V) - 1e-7) return { error: 'Radius too large for those segments' };
  const turn = cross(sub(V, P), sub(N, V));
  const bulge = Math.sign(turn) * Math.tan((Math.PI - theta) / 4);
  return { t1: add(V, mul(u1, t)), t2: add(V, mul(u2, t)), bulge };
}
