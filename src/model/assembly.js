// Assemblies: components (instances of library parts) placed by rigid poses and
// connected by joints. Joint frames come from picked geometry (a point + a Z axis).
// A least-squares solver moves the non-grounded components until every joint holds.
import { evaluate } from './expr.js';
import { lm, jacobian, determinedVars } from './constraints.js';
import { newDocId } from './library.js';

export const JOINT_TYPES = {
  rigid: { label: 'Rigid', icon: 'jRigid', desc: 'Locks the two parts together', dof: 0 },
  revolute: { label: 'Revolute', icon: 'jRevolute', desc: 'Hinge: spins around the joint axis', dof: 1 },
  slider: { label: 'Slider', icon: 'jSlider', desc: 'Slides along the joint axis', dof: 1 },
  cylindrical: { label: 'Cylindrical', icon: 'jCylindrical', desc: 'Spins and slides along the axis', dof: 2 },
  planar: { label: 'Planar', icon: 'jPlanar', desc: 'Slides on the face and spins about its normal', dof: 3 },
  ball: { label: 'Ball', icon: 'jBall', desc: 'Pivots freely about the point', dof: 3 },
};

export function newAssembly(name = 'Assembly') {
  return { format: 'fusion720', version: 1, kind: 'assembly', id: newDocId(), name, units: 'mm', params: [], features: [], marker: null, bodies: {}, components: [], joints: [], parts: {} };
}

// ------------------------------------------------------------------ vectors + quaternions ([x, y, z, w])
export const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
};
export const Q_ID = [0, 0, 0, 1];
export const qMul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
export const qNorm = (q) => { const l = Math.hypot(...q) || 1; return q.map((x) => x / l); };
export function qFromRotVec(w) {
  const a = Math.hypot(w[0], w[1], w[2]);
  if (a < 1e-12) return [w[0] / 2, w[1] / 2, w[2] / 2, 1];
  const s = Math.sin(a / 2) / a;
  return [w[0] * s, w[1] * s, w[2] * s, Math.cos(a / 2)];
}
export function qRotate(q, v) {
  const u = [q[0], q[1], q[2]], w = q[3];
  const t = v3.scale(v3.cross(u, v), 2);
  return v3.add(v3.add(v, v3.scale(t, w)), v3.cross(u, t));
}
const D2R = Math.PI / 180;
/** Euler angles in degrees, rotate about X, then Y, then Z (world axes). */
export function qFromEuler([rx, ry, rz]) {
  const h = (a) => [Math.sin((a * D2R) / 2), Math.cos((a * D2R) / 2)];
  const [sx, cx] = h(rx), [sy, cy] = h(ry), [sz, cz] = h(rz);
  return qMul([0, 0, sz, cz], qMul([0, sy, 0, cy], [sx, 0, 0, cx]));
}
export function qToEuler([x, y, z, w]) {
  const rx = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
  const sp = 2 * (w * y - z * x);
  const ry = Math.abs(sp) >= 1 ? Math.sign(sp) * Math.PI / 2 : Math.asin(sp);
  const rz = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  return [rx / D2R, ry / D2R, rz / D2R];
}
export function qToAxisAngle(q) {
  const [x, y, z, w] = qNorm(q);
  const ang = 2 * Math.acos(Math.max(-1, Math.min(1, w)));
  const s = Math.sqrt(Math.max(0, 1 - w * w));
  return s < 1e-9 ? { axis: [0, 0, 1], angle: 0 } : { axis: [x / s, y / s, z / s], angle: ang / D2R };
}

/** A deterministic X axis perpendicular to z. */
export function perpendicular(z) {
  const c = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].sort((a, b) => Math.abs(v3.dot(a, z)) - Math.abs(v3.dot(b, z)))[0];
  return v3.norm(v3.sub(c, v3.scale(z, v3.dot(c, z))));
}

export const toWorld = (pose, p) => v3.add(qRotate(pose.q, p), pose.t);

// ------------------------------------------------------------------ solver
/**
 * @param components [{ id, t, q, grounded }]
 * @param joints     [{ id, type, a:{comp}, b:{comp}, offset, angle, flip, suppressed }]
 * @param frames     Map jointId → { a:{o,z,x}, b:{o,z,x} } in component-local coordinates
 * @param opts       { scope, L, drag:{ comp, local, target }, stiffComp }
 * @returns { poses: {id:{t,q}}, failing:Set, ok, dof, determined:Set }
 */
export function solveAssembly(components, joints, frames, opts = {}) {
  const L = opts.L || 50;
  const scope = opts.scope || {};
  const free = components.filter((c) => !c.grounded);
  const index = new Map(free.map((c, i) => [c.id, i * 6]));
  const base = new Map(components.map((c) => [c.id, { t: c.t.slice(), q: qNorm(c.q) }]));
  const n = free.length * 6;
  const pose = (id, x) => {
    const b = base.get(id);
    const i = index.get(id);
    if (i === undefined) return b;
    return { t: [b.t[0] + x[i], b.t[1] + x[i + 1], b.t[2] + x[i + 2]], q: qMul(qFromRotVec([x[i + 3] / L, x[i + 4] / L, x[i + 5] / L]), b.q) };
  };
  const active = [];
  const failing = new Set();
  for (const j of joints) {
    if (j.suppressed) continue;
    const fr = frames.get(j.id);
    if (!fr || !base.has(j.a.comp) || !base.has(j.b.comp) || j.a.comp === j.b.comp) continue;
    let off = 0, ang = 0;
    try { off = evaluate(j.offset ?? 0, scope); ang = evaluate(j.angle ?? 0, scope) * D2R; } catch { failing.add(j.id); continue; }
    active.push({ j, fr, off, ang });
  }
  const ranges = [];
  const jointResiduals = (x, out) => {
    ranges.length = 0;
    for (const { j, fr, off, ang } of active) {
      const start = out.length;
      const PA = pose(j.a.comp, x), PB = pose(j.b.comp, x);
      const pa = toWorld(PA, fr.a.o), za = qRotate(PA.q, fr.a.z), xa = qRotate(PA.q, fr.a.x);
      const pb = toWorld(PB, fr.b.o), zb = qRotate(PB.q, fr.b.z), xb = qRotate(PB.q, fr.b.x);
      const sgn = j.flip ? 1 : -1; // default: the two Z axes face each other (surfaces mate)
      const d = v3.sub(pb, v3.add(pa, v3.scale(za, off)));
      const zr = v3.scale(v3.sub(zb, v3.scale(za, sgn)), L);
      const ya = v3.cross(za, xa);
      const xr = v3.scale(v3.sub(xb, v3.add(v3.scale(xa, Math.cos(ang)), v3.scale(ya, Math.sin(ang)))), L);
      const dPerp = v3.sub(d, v3.scale(za, v3.dot(d, za)));
      switch (j.type) {
        case 'rigid': out.push(...d, ...zr, ...xr); break;
        case 'revolute': out.push(...d, ...zr); break;
        case 'slider': out.push(...dPerp, ...zr, ...xr); break;
        case 'cylindrical': out.push(...dPerp, ...zr); break;
        case 'planar': out.push(v3.dot(d, za), ...zr); break;
        case 'ball': out.push(...d); break;
        default: break;
      }
      ranges.push([j.id, start, out.length]);
    }
    return out;
  };
  const stiff = [];
  for (const c of free) {
    const k = opts.stiffComp === c.id ? 60 : 1;
    stiff.push(k, k, k, 25 * k, 25 * k, 25 * k); // prefer sliding over spinning when both would work
  }
  let x = new Float64Array(n);
  if (n && opts.drag && index.has(opts.drag.comp)) {
    const { comp, local, target } = opts.drag;
    const Fd = (v) => { const out = jointResiduals(v, []); const p = toWorld(pose(comp, v), local); out.push(p[0] - target[0], p[1] - target[1], p[2] - target[2]); return out; };
    x = lm(Fd, x, stiff, { maxIter: 40 }).x;
  }
  const F = (v) => jointResiduals(v, []);
  let r = F(x);
  if (n && r.length) ({ x, r } = lm(F, x, stiff, { maxIter: 120, tol: 1e-9 }));
  for (const [id, a, b] of ranges) for (let i = a; i < b; i++) if (Math.abs(r[i]) > 1e-4) { failing.add(id); break; }
  let det = new Array(n).fill(false), rank = 0;
  if (n && r.length) ({ det, rank } = determinedVars(jacobian(F, x, r.length), n));
  const determined = new Set(components.filter((c) => c.grounded).map((c) => c.id));
  for (const c of free) { const i = index.get(c.id); if (det.slice(i, i + 6).every(Boolean)) determined.add(c.id); }
  const poses = {};
  for (const c of components) { const p = pose(c.id, x); poses[c.id] = { t: p.t, q: qNorm(p.q) }; }
  return { poses, failing, ok: failing.size === 0, dof: n - rank, determined };
}
