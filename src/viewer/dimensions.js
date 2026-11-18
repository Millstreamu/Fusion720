// Sketch dimensions and constraint glyphs.
//
// A dimension is *driving* when its value is fixed — a locked field, an expression,
// or a dimension constraint. Driving dimensions are always shown. *Ghost*
// dimensions (current measured value, not fixed) appear on selected entities;
// typing a value into one makes it driving.
import { fmt } from '../model/expr.js';
import { slotFrame } from '../model/profiles.js';
import { CONSTRAINTS, isLiteral, footOn } from '../model/constraints.js';

const num = (v) => fmt(v, 4);

/** Typed text with the sign of the original value preserved (rectangles drawn right-to-left etc.). */
function withSign(text, negative) {
  if (isLiteral(text)) { const v = Math.abs(parseFloat(text)); return num(negative ? -v : v); }
  return negative ? `-(${text})` : text;
}

const labelOf = (value, src, prefix = '') => ({ text: `${prefix}${fmt(Math.abs(value), 2)}`, fx: src != null && !isLiteral(src), expr: src != null ? String(src) : '' });

/** Dimensions for the active sketch. Each returns actions for app.applySketchAction(). */
export function sketchDimensions(ctx, sketch, selected = new Set()) {
  const dims = [];
  const stored = new Map(sketch.entities.map((e) => [e.id, e]));
  const cons = sketch.constraints || [];
  const failing = ctx.status?.failing || new Set();
  const consOn = (type, ref) => cons.find((c) => c.type === type && c.refs.length === 1 && c.refs[0] === ref);
  const distBetween = (r1, r2) => cons.find((c) => c.type === 'distance' && ((c.refs[0] === r1 && c.refs[1] === r2) || (c.refs[0] === r2 && c.refs[1] === r1)));
  const covered = new Set(); // constraint ids already drawn as an entity dimension

  for (const e of ctx.ents) {
    const s = stored.get(e.id);
    if (!s || e.error) continue;
    const sel = selected.has(e.id);
    const locked = new Set(s.locked || []);
    const driving = (k) => s.fixed || locked.has(k) || !isLiteral(s[k]);
    const field = (k, d) => {
      const drive = driving(k);
      if (!drive && !sel) return;
      dims.push({
        entId: e.id, positive: true, side: 1, extra: 0, ...d, driving: drive,
        edit: d.edit || ((t) => ({ ent: e.id, patch: { [k]: t }, lock: [k] })),
        remove: drive && isLiteral(s[k]) && !s.fixed ? () => ({ ent: e.id, unlock: [k] }) : null,
      });
    };
    const derived = (id, d, existing, create) => {
      if (existing) {
        covered.add(existing.id);
        dims.push({ entId: e.id, positive: true, side: 1, extra: 0, ...d, id: `c:${existing.id}`, ...labelOf(d.value, existing.value), driving: true, bad: failing.has(existing.id),
          edit: (t) => ({ cons: existing.id, value: t }), remove: () => ({ delCons: existing.id }) });
      } else if (sel) {
        dims.push({ entId: e.id, positive: true, side: 1, extra: 0, ...d, id, ...labelOf(d.value, null), driving: false, edit: (t) => ({ add: { ...create, value: t } }) });
      }
    };
    switch (e.type) {
      case 'rect': {
        const x0 = Math.min(e.x, e.x + e.w), x1 = Math.max(e.x, e.x + e.w);
        const y0 = Math.min(e.y, e.y + e.h), y1 = Math.max(e.y, e.y + e.h);
        field('w', { id: `${e.id}:w`, kind: 'h', a: [x0, y1], b: [x1, y1], ...labelOf(e.w, s.w), edit: (t) => ({ ent: e.id, patch: { w: withSign(t, e.w < 0) }, lock: ['w'] }) });
        field('h', { id: `${e.id}:h`, kind: 'v', a: [x1, y0], b: [x1, y1], ...labelOf(e.h, s.h), edit: (t) => ({ ent: e.id, patch: { h: withSign(t, e.h < 0) }, lock: ['h'] }) });
        break;
      }
      case 'circle':
        field('d', { id: `${e.id}:d`, kind: 'dia', c: [e.cx, e.cy], r: e.d / 2, ...labelOf(e.d, s.d, '⌀') });
        break;
      case 'polygon':
        field('r', { id: `${e.id}:r`, kind: 'rad', c: [e.cx, e.cy], r: e.r, angle: e.rot || 0, ...labelOf(e.r, s.r, 'R') });
        break;
      case 'slot': {
        const { px, py, r } = slotFrame(e);
        const L = Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
        derived(`${e.id}:len`, { kind: 'aligned', a: [e.x1, e.y1], b: [e.x2, e.y2], extra: r, value: L },
          distBetween(`${e.id}:p1`, `${e.id}:p2`), { type: 'distance', refs: [`${e.id}:p1`, `${e.id}:p2`] });
        field('w', { id: `${e.id}:w`, kind: 'aligned', a: [e.x2 - px * r, e.y2 - py * r], b: [e.x2 + px * r, e.y2 + py * r], extra: r, ...labelOf(e.w, s.w) });
        break;
      }
      case 'line': {
        const L = Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
        derived(`${e.id}:len`, { kind: 'aligned', a: [e.x1, e.y1], b: [e.x2, e.y2], value: L }, consOn('length', `${e.id}:seg`), { type: 'length', refs: [`${e.id}:seg`] });
        break;
      }
      case 'polyline': {
        const n = e.pts.length;
        const segs = e.closed ? n : n - 1;
        if (segs > 24) break;
        for (let i = 0; i < segs; i++) {
          const A = e.pts[i], B = e.pts[(i + 1) % n];
          const L = Math.hypot(B[0] - A[0], B[1] - A[1]);
          if (L < 1e-9) continue;
          derived(`${e.id}:s${i}`, { kind: 'aligned', a: A, b: B, side: e.closed ? -1 : 1, value: L }, consOn('length', `${e.id}:s${i}`), { type: 'length', refs: [`${e.id}:s${i}`] });
        }
        break;
      }
      default: break;
    }

    // position from the sketch origin (selected entities, or when the position is driving)
    const ref = { rect: ['x', 'y'], circle: ['cx', 'cy'], polygon: ['cx', 'cy'], slot: ['x1', 'y1'], line: ['x1', 'y1'] }[e.type];
    if (ref) {
      const [kx, ky] = ref;
      const px = e[kx], py = e[ky];
      for (const [k, kind, val, side] of [[kx, 'h', px, py >= 0 ? -1 : 1], [ky, 'v', py, px >= 0 ? -1 : 1]]) {
        if (Math.abs(val) < 1e-9) continue;
        const drive = driving(k);
        if (!sel && !(drive && locked.has(k))) continue; // expression positions only show when selected (keeps the view calm)
        dims.push({
          id: `${e.id}:${k}`, entId: e.id, kind, a: [0, 0], b: [px, py], side, extra: 0, pos: true, positive: false, driving: drive,
          ...labelOf(val, s[k]),
          edit: (t) => ({ ent: e.id, patch: { [k]: withSign(t, val < 0) }, lock: [k] }),
          remove: drive && isLiteral(s[k]) && !s.fixed ? () => ({ ent: e.id, unlock: [k] }) : null,
        });
      }
    }
  }

  // dimension constraints between elements
  const T = ctx.table;
  for (const c of cons) {
    const def = CONSTRAINTS[c.type];
    if (!def || !def.dim || covered.has(c.id)) continue;
    const els = c.refs.map((r) => T.get(r));
    if (els.some((x) => !x)) continue;
    const m = def.measure(els);
    const base = { id: `c:${c.id}`, entId: els.find((x) => x.ent)?.ent, positive: c.type !== 'angle', side: 1, extra: 0, driving: true, bad: failing.has(c.id),
      ...labelOf(m.value, c.value, c.type === 'angle' ? '' : ''), edit: (t) => ({ cons: c.id, value: t }), remove: () => ({ delCons: c.id }) };
    const P = (el) => (el.kind === 'point' ? el.p : el.c);
    if (c.type === 'length') dims.push({ ...base, kind: 'aligned', a: els[0].a, b: els[0].b });
    else if (c.type === 'distance') dims.push({ ...base, kind: 'aligned', a: P(els[0]), b: P(els[1]) });
    else if (c.type === 'hdistance') dims.push({ ...base, kind: 'h', a: P(els[0]), b: P(els[1]) });
    else if (c.type === 'vdistance') dims.push({ ...base, kind: 'v', a: P(els[0]), b: P(els[1]) });
    else if (c.type === 'pldistance') { const p = P(els[0]); dims.push({ ...base, kind: 'aligned', a: footOn(p, els[1].a, els[1].b), b: p }); }
    else if (c.type === 'angle') dims.push({ ...base, kind: 'angle', l1: [els[0].a, els[0].b], l2: [els[1].a, els[1].b], sgn: c.sgn || 1, text: `${fmt(m.value, 2)}°` });
  }
  return dims;
}

/** Small constraint badges placed next to the geometry they act on. */
export function sketchGlyphs(ctx, sketch, selectedCons = new Set()) {
  const T = ctx.table;
  const failing = ctx.status?.failing || new Set();
  const out = [];
  for (const c of sketch.constraints || []) {
    const def = CONSTRAINTS[c.type];
    if (!def || def.dim || !def.glyph) continue;
    const refs = c.type === 'symmetric' ? [c.refs[2]] : c.refs;
    for (const r of refs) {
      const el = T.get(r);
      if (!el || !el.ent) continue;
      let anchor, dir;
      if (el.kind === 'line') {
        anchor = [(el.a[0] + el.b[0]) / 2, (el.a[1] + el.b[1]) / 2];
        const d = [el.b[0] - el.a[0], el.b[1] - el.a[1]], l = Math.hypot(d[0], d[1]) || 1;
        dir = [-d[1] / l, d[0] / l];
      } else if (el.kind === 'circle') {
        anchor = [el.c[0] + el.r * 0.7071, el.c[1] + el.r * 0.7071]; dir = [0.7071, 0.7071];
      } else { anchor = el.p; dir = [0.7071, 0.7071]; }
      out.push({ cid: c.id, anchor, dir, icon: def.icon, title: `${def.label} — click to select, right-click to delete`, selected: selectedCons.has(c.id), bad: failing.has(c.id) });
    }
  }
  return out;
}
