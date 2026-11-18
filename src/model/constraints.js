// Geometric constraint solver for sketches.
//
// Every literal (non-expression, unlocked) numeric field of a sketch entity is a
// free variable. Constraints add residual equations. A damped least-squares
// (Levenberg–Marquardt, minimum-norm) solver moves the free variables as little
// as possible to satisfy them. Expression fields, locked fields (driving
// dimensions) and fixed entities never move.
import { evaluate, fmt } from './expr.js';
import { NUMERIC_FIELDS, evalEntity, polygonVerts, slotFrame } from './profiles.js';

export const isLiteral = (s) => typeof s === 'number' || /^\s*-?\d*\.?\d+(e[+-]?\d+)?\s*(mm)?\s*$/i.test(String(s));

// ------------------------------------------------------------------ 2D helpers
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const len = (v) => Math.hypot(v[0], v[1]);
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const unit = (v) => { const l = len(v) || 1e-12; return [v[0] / l, v[1] / l]; };
export const signedDist = (p, a, b) => cross(unit(sub(b, a)), sub(p, a));
export const footOn = (p, a, b) => { const u = unit(sub(b, a)); const t = dot(sub(p, a), u); return [a[0] + u[0] * t, a[1] + u[1] * t]; };
const wrapPi = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
export const dirAngle = (d1, d2) => Math.atan2(cross(d1, d2), dot(d1, d2));

// ------------------------------------------------------------------ geometric elements
/** Points, lines and circles an evaluated entity exposes to constraints and snapping. */
export function elementsOf(e) {
  const P = {}, L = {}, C = {};
  switch (e.type) {
    case 'line': P.p1 = [e.x1, e.y1]; P.p2 = [e.x2, e.y2]; L.seg = [P.p1, P.p2]; break;
    case 'rect': {
      const v = [[e.x, e.y], [e.x + e.w, e.y], [e.x + e.w, e.y + e.h], [e.x, e.y + e.h]];
      v.forEach((p, i) => { P[`v${i}`] = p; L[`e${i}`] = [p, v[(i + 1) % 4]]; });
      P.c = [e.x + e.w / 2, e.y + e.h / 2];
      break;
    }
    case 'circle': P.c = [e.cx, e.cy]; C.circ = { c: P.c, r: e.d / 2 }; break;
    case 'polygon': {
      const v = polygonVerts(e);
      P.c = [e.cx, e.cy];
      v.forEach((p, i) => { P[`v${i}`] = p; L[`s${i}`] = [p, v[(i + 1) % v.length]]; });
      break;
    }
    case 'slot': {
      const { px, py, r } = slotFrame(e);
      P.p1 = [e.x1, e.y1]; P.p2 = [e.x2, e.y2];
      L.side0 = [[e.x1 + px * r, e.y1 + py * r], [e.x2 + px * r, e.y2 + py * r]];
      L.side1 = [[e.x2 - px * r, e.y2 - py * r], [e.x1 - px * r, e.y1 - py * r]];
      C.arc0 = { c: P.p1, r }; C.arc1 = { c: P.p2, r };
      break;
    }
    case 'polyline': {
      const n = e.pts.length;
      e.pts.forEach((p, i) => { P[`v${i}`] = p; });
      for (let i = 0; i < (e.closed ? n : n - 1); i++) L[`s${i}`] = [e.pts[i], e.pts[(i + 1) % n]];
      break;
    }
    default: break;
  }
  return { P, L, C };
}

/** ref ("entId:part" | origin | xaxis | yaxis) → element */
export function elementTable(ents) {
  const T = new Map();
  T.set('origin', { kind: 'point', p: [0, 0], ent: null, part: 'origin' });
  T.set('xaxis', { kind: 'line', a: [0, 0], b: [1, 0], ent: null, part: 'xaxis', infinite: true });
  T.set('yaxis', { kind: 'line', a: [0, 0], b: [0, 1], ent: null, part: 'yaxis', infinite: true });
  for (const e of ents) {
    if (!e || e.error) continue;
    const { P, L, C } = elementsOf(e);
    for (const k in P) T.set(`${e.id}:${k}`, { kind: 'point', p: P[k], ent: e.id, part: k });
    for (const k in L) T.set(`${e.id}:${k}`, { kind: 'line', a: L[k][0], b: L[k][1], ent: e.id, part: k });
    for (const k in C) T.set(`${e.id}:${k}`, { kind: 'circle', c: C[k].c, r: C[k].r, ent: e.id, part: k });
  }
  return T;
}

/** Point-like position of any element (for circles: the center). */
const centerOf = (el) => (el.kind === 'point' ? el.p : el.kind === 'circle' ? el.c : null);

// ------------------------------------------------------------------ constraint types
// check(kinds) → 'ok' | 'more' | false ; res(els, c) → residual array (in mm-ish units)
const kindsAre = (k, ...want) => k.length === want.length && want.every((w, i) => w === '*' || (Array.isArray(w) ? w.includes(k[i]) : k[i] === w));
const progressive = (k, ...patterns) => {
  for (const p of patterns) {
    if (k.length > p.length) continue;
    if (k.every((x, i) => (Array.isArray(p[i]) ? p[i].includes(x) : p[i] === x))) return k.length === p.length ? 'ok' : 'more';
  }
  return false;
};

export const CONSTRAINTS = {
  coincident: {
    label: 'Coincident', icon: 'cCoincident', desc: 'Put a point on another point, line or circle', glyph: false,
    check: (k) => progressive(k, ['point', ['point', 'line', 'circle']], [['line', 'circle'], 'point']),
    normalize: (refs, k) => (k[0] === 'point' ? refs : [refs[1], refs[0]]),
    res: ([p, x]) => {
      if (x.kind === 'point') return [p.p[0] - x.p[0], p.p[1] - x.p[1]];
      if (x.kind === 'line') return [signedDist(p.p, x.a, x.b)];
      return [len(sub(p.p, x.c)) - x.r];
    },
  },
  horizontal: {
    label: 'Horizontal', icon: 'cHorizontal', desc: 'Make a line (or two points) horizontal', glyph: 'H',
    check: (k) => progressive(k, ['line'], ['point', 'point']),
    res: (els) => (els.length === 1 ? [els[0].b[1] - els[0].a[1]] : [els[1].p[1] - els[0].p[1]]),
  },
  vertical: {
    label: 'Vertical', icon: 'cVertical', desc: 'Make a line (or two points) vertical', glyph: 'V',
    check: (k) => progressive(k, ['line'], ['point', 'point']),
    res: (els) => (els.length === 1 ? [els[0].b[0] - els[0].a[0]] : [els[1].p[0] - els[0].p[0]]),
  },
  parallel: {
    label: 'Parallel', icon: 'cParallel', desc: 'Make two lines parallel', glyph: '∥',
    check: (k) => progressive(k, ['line', 'line']),
    res: ([l1, l2]) => { const d1 = sub(l1.b, l1.a), d2 = sub(l2.b, l2.a); return [cross(unit(d1), unit(d2)) * 0.5 * (len(d1) + len(d2))]; },
  },
  perpendicular: {
    label: 'Perpendicular', icon: 'cPerpendicular', desc: 'Make two lines meet at 90°', glyph: '⊥',
    check: (k) => progressive(k, ['line', 'line']),
    res: ([l1, l2]) => { const d1 = sub(l1.b, l1.a), d2 = sub(l2.b, l2.a); return [dot(unit(d1), unit(d2)) * 0.5 * (len(d1) + len(d2))]; },
  },
  collinear: {
    label: 'Collinear', icon: 'cCollinear', desc: 'Put two lines on the same infinite line', glyph: '⋯',
    check: (k) => progressive(k, ['line', 'line']),
    res: ([l1, l2]) => [signedDist(l2.a, l1.a, l1.b), signedDist(l2.b, l1.a, l1.b)],
  },
  tangent: {
    label: 'Tangent', icon: 'cTangent', desc: 'Make a line touch a circle, or two circles touch', glyph: 'T',
    check: (k) => progressive(k, ['line', 'circle'], ['circle', ['line', 'circle']]),
    normalize: (refs, k) => (k[0] === 'circle' && k[1] === 'line' ? [refs[1], refs[0]] : refs),
    init: (els) => {
      if (els[0].kind === 'circle' && els[1].kind === 'circle') {
        const d = len(sub(els[0].c, els[1].c));
        return { mode: Math.abs(d - Math.abs(els[0].r - els[1].r)) < Math.abs(d - (els[0].r + els[1].r)) ? 'int' : 'ext' };
      }
      return {};
    },
    res: ([a, b], c) => {
      if (a.kind === 'line') return [Math.abs(signedDist(b.c, a.a, a.b)) - b.r];
      const d = len(sub(a.c, b.c));
      return [c.mode === 'int' ? d - Math.abs(a.r - b.r) : d - (a.r + b.r)];
    },
  },
  equal: {
    label: 'Equal', icon: 'cEqual', desc: 'Make two lines the same length, or two circles the same size', glyph: '=',
    check: (k) => progressive(k, ['line', 'line'], ['circle', 'circle']),
    res: ([a, b]) => (a.kind === 'line' ? [len(sub(a.b, a.a)) - len(sub(b.b, b.a))] : [a.r - b.r]),
  },
  concentric: {
    label: 'Concentric', icon: 'cConcentric', desc: 'Give two circles the same center', glyph: '◎',
    check: (k) => progressive(k, ['circle', 'circle']),
    res: ([a, b]) => [a.c[0] - b.c[0], a.c[1] - b.c[1]],
  },
  midpoint: {
    label: 'Midpoint', icon: 'cMidpoint', desc: 'Put a point at the middle of a line', glyph: 'M',
    check: (k) => progressive(k, ['point', 'line'], ['line', 'point']),
    normalize: (refs, k) => (k[0] === 'point' ? refs : [refs[1], refs[0]]),
    res: ([p, l]) => [p.p[0] - (l.a[0] + l.b[0]) / 2, p.p[1] - (l.a[1] + l.b[1]) / 2],
  },
  symmetric: {
    label: 'Symmetric', icon: 'cSymmetric', desc: 'Mirror two points about a line (pick point, point, then the line)', glyph: '⇋',
    check: (k) => progressive(k, ['point', 'point', 'line']),
    res: ([p, q, l]) => {
      const m = [(p.p[0] + q.p[0]) / 2, (p.p[1] + q.p[1]) / 2];
      return [signedDist(m, l.a, l.b), dot(sub(q.p, p.p), unit(sub(l.b, l.a)))];
    },
  },
  // ---- driving dimensions (value is an expression)
  length: {
    label: 'Length', dim: true, check: (k) => progressive(k, ['line']),
    measure: ([l]) => ({ value: len(sub(l.b, l.a)) }),
    res: ([l], c) => [len(sub(l.b, l.a)) - c._v],
  },
  distance: {
    label: 'Distance', dim: true, check: (k) => progressive(k, [['point', 'circle'], ['point', 'circle']]),
    measure: ([a, b]) => ({ value: len(sub(centerOf(b), centerOf(a))) }),
    res: ([a, b], c) => [len(sub(centerOf(b), centerOf(a))) - c._v],
  },
  hdistance: {
    label: 'Horizontal distance', dim: true, check: (k) => progressive(k, [['point', 'circle'], ['point', 'circle']]),
    measure: ([a, b]) => { const d = centerOf(b)[0] - centerOf(a)[0]; return { value: Math.abs(d), sgn: Math.sign(d) || 1 }; },
    res: ([a, b], c) => [(c.sgn || 1) * (centerOf(b)[0] - centerOf(a)[0]) - c._v],
  },
  vdistance: {
    label: 'Vertical distance', dim: true, check: (k) => progressive(k, [['point', 'circle'], ['point', 'circle']]),
    measure: ([a, b]) => { const d = centerOf(b)[1] - centerOf(a)[1]; return { value: Math.abs(d), sgn: Math.sign(d) || 1 }; },
    res: ([a, b], c) => [(c.sgn || 1) * (centerOf(b)[1] - centerOf(a)[1]) - c._v],
  },
  pldistance: {
    label: 'Point–line distance', dim: true, check: (k) => progressive(k, [['point', 'circle'], 'line']),
    measure: ([p, l]) => { const d = signedDist(centerOf(p), l.a, l.b); return { value: Math.abs(d), sgn: Math.sign(d) || 1 }; },
    res: ([p, l], c) => [(c.sgn || 1) * signedDist(centerOf(p), l.a, l.b) - c._v],
  },
  angle: {
    label: 'Angle', dim: true, check: (k) => progressive(k, ['line', 'line']),
    measure: ([l1, l2]) => { const a = dirAngle(sub(l1.b, l1.a), sub(l2.b, l2.a)); return { value: Math.abs(a) * 180 / Math.PI, sgn: Math.sign(a) || 1 }; },
    res: ([l1, l2], c) => {
      const a = dirAngle(sub(l1.b, l1.a), sub(l2.b, l2.a));
      const s = 0.5 * (len(sub(l1.b, l1.a)) + len(sub(l2.b, l2.a)));
      return [wrapPi((c.sgn || 1) * a - (c._v * Math.PI) / 180) * Math.max(s, 1)];
    },
  },
};

export const CONSTRAINT_TOOLS = ['coincident', 'hv', 'parallel', 'perpendicular', 'tangent', 'equal', 'concentric', 'midpoint', 'collinear', 'symmetric'];
export const HV = { label: 'Horizontal / Vertical', icon: 'cHV', desc: 'Make a line horizontal or vertical (whichever is closer)' };

// ------------------------------------------------------------------ variables
function fieldsOf(s) {
  if (s.type === 'polyline') return s.pts.flatMap((p, i) => [[`pts.${i}.0`, p[0]], [`pts.${i}.1`, p[1]]]);
  return (NUMERIC_FIELDS[s.type] || []).filter((k) => k !== 'n').map((k) => [k, s[k]]);
}

export function freeFields(s) {
  if (s.fixed) return [];
  const locked = new Set(s.locked || []);
  return fieldsOf(s).filter(([k, v]) => !locked.has(k) && isLiteral(v)).map(([k]) => k);
}

function buildVars(stored, evald) {
  const vars = [];
  const decoders = [];
  const push = (ei, key, value, stiff = 1) => { vars.push({ ei, key, value, stiff }); return vars.length - 1; };
  stored.forEach((s, ei) => {
    const e = evald[ei];
    if (e.error) { decoders.push(() => e); return; }
    const free = new Set(freeFields(s));
    if (s.type === 'rect') {
      // corners as variables so dragging one corner leaves the opposite corner in place
      const axis = (pk, sk) => {
        const fp = free.has(pk), fs = free.has(sk);
        if (fp && fs) { const i1 = push(ei, pk, e[pk]), i2 = push(ei, `${pk}2`, e[pk] + e[sk]); return (v, o) => { o[pk] = v[i1]; o[sk] = v[i2] - v[i1]; }; }
        if (fp) { const i1 = push(ei, pk, e[pk]); return (v, o) => { o[pk] = v[i1]; }; }
        if (fs) { const i2 = push(ei, sk, e[sk]); return (v, o) => { o[sk] = v[i2]; }; }
        return () => {};
      };
      const dx = axis('x', 'w'), dy = axis('y', 'h');
      decoders.push((v) => { const o = { ...e }; dx(v, o); dy(v, o); return o; });
    } else if (s.type === 'polyline') {
      const idx = [];
      e.pts.forEach((p, i) => [0, 1].forEach((j) => { if (free.has(`pts.${i}.${j}`)) idx.push([i, j, push(ei, `pts.${i}.${j}`, p[j])]); }));
      decoders.push((v) => { const o = { ...e, pts: e.pts.map((p) => p.slice()) }; for (const [i, j, k] of idx) o.pts[i][j] = v[k]; return o; });
    } else {
      const centerish = s.type === 'polygon' ? 8 : 1; // polygon: prefer resizing/rotating over moving
      const idx = [];
      for (const k of NUMERIC_FIELDS[s.type] || []) {
        if (k === 'n' || !free.has(k)) continue;
        idx.push([k, push(ei, k, e[k], k === 'cx' || k === 'cy' ? centerish : 1)]);
      }
      decoders.push((v) => { const o = { ...e }; for (const [k, i] of idx) o[k] = v[i]; return o; });
    }
  });
  return { vars, decode: (v) => decoders.map((d) => d(v)) };
}

// ------------------------------------------------------------------ numerics
function sumsq(r) { let s = 0; for (const x of r) s += x * x; return s; }
function maxAbs(r) { let s = 0; for (const x of r) s = Math.max(s, Math.abs(x)); return s; }

export function jacobian(F, x, m) {
  const n = x.length;
  const J = Array.from({ length: m }, () => new Float64Array(n));
  for (let j = 0; j < n; j++) {
    const h = 1e-6 * Math.max(1, Math.abs(x[j]));
    const xp = x.slice(), xm = x.slice();
    xp[j] += h; xm[j] -= h;
    const rp = F(xp), rm = F(xm);
    for (let i = 0; i < m; i++) J[i][j] = (rp[i] - rm[i]) / (2 * h);
  }
  return J;
}

/** Solve M y = b (M is m×m, symmetric positive definite after damping). */
function solveLinear(M, b) {
  const m = b.length;
  const A = M.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < m; c++) {
    let p = c;
    for (let r = c + 1; r < m; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    const piv = A[c][c];
    if (Math.abs(piv) < 1e-300) continue;
    for (let r = c + 1; r < m; r++) {
      const f = A[r][c] / piv;
      if (!f) continue;
      for (let k = c; k <= m; k++) A[r][k] -= f * A[c][k];
    }
  }
  const y = new Float64Array(m);
  for (let r = m - 1; r >= 0; r--) {
    let s = A[r][m];
    for (let k = r + 1; k < m; k++) s -= A[r][k] * y[k];
    y[r] = Math.abs(A[r][r]) < 1e-300 ? 0 : s / A[r][r];
  }
  return y;
}

/** Levenberg–Marquardt, minimum weighted-norm steps (stiff variables move less). */
export function lm(F, x0, stiff, { maxIter = 100, tol = 1e-10 } = {}) {
  let x = Float64Array.from(x0);
  let r = F(x);
  let cost = sumsq(r);
  const n = x.length, m = r.length;
  if (!n || !m) return { x, r };
  const Dinv = stiff.map((s) => 1 / s);
  let lambda = 1e-9;
  for (let it = 0; it < maxIter && maxAbs(r) > tol; it++) {
    const J = jacobian(F, x, m);
    const A = Array.from({ length: m }, () => new Float64Array(m));
    let trace = 0;
    for (let i = 0; i < m; i++) {
      for (let k = i; k < m; k++) {
        let s = 0;
        for (let j = 0; j < n; j++) s += J[i][j] * Dinv[j] * J[k][j];
        A[i][k] = s; A[k][i] = s;
      }
      trace += A[i][i];
    }
    const scaleL = trace / m + 1e-12;
    let improved = false;
    for (let tries = 0; tries < 14; tries++) {
      const M = A.map((row, i) => { const q = Float64Array.from(row); q[i] += lambda * scaleL; return q; });
      const y = solveLinear(M, r);
      const xn = Float64Array.from(x);
      for (let j = 0; j < n; j++) { let s = 0; for (let i = 0; i < m; i++) s += J[i][j] * y[i]; xn[j] -= Dinv[j] * s; }
      const rn = F(xn), cn = sumsq(rn);
      if (cn < cost) { x = xn; r = rn; cost = cn; lambda = Math.max(lambda / 10, 1e-15); improved = true; break; }
      lambda *= 10;
    }
    if (!improved) break;
  }
  return { x, r };
}

/** Which variables are pinned down by the constraints (reduced row echelon of J). */
export function determinedVars(J, n) {
  const m = J.length;
  if (!m) return { det: new Array(n).fill(false), rank: 0 };
  const A = J.map((row) => Array.from(row));
  let maxv = 0;
  for (const row of A) for (const v of row) maxv = Math.max(maxv, Math.abs(v));
  const eps = 1e-7 * Math.max(1, maxv);
  const pivots = [];
  let r = 0;
  for (let c = 0; c < n && r < m; c++) {
    let p = r;
    for (let i = r + 1; i < m; i++) if (Math.abs(A[i][c]) > Math.abs(A[p][c])) p = i;
    if (Math.abs(A[p][c]) < eps) continue;
    [A[r], A[p]] = [A[p], A[r]];
    const pv = A[r][c];
    for (let k = c; k < n; k++) A[r][k] /= pv;
    for (let i = 0; i < m; i++) {
      if (i === r) continue;
      const f = A[i][c];
      if (Math.abs(f) < 1e-300) continue;
      for (let k = c; k < n; k++) A[i][k] -= f * A[r][k];
    }
    pivots.push(c);
    r++;
  }
  const isPivot = new Set(pivots);
  const freeCols = [...Array(n).keys()].filter((c) => !isPivot.has(c));
  const det = new Array(n).fill(false);
  pivots.forEach((c, row) => { det[c] = freeCols.every((f) => Math.abs(A[row][f]) < 1e-6); });
  return { det, rank: pivots.length };
}

// ------------------------------------------------------------------ public API
/** Evaluate dimension values and drop constraints that point at missing geometry. */
function prepare(constraints, table, scope) {
  const active = [], invalid = [], failing = new Set();
  for (const c of constraints || []) {
    const def = CONSTRAINTS[c.type];
    const els = c.refs.map((r) => table.get(r));
    if (!def || els.some((x) => !x)) { invalid.push(c.id); continue; }
    let v;
    if (def.dim) {
      try { v = evaluate(c.value, scope); } catch { failing.add(c.id); continue; }
    }
    active.push({ ...c, _v: v });
  }
  return { active, invalid, failing };
}

function residualFn(active, decode, extra) {
  const ranges = [];
  const F = (v) => {
    const ents = decode(v);
    const T = elementTable(ents);
    const out = [];
    ranges.length = 0;
    for (const c of active) {
      const start = out.length;
      const els = c.refs.map((r) => T.get(r));
      if (!els.some((x) => !x)) out.push(...CONSTRAINTS[c.type].res(els, c));
      ranges.push([c.id, start, out.length]);
    }
    if (extra) extra(T, out);
    return out;
  };
  return { F, ranges };
}

/**
 * Solve a sketch. opts.drag = { ref, target:[x,y] } or { circleRef, target } pulls geometry toward the cursor;
 * opts.stiff(entityId) → stiffness multiplier (higher = moves less).
 * Returns { entities (stored, solved), numeric, ok, failing:Set, conflictEnts:Set, determined:Set, dof, invalid:[] }
 */
export function solveSketch(sketch, scope, opts = {}) {
  const stored = sketch.entities;
  const evald = stored.map((e) => evalEntity(e, scope));
  const { vars, decode } = buildVars(stored, evald);
  const table0 = elementTable(evald);
  const { active, invalid, failing } = prepare(sketch.constraints, table0, scope);
  const stiff = vars.map((v) => v.stiff * (opts.stiff ? opts.stiff(stored[v.ei].id) : 1));
  let x = Float64Array.from(vars.map((v) => v.value));

  if (opts.drag && vars.length) {
    const { ref, circleRef, target } = opts.drag;
    const { F: Fd } = residualFn(active, decode, (T, out) => {
      if (ref && T.get(ref)) { const p = T.get(ref).p; out.push(p[0] - target[0], p[1] - target[1]); }
      if (circleRef && T.get(circleRef)) { const c = T.get(circleRef); out.push(len(sub(target, c.c)) - c.r); }
    });
    x = lm(Fd, x, stiff, { maxIter: 40 }).x;
  }

  const { F, ranges } = residualFn(active, decode);
  let r = F(x);
  if (active.length && vars.length) ({ x, r } = lm(F, x, stiff));
  else r = F(x);
  for (const [id, a, b] of ranges) for (let i = a; i < b; i++) if (Math.abs(r[i]) > 1e-6) { failing.add(id); break; }

  const numeric = decode(x);
  // degrees of freedom: which variables are still free to move
  let det = new Array(vars.length).fill(false), rank = 0;
  if (vars.length && r.length) ({ det, rank } = determinedVars(jacobian(F, x, r.length), vars.length));
  const freeByEnt = new Map();
  vars.forEach((v, i) => { if (!det[i]) freeByEnt.set(stored[v.ei].id, true); });
  const determined = new Set(stored.filter((s) => !freeByEnt.has(s.id)).map((s) => s.id));
  const conflictEnts = new Set();
  for (const c of sketch.constraints || []) if (failing.has(c.id)) for (const ref of c.refs) { const t = table0.get(ref); if (t && t.ent) conflictEnts.add(t.ent); }

  // write solved values back into literal fields
  const entities = stored.map((s, i) => {
    const ff = freeFields(s);
    if (!ff.length || numeric[i].error) return s;
    const d = numeric[i];
    const o = { ...s };
    for (const k of ff) {
      if (k.startsWith('pts.')) {
        const [, pi, pj] = k.split('.');
        if (o.pts === s.pts) o.pts = s.pts.map((p) => p.slice());
        o.pts[+pi][+pj] = fmt(d.pts[+pi][+pj], 6);
      } else o[k] = fmt(d[k], 6);
    }
    return o;
  });
  return { entities, numeric, ok: failing.size === 0, failing, conflictEnts, determined, dof: vars.length - rank, invalid };
}

/** Value + orientation of a dimension measured on the current geometry. */
export function measureDimension(type, refs, ents) {
  const T = elementTable(ents);
  const els = refs.map((r) => T.get(r));
  if (els.some((x) => !x)) return null;
  return CONSTRAINTS[type].measure(els);
}
