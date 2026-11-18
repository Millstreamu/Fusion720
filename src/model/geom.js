// Small vector helpers and sketch-plane frames (shared by UI and worker).
import { evaluate } from './expr.js';

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const dist = (a, b) => len(sub(a, b));

export const STD_PLANES = {
  XY: { label: 'XY plane (Top)', normal: [0, 0, 1], xDir: [1, 0, 0] },
  XZ: { label: 'XZ plane (Front)', normal: [0, -1, 0], xDir: [1, 0, 0] },
  YZ: { label: 'YZ plane (Right)', normal: [1, 0, 0], xDir: [0, 1, 0] },
};

/** Resolve a sketch plane reference into a frame { origin, xDir, yDir, normal }. */
export function planeFrame(ref, scope = {}) {
  if (!ref) return null;
  if (ref.type === 'std') {
    const P = STD_PLANES[ref.name];
    let off = 0;
    try { off = evaluate(ref.offset ?? 0, scope); } catch { off = 0; }
    return { origin: scale(P.normal, off), xDir: P.xDir, yDir: cross(P.normal, P.xDir), normal: P.normal };
  }
  const normal = norm(ref.normal);
  const xDir = norm(ref.xDir);
  return { origin: ref.origin, xDir, yDir: cross(normal, xDir), normal };
}

/** Build a plane on a planar face: origin = world origin projected, x axis = projected world axis. */
export function framesForFace(point, normal) {
  const n = norm(normal);
  const o = sub([0, 0, 0], scale(n, dot(sub([0, 0, 0], point), n)));
  const candidates = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  let best = null;
  for (const c of candidates) {
    const p = sub(c, scale(n, dot(c, n)));
    if (!best || len(p) > len(best) + 1e-6) best = p;
  }
  return { type: 'face', origin: o, normal: n, xDir: norm(best) };
}

export const toWorld = (f, x, y) => [
  f.origin[0] + f.xDir[0] * x + f.yDir[0] * y,
  f.origin[1] + f.xDir[1] * x + f.yDir[1] * y,
  f.origin[2] + f.xDir[2] * x + f.yDir[2] * y,
];

export const toLocal = (f, p) => { const d = sub(p, f.origin); return [dot(d, f.xDir), dot(d, f.yDir)]; };
