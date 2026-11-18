// Sketch entity evaluation, outlines and profile (region) detection.
// Shared by the UI thread and the geometry worker — no DOM or three.js here.
import { evaluate } from './expr.js';

export const NUMERIC_FIELDS = {
  line: ['x1', 'y1', 'x2', 'y2'],
  rect: ['x', 'y', 'w', 'h'],
  circle: ['cx', 'cy', 'd'],
  polygon: ['cx', 'cy', 'r', 'n', 'rot'],
  slot: ['x1', 'y1', 'x2', 'y2', 'w'],
  arc: ['cx', 'cy', 'r', 'a0', 'a1'],
  polyline: [],
};

export const FIELD_LABELS = {
  x1: 'Start X', y1: 'Start Y', x2: 'End X', y2: 'End Y', x: 'Corner X', y: 'Corner Y', w: 'Width', h: 'Height',
  cx: 'Center X', cy: 'Center Y', d: 'Diameter', r: 'Radius', n: 'Sides', rot: 'Rotation', a0: 'Start angle', a1: 'End angle',
};

export const ENTITY_NAMES = { line: 'Line', rect: 'Rectangle', circle: 'Circle', polygon: 'Polygon', slot: 'Slot', polyline: 'Polyline', arc: 'Arc' };

/** Evaluate an entity's expression fields into numbers. Returns { ...entity, error } */
export function evalEntity(ent, scope) {
  const out = { ...ent };
  try {
    for (const f of NUMERIC_FIELDS[ent.type] || []) out[f] = evaluate(ent[f], scope);
    if (ent.type === 'polyline') out.pts = ent.pts.map(([x, y]) => [evaluate(x, scope), evaluate(y, scope)]);
    if (ent.type === 'polygon') out.n = Math.max(3, Math.round(out.n));
    out.error = null;
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

export function isClosed(e) {
  if (e.error || e.construction) return false;
  if (e.type === 'rect') return Math.abs(e.w) > 1e-9 && Math.abs(e.h) > 1e-9;
  if (e.type === 'circle') return e.d > 1e-9;
  if (e.type === 'polygon') return e.r > 1e-9;
  if (e.type === 'slot') return e.w > 1e-9 && Math.hypot(e.x2 - e.x1, e.y2 - e.y1) > 1e-9;
  if (e.type === 'polyline') return e.closed && cleanPts(e.pts).length >= 3;
  return false;
}

export function cleanPts(pts) {
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-7) out.push(p);
  }
  if (out.length > 2) {
    const a = out[0], b = out[out.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-7) out.pop();
  }
  return out;
}

export function polygonVerts(e) {
  const pts = [];
  for (let i = 0; i < e.n; i++) {
    const a = ((e.rot || 0) + (360 * i) / e.n) * Math.PI / 180;
    pts.push([e.cx + e.r * Math.cos(a), e.cy + e.r * Math.sin(a)]);
  }
  return pts;
}

export function slotFrame(e) {
  const dx = e.x2 - e.x1, dy = e.y2 - e.y1;
  const L = Math.hypot(dx, dy) || 1;
  const ux = dx / L, uy = dy / L;
  return { ux, uy, px: -uy, py: ux, r: e.w / 2, L };
}

function arcPts(cx, cy, r, a0, a1, segs) {
  const pts = [];
  for (let i = 0; i <= segs; i++) {
    const a = a0 + ((a1 - a0) * i) / segs;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/** Discretised outline of an evaluated entity. Closed outlines do not repeat the first point. */
export function outline(e) {
  switch (e.type) {
    case 'line': return [[e.x1, e.y1], [e.x2, e.y2]];
    case 'rect': return [[e.x, e.y], [e.x + e.w, e.y], [e.x + e.w, e.y + e.h], [e.x, e.y + e.h]];
    case 'circle': return arcPts(e.cx, e.cy, e.d / 2, 0, Math.PI * 2, 72).slice(0, -1);
    case 'polygon': return polygonVerts(e);
    case 'polyline': return e.pts.slice();
    case 'arc': return arcPts(e.cx, e.cy, e.r, e.a0 * Math.PI / 180, e.a1 * Math.PI / 180, 48);
    case 'slot': {
      const { px, py, r } = slotFrame(e);
      const a = Math.atan2(py, px);
      const end = arcPts(e.x2, e.y2, r, a, a - Math.PI, 24);
      const start = arcPts(e.x1, e.y1, r, a + Math.PI, a, 24);
      return [...end, ...start];
    }
    default: return [];
  }
}

export function isOpenOutline(e) {
  return e.type === 'line' || e.type === 'arc' || (e.type === 'polyline' && !e.closed);
}

/** Points that the sketcher can snap to. */
export function snapPoints(e) {
  const P = [];
  const add = (x, y, kind) => P.push({ p: [x, y], kind });
  switch (e.type) {
    case 'line': add(e.x1, e.y1, 'end'); add(e.x2, e.y2, 'end'); add((e.x1 + e.x2) / 2, (e.y1 + e.y2) / 2, 'mid'); break;
    case 'rect': for (const p of outline(e)) add(p[0], p[1], 'end'); add(e.x + e.w / 2, e.y + e.h / 2, 'center'); break;
    case 'circle': add(e.cx, e.cy, 'center'); for (const a of [0, 90, 180, 270]) add(e.cx + (e.d / 2) * Math.cos(a * Math.PI / 180), e.cy + (e.d / 2) * Math.sin(a * Math.PI / 180), 'quad'); break;
    case 'polygon': add(e.cx, e.cy, 'center'); for (const p of polygonVerts(e)) add(p[0], p[1], 'end'); break;
    case 'slot': add(e.x1, e.y1, 'center'); add(e.x2, e.y2, 'center'); break;
    case 'polyline': e.pts.forEach((p) => add(p[0], p[1], 'end')); break;
    case 'arc': add(e.cx, e.cy, 'center'); break;
  }
  return P;
}

export function polyArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  return a / 2;
}

export function pointInPoly(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Detect profiles. Each closed entity defines a region = its outline minus the
 * outlines of closed entities directly nested inside it.
 */
export function computeRegions(evaluated) {
  const closed = evaluated.filter(isClosed).map((e) => {
    const pts = outline(e);
    return { id: e.id, ent: e, pts, area: Math.abs(polyArea(pts)), parent: null, children: [] };
  });
  for (const b of closed) {
    let best = null;
    for (const a of closed) {
      if (a === b || a.area <= b.area) continue;
      let inside = 0;
      for (const p of b.pts) if (pointInPoly(p, a.pts)) inside++;
      if (inside / b.pts.length > 0.5 && (!best || a.area < best.area)) best = a;
    }
    if (best) { b.parent = best.id; best.children.push(b.id); }
  }
  const byId = new Map(closed.map((r) => [r.id, r]));
  return closed.map((r) => ({
    id: r.id,
    outer: r.pts,
    holes: r.children.map((c) => byId.get(c).pts),
    children: r.children,
    area: r.area - r.children.reduce((s, c) => s + byId.get(c).area, 0),
    ent: r.ent,
  }));
}

export function regionAt(regions, p) {
  let best = null;
  for (const r of regions) {
    if (!pointInPoly(p, r.outer)) continue;
    if (r.holes.some((h) => pointInPoly(p, h))) continue;
    if (!best || r.area < best.area) best = r;
  }
  return best;
}
