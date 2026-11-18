// Interactive 2D sketching on a plane: drawing tools, snapping + inference with
// automatic constraints, type-to-dimension input, constraint and dimension tools,
// and solver-driven dragging.
import { evaluate, fmt } from '../model/expr.js';
import { outline, isOpenOutline, slotFrame } from '../model/profiles.js';
import { toWorld } from '../model/geom.js';
import { newId } from '../model/features.js';
import { CONSTRAINTS, HV, isLiteral, dirAngle } from '../model/constraints.js';
import { toast } from '../ui/dom.js';

const NICE = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
const SNAP_COLORS = { end: '#ff7a1a', mid: '#ff7a1a', center: '#3fb950', quad: '#3fb950', origin: '#e5534b', first: '#ff7a1a', grid: '#4f8cff' };
const PICK = '#ffb020', PICK_HOVER = '#ffd27a', CONS_HL = '#22d3ee';
const num = (v) => fmt(v, 4);

export const SKETCH_TOOLS = {
  select: { label: 'Select', icon: 'cursor', key: 'Esc', desc: 'Select and drag. Drag points to reshape, a circle’s edge to resize — constraints are kept.' },
  line: { label: 'Line', icon: 'line', key: 'L', desc: 'Click points to draw connected lines. Click the first point to close the shape.' },
  rect: { label: 'Rectangle', icon: 'rect', key: 'R', desc: 'Two-corner rectangle' },
  centerRect: { label: 'Center rect', icon: 'centerRect', key: 'Shift+R', desc: 'Rectangle drawn from its center' },
  circle: { label: 'Circle', icon: 'circle', key: 'C', desc: 'Center + diameter circle' },
  polygon: { label: 'Polygon', icon: 'polygon', key: 'P', desc: 'Regular polygon (type a side count with Tab)' },
  slot: { label: 'Slot', icon: 'slot', key: 'O', desc: 'Center-to-center slot: two centers, then the width' },
  dimension: { label: 'Dimension', icon: 'dimension', key: 'D', desc: 'Click a line or circle, or two items (points, lines, circles) to add a driving dimension. Click empty space after one line for its length.' },
};

const KIND_WORDS = { point: 'a point', line: 'a line', circle: 'a circle' };

export class Sketcher {
  constructor(app, viewport, hudEl) {
    this.app = app;
    this.vp = viewport;
    this.hudEl = hudEl;
    this.tool = 'select';
    this.ctype = null;
    this.construction = false;
    this.snapGrid = true;
    this.showDims = true;
    this.selected = new Set();
    this.selectedCons = new Set();
    this.hoverEnt = null;
    this.hoverEl = null;
    this.hoverCons = null;
    this.picks = [];
    this.reset();
  }

  get active() { return this.app.mode === 'sketch'; }
  get ctx() { return this.app.activeSketchContext(); }
  get picking() { return this.tool === 'constraint' || this.tool === 'dimension'; }

  reset() {
    this.pts = [];
    this.meta = [];
    this.cursor = null;
    this.snapInfo = null;
    this.guides = [];
    this.fields = [];
    this.activeField = 0;
    this.drag = null;
    this.picks = [];
    this.hoverEl = null;
    this._renderHud();
    this.vp.setPreview(null);
  }

  setTool(tool, ctype = null) {
    this.tool = tool;
    this.ctype = ctype;
    this.reset();
    if (tool !== 'select' && tool !== 'constraint') this.selected.clear();
    if (tool === 'constraint') this._applyToSelection();
    this.app.emit('sketchTool');
    this.app.refreshSketches();
  }

  /** Constraint tool chosen with lines/circles already selected → apply straight away. */
  _applyToSelection() {
    if (!this.selected.size) return;
    const ents = this.ctx.ents.filter((e) => this.selected.has(e.id));
    const refs = ents.map((e) => (e.type === 'line' ? `${e.id}:seg` : e.type === 'circle' ? `${e.id}:circ` : null));
    this.selected.clear();
    if (refs.some((r) => !r)) return;
    this.picks = refs;
    this._tryConstraint();
  }

  // ------------------------------------------------------------ helpers
  snapStep() {
    const target = this.vp.pixelSize() * 9;
    return NICE.find((n) => n >= target) || 5000;
  }

  screenOf(p) { return this.vp.toScreen(toWorld(this.ctx.frame, p[0], p[1])); }
  local(e) { return this.vp.rayToPlane(e.clientX, e.clientY, this.ctx.frame); }

  _snap(raw, e) {
    const T = this.ctx.table;
    const cands = [];
    for (const [ref, el] of T) {
      if (el.kind === 'point') cands.push({ p: el.p, kind: ref === 'origin' ? 'origin' : el.part === 'c' ? 'center' : 'end', ref });
      else if (el.kind === 'line' && !el.infinite) cands.push({ p: [(el.a[0] + el.b[0]) / 2, (el.a[1] + el.b[1]) / 2], kind: 'mid', lineRef: ref });
      else if (el.kind === 'circle') for (const a of [0, 0.5, 1, 1.5]) cands.push({ p: [el.c[0] + el.r * Math.cos(a * Math.PI), el.c[1] + el.r * Math.sin(a * Math.PI)], kind: 'quad', curveRef: ref });
    }
    if (this.tool === 'line' && this.pts.length >= 3) cands.push({ p: this.pts[0], kind: 'first' });
    let best = null, bd = 11;
    for (const c of cands) {
      const s = this.screenOf(c.p);
      const d = Math.hypot(s[0] - e.clientX, s[1] - e.clientY) - (c.kind === 'first' ? 3 : 0); // closing the chain wins ties
      if (d < bd) { bd = d; best = c; }
    }
    this.guides = [];
    this._hv = null;
    if (best) return { ...best, p: best.p.slice() };
    let p = raw.slice();
    let kind = null;
    if (this.snapGrid) { const st = this.snapStep(); p = [Math.round(p[0] / st) * st, Math.round(p[1] / st) * st]; kind = 'grid'; }
    const last = this.pts[this.pts.length - 1];
    const px = this.vp.pixelSize();
    if (last && (this.tool === 'line' || (this.tool === 'slot' && this.pts.length === 1))) {
      if (Math.abs(raw[1] - last[1]) < px * 8) { p[1] = last[1]; this._hv = 'h'; this.guides.push([[last[0], last[1]], [p[0], p[1]]]); }
      else if (Math.abs(raw[0] - last[0]) < px * 8) { p[0] = last[0]; this._hv = 'v'; this.guides.push([[last[0], last[1]], [p[0], p[1]]]); }
    }
    return { p, kind };
  }

  /** Nearest sketch element of the wanted kinds under the cursor. */
  _elementAt(e, kinds = ['point', 'line', 'circle'], { entitiesOnly = false } = {}) {
    const raw = this.local(e);
    if (!raw) return null;
    const tol = 9 * this.vp.pixelSize();
    const T = this.ctx.table;
    let best = null, bd = tol;
    if (kinds.includes('point')) {
      for (const [ref, el] of T) {
        if (el.kind !== 'point' || (entitiesOnly && !el.ent)) continue;
        const d = Math.hypot(raw[0] - el.p[0], raw[1] - el.p[1]);
        if (d < bd) { bd = d; best = ref; }
      }
      if (best) return best;
    }
    for (const [ref, el] of T) {
      if (entitiesOnly && !el.ent) continue;
      let d = Infinity;
      if (el.kind === 'line' && kinds.includes('line')) {
        const dx = el.b[0] - el.a[0], dy = el.b[1] - el.a[1], L2 = dx * dx + dy * dy || 1e-12;
        let t = ((raw[0] - el.a[0]) * dx + (raw[1] - el.a[1]) * dy) / L2;
        if (!el.infinite) t = Math.max(0, Math.min(1, t));
        d = Math.hypot(raw[0] - el.a[0] - t * dx, raw[1] - el.a[1] - t * dy) + (el.infinite ? tol * 0.5 : 0);
      } else if (el.kind === 'circle' && kinds.includes('circle')) {
        d = Math.abs(Math.hypot(raw[0] - el.c[0], raw[1] - el.c[1]) - el.r);
      }
      if (d < bd) { bd = d; best = ref; }
    }
    return best;
  }

  _evalField(text) {
    try { return evaluate(text, this.app.scope); } catch { return NaN; }
  }

  /** Field definitions for the current tool + stage; values are live (from cursor) unless locked. */
  _defineFields() {
    const prev = new Map(this.fields.map((f) => [f.key, f]));
    const mk = (key, label, live, unit = 'mm') => {
      const p = prev.get(key);
      const locked = p && p.locked;
      return { key, label, unit, live, locked, text: locked ? p.text : '', value: locked ? this._evalField(p.text) : live };
    };
    const c = this.cursor || [0, 0];
    const a = this.pts[0], b = this.pts[1];
    const T = this.tool, n = this.pts.length;
    if (n === 0) return [mk('x', 'X', c[0]), mk('y', 'Y', c[1])];
    const last = this.pts[n - 1];
    if (T === 'line') {
      const L = Math.hypot(c[0] - last[0], c[1] - last[1]);
      const A = (Math.atan2(c[1] - last[1], c[0] - last[0]) * 180) / Math.PI;
      return [mk('len', 'L', L), mk('ang', '∠', A, '°')];
    }
    if (T === 'rect') return [mk('w', 'W', Math.abs(c[0] - a[0])), mk('h', 'H', Math.abs(c[1] - a[1]))];
    if (T === 'centerRect') return [mk('w', 'W', 2 * Math.abs(c[0] - a[0])), mk('h', 'H', 2 * Math.abs(c[1] - a[1]))];
    if (T === 'circle') return [mk('d', '⌀', 2 * Math.hypot(c[0] - a[0], c[1] - a[1]))];
    if (T === 'polygon') {
      const p = prev.get('n');
      return [mk('r', 'R', Math.hypot(c[0] - a[0], c[1] - a[1])), { key: 'n', label: 'Sides', unit: '', live: 6, locked: true, text: p ? p.text : '6', value: p ? this._evalField(p.text) : 6 }];
    }
    if (T === 'slot') {
      if (n === 1) {
        const L = Math.hypot(c[0] - a[0], c[1] - a[1]);
        return [mk('len', 'L', L), mk('ang', '∠', (Math.atan2(c[1] - a[1], c[0] - a[0]) * 180) / Math.PI, '°')];
      }
      const { px, py } = slotFrame({ x1: a[0], y1: a[1], x2: b[0], y2: b[1] });
      const w = 2 * Math.abs((c[0] - a[0]) * px + (c[1] - a[1]) * py);
      return [mk('w', 'W', w)];
    }
    return [];
  }

  /** Cursor point after applying locked HUD values. */
  _constrained() {
    const f = Object.fromEntries(this.fields.map((x) => [x.key, x]));
    let c = (this.cursor || [0, 0]).slice();
    const n = this.pts.length, a = this.pts[0], last = this.pts[n - 1];
    const ok = (k) => f[k] && f[k].locked && Number.isFinite(f[k].value);
    if (n === 0) { if (ok('x')) c[0] = f.x.value; if (ok('y')) c[1] = f.y.value; return c; }
    if (this.tool === 'line' || (this.tool === 'slot' && n === 1)) {
      const base = this.tool === 'line' ? last : a;
      let L = Math.hypot(c[0] - base[0], c[1] - base[1]);
      let A = Math.atan2(c[1] - base[1], c[0] - base[0]);
      if (ok('len')) L = f.len.value;
      if (ok('ang')) A = (f.ang.value * Math.PI) / 180;
      return [base[0] + L * Math.cos(A), base[1] + L * Math.sin(A)];
    }
    if (this.tool === 'rect' || this.tool === 'centerRect') {
      const k = this.tool === 'rect' ? 1 : 0.5;
      const sx = Math.sign(c[0] - a[0]) || 1, sy = Math.sign(c[1] - a[1]) || 1;
      if (ok('w')) c[0] = a[0] + sx * f.w.value * k;
      if (ok('h')) c[1] = a[1] + sy * f.h.value * k;
      return c;
    }
    if (this.tool === 'circle' || this.tool === 'polygon') {
      const key = this.tool === 'circle' ? 'd' : 'r';
      if (ok(key)) {
        const r = this.tool === 'circle' ? f.d.value / 2 : f.r.value;
        const ang = Math.atan2(c[1] - a[1], c[0] - a[0]);
        c = [a[0] + r * Math.cos(ang), a[1] + r * Math.sin(ang)];
      }
      return c;
    }
    return c;
  }

  // ------------------------------------------------------------ interceptor (viewport events)
  wantsLeft() { return this.active && (this.tool !== 'select' || !!this.hoverEnt || !!this._hoverPoint); }

  pointermove(e) {
    if (!this.active) return false;
    if (this.drag) { this._dragMove(e); return true; }
    if (this.tool === 'select') {
      const pt = this._elementAt(e, ['point'], { entitiesOnly: true });
      const id = pt ? this.ctx.table.get(pt).ent : this._entityAt(e);
      this._hoverPoint = pt;
      if (id !== this.hoverEnt) { this.hoverEnt = id; this.app.refreshSketches(); }
      this.vp.renderer.domElement.style.cursor = pt ? 'move' : id ? 'pointer' : '';
      return true;
    }
    if (this.picking) {
      const kinds = this.tool === 'dimension' ? ['point', 'line', 'circle'] : this._wantedKinds();
      const ref = this._elementAt(e, kinds);
      if (ref !== this.hoverEl) { this.hoverEl = ref; this._renderPicks(); }
      this.vp.renderer.domElement.style.cursor = ref ? 'pointer' : 'crosshair';
      return true;
    }
    const raw = this.local(e);
    if (!raw) return true;
    this.snapInfo = this._snap(raw, e);
    this.cursor = this.snapInfo.p;
    this.fields = this._defineFields();
    this.activeField = Math.min(this.activeField, Math.max(0, this.fields.length - 1));
    this._lastClient = [e.clientX, e.clientY];
    this._renderPreview();
    this._renderHud();
    this.vp.renderer.domElement.style.cursor = 'crosshair';
    return true;
  }

  pointerdown(e) {
    if (!this.active || e.button !== 0) return false;
    if (this.tool === 'select') {
      const pt = this._elementAt(e, ['point'], { entitiesOnly: true });
      const T = this.ctx.table;
      const id = pt ? T.get(pt).ent : this._entityAt(e);
      if (!id) return false;
      if (!this.selected.has(id) && !e.shiftKey && !e.ctrlKey) this.selected = new Set([id]);
      else if (!this.selected.has(id)) this.selected.add(id);
      this.selectedCons.clear();
      const raw = this.local(e);
      const ent = this.ctx.ents.find((x) => x.id === id);
      let mode = 'entity';
      if (pt) mode = 'point';
      else if (ent && ent.type === 'circle' && raw && Math.abs(Math.hypot(raw[0] - ent.cx, raw[1] - ent.cy) - ent.d / 2) < 9 * this.vp.pixelSize()) mode = 'circle';
      this.drag = { mode, ref: pt, ent: id, start: raw, ids: mode === 'entity' ? [...this.selected] : [id], moved: false, shift: e.shiftKey || e.ctrlKey, clicked: id };
      this.app.refreshSketches();
      this.app.emit('sketchSelection');
      return true;
    }
    return true;
  }

  pointerup(e, click) {
    if (!this.active) return false;
    if (this.drag) { this._dragEnd(e); return true; }
    if (this.tool === 'select') {
      if (click && e.button === 0 && !this._entityAt(e)) {
        if (this.selected.size || this.selectedCons.size) { this.selected.clear(); this.selectedCons.clear(); this.app.refreshSketches(); this.app.emit('sketchSelection'); }
        return true;
      }
      return false;
    }
    if (click && e.button === 0) {
      if (this.picking) this._pickClick(e); else this._place();
      return true;
    }
    return false;
  }

  pointerleave() {
    if (!this.active) return false;
    if (!this.picking) this.vp.setPreview(this.ctx.frame, []);
    this.hudEl.classList.add('hidden');
    return true;
  }

  dblclick() { if (this.active && this.tool === 'line') this._finishChain(); }

  // ------------------------------------------------------------ keyboard (called by the app)
  keydown(e) {
    if (!this.active) return false;
    const k = e.key;
    const drawing = this.tool !== 'select' && !this.picking && this.cursor;
    if (drawing && this.fields.length && (/^[0-9.]$/.test(k) || (k === '-' && !this.fields[this.activeField].text) || (/^[a-zA-Z_*/+()^ ]$/.test(k) && this.fields[this.activeField].locked))) {
      const f = this.fields[this.activeField];
      f.text = (f.locked ? f.text : '') + k;
      f.locked = true;
      f.value = this._evalField(f.text);
      this._renderPreview(); this._renderHud();
      return true;
    }
    if (drawing && k === 'Backspace' && this.fields.length) {
      const f = this.fields[this.activeField];
      if (f.locked) { f.text = f.text.slice(0, -1); if (!f.text) f.locked = false; f.value = f.locked ? this._evalField(f.text) : f.live; this._renderPreview(); this._renderHud(); }
      return true;
    }
    if (drawing && k === 'Tab' && this.fields.length) {
      this.activeField = (this.activeField + (e.shiftKey ? this.fields.length - 1 : 1)) % this.fields.length;
      this._renderHud();
      return true;
    }
    if (k === 'Enter' && this.tool === 'dimension' && this.picks.length === 1) { this._createDimension(this.picks); return true; }
    if (k === 'Enter' && this.tool !== 'select' && !this.picking) {
      if (this.fields.some((f) => f.locked && f.key !== 'n') || (this.tool === 'polygon' && this.pts.length)) this._place();
      else if (this.tool === 'line') this._finishChain();
      return true;
    }
    if (k === 'Escape') {
      if (this.picking && this.picks.length) { this.picks = []; this._renderPicks(); this.app.emit('sketchTool'); return true; }
      if (this.tool === 'line' && this.pts.length >= 2) { this._finishChain(); return true; }
      if (this.pts.length) { this.reset(); return true; }
      if (this.tool !== 'select') { this.setTool('select'); return true; }
      if (this.selected.size || this.selectedCons.size) { this.selected.clear(); this.selectedCons.clear(); this.app.refreshSketches(); this.app.emit('sketchSelection'); return true; }
      return false;
    }
    if ((k === 'Delete' || k === 'Backspace') && (this.selected.size || this.selectedCons.size)) { this.deleteSelected(); return true; }
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const map = { l: 'line', r: 'rect', R: 'centerRect', c: 'circle', p: 'polygon', o: 'slot', d: 'dimension' };
    if (map[k]) { this.setTool(map[k]); return true; }
    if (k === 'h') { this.setTool('constraint', 'hv'); return true; }
    if (k === 't') { this.setTool('constraint', 'tangent'); return true; }
    if (k === 'x' || k === 'X') { this.toggleConstruction(); return true; }
    return false;
  }

  toggleDims() {
    this.showDims = !this.showDims;
    this.app.refreshSketches();
    this.app.emit('sketchTool');
  }

  // ------------------------------------------------------------ actions
  toggleConstruction() {
    if (this.selected.size) {
      const ids = [...this.selected];
      const allCons = this.ctx.ents.filter((e) => ids.includes(e.id)).every((e) => e.construction);
      this.app.updateSketchEntities(ids, (e) => ({ ...e, construction: !allCons }), 'Toggle construction');
    } else {
      this.construction = !this.construction;
      this.app.emit('sketchTool');
    }
  }

  toggleFix() {
    if (!this.selected.size) { toast('Select sketch entities to fix or unfix', 'info', 2000); return; }
    this.app.toggleFix([...this.selected]);
  }

  deleteSelected() {
    const ids = [...this.selected];
    const cons = [...this.selectedCons];
    this.selected.clear();
    this.selectedCons.clear();
    if (cons.length) this.app.removeConstraints(cons);
    if (ids.length) this.app.removeSketchEntities(ids);
  }

  selectConstraint(cid, additive) {
    if (!additive) { this.selectedCons = new Set(this.selectedCons.has(cid) && this.selectedCons.size === 1 ? [] : [cid]); this.selected.clear(); }
    else if (this.selectedCons.has(cid)) this.selectedCons.delete(cid); else this.selectedCons.add(cid);
    if (this.tool !== 'select') this.setTool('select');
    this.app.refreshSketches();
    this.app.emit('sketchSelection');
  }

  highlightConstraint(cid) {
    this.hoverCons = cid;
    this._renderPicks();
  }

  // ------------------------------------------------------------ drawing → entities + auto-constraints
  _commit(ent, cons = []) {
    ent.id = newId('e');
    if (this.construction) ent.construction = true;
    const constraints = cons.map((c) => ({ ...c, refs: c.refs.map((r) => r.replace('@', ent.id)) }));
    this.app.addSketchEntity(ent, constraints);
  }

  /** Constraints implied by how each placed point snapped. part(i) → element part of the new entity. */
  _snapConstraints(part) {
    const out = [];
    this.meta.forEach((m, i) => {
      const s = m.snap, p = part(i);
      if (!s || !p) return;
      if (s.ref) out.push({ type: 'coincident', refs: [`@:${p}`, s.ref] });
      else if (s.kind === 'mid' && s.lineRef) out.push({ type: 'midpoint', refs: [`@:${p}`, s.lineRef] });
      else if (s.kind === 'quad' && s.curveRef) out.push({ type: 'coincident', refs: [`@:${p}`, s.curveRef] });
    });
    return out;
  }

  _typed(key) {
    const f = this.fields.find((x) => x.key === key);
    return f && f.locked && f.text && Number.isFinite(f.value) ? f.text : null;
  }

  _place() {
    if (!this.cursor) return;
    const p = this._constrained();
    const T = this.tool;
    const n = this.pts.length;
    const meta = { snap: this.snapInfo && (this.snapInfo.ref || this.snapInfo.lineRef || this.snapInfo.curveRef) && !this.fields.some((f) => f.locked && f.key !== 'n') ? this.snapInfo : null, hv: this._hv, typed: {} };
    for (const f of this.fields) if (f.locked && f.key !== 'n' && Number.isFinite(f.value)) meta.typed[f.key] = f.text;
    if (n === 0) {
      this.pts.push(p);
      this.meta.push(meta);
      this.fields = [];
      this.activeField = 0;
      this.fields = this._defineFields();
      this._renderPreview(); this._renderHud();
      return;
    }
    const a = this.pts[0];
    const fv = Object.fromEntries(this.fields.map((f) => [f.key, f]));
    const exprOr = (key, val, sign = 1) => {
      const f = fv[key];
      if (f && f.locked && !isLiteral(f.text)) return sign < 0 ? `-(${f.text})` : f.text;
      return num(sign * Math.abs(val));
    };
    const lockedOf = (keys) => keys.filter(([k]) => this._typed(k)).map(([, field]) => field);
    const posLocks = (fx, fy) => [...(this.meta[0].typed.x ? [fx] : []), ...(this.meta[0].typed.y ? [fy] : [])];

    if (T === 'line') {
      const last = this.pts[n - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 1e-9) return;
      if (this.snapInfo?.kind === 'first' && !this.fields.some((f) => f.locked)) { this._finishChain(true); return; }
      this.pts.push(p);
      meta.seg = { len: this._typed('len'), ang: this._typed('ang') };
      this.meta.push(meta);
      this.fields = [];
      this.fields = this._defineFields();
      this._renderPreview(); this._renderHud();
      return;
    }
    let ent = null, cons = [];
    if (T === 'rect' || T === 'centerRect') {
      let x0, y0, w, hgt;
      if (T === 'rect') { x0 = a[0]; y0 = a[1]; w = p[0] - a[0]; hgt = p[1] - a[1]; } else { w = 2 * (p[0] - a[0]); hgt = 2 * (p[1] - a[1]); x0 = a[0] - w / 2; y0 = a[1] - hgt / 2; }
      if (Math.abs(w) < 1e-9 || Math.abs(hgt) < 1e-9) return;
      this.meta.push(meta);
      if (T === 'centerRect') {
        const wx = Math.abs(w), hy = Math.abs(hgt);
        ent = { type: 'rect', x: num(a[0] - wx / 2), y: num(a[1] - hy / 2), w: exprOr('w', wx), h: exprOr('h', hy) };
        const corner = p[0] > a[0] ? (p[1] > a[1] ? 'v2' : 'v1') : p[1] > a[1] ? 'v3' : 'v0';
        cons = this._snapConstraints((i) => (i === 0 ? 'c' : corner));
      } else {
        ent = { type: 'rect', x: num(x0), y: num(y0), w: exprOr('w', w, Math.sign(w)), h: exprOr('h', hgt, Math.sign(hgt)) };
        cons = this._snapConstraints((i) => (i === 0 ? 'v0' : 'v2'));
        ent.locked = [...posLocks('x', 'y')];
      }
      ent.locked = [...(ent.locked || []), ...lockedOf([['w', 'w'], ['h', 'h']])];
    } else if (T === 'circle') {
      const d = 2 * Math.hypot(p[0] - a[0], p[1] - a[1]);
      if (d < 1e-9) return;
      this.meta.push(meta);
      ent = { type: 'circle', cx: num(a[0]), cy: num(a[1]), d: exprOr('d', d), locked: [...posLocks('cx', 'cy'), ...lockedOf([['d', 'd']])] };
      cons = this._snapConstraints((i) => (i === 0 ? 'c' : null));
      const s2 = this.meta[1].snap;
      if (s2 && s2.ref) cons.push({ type: 'coincident', refs: [s2.ref, '@:circ'] });
    } else if (T === 'polygon') {
      const r = Math.hypot(p[0] - a[0], p[1] - a[1]);
      if (r < 1e-9) return;
      this.meta.push(meta);
      const sides = fv.n && Number.isFinite(fv.n.value) ? Math.max(3, Math.round(fv.n.value)) : 6;
      ent = { type: 'polygon', cx: num(a[0]), cy: num(a[1]), r: exprOr('r', r), n: String(sides), rot: num((Math.atan2(p[1] - a[1], p[0] - a[0]) * 180) / Math.PI), locked: [...posLocks('cx', 'cy'), ...lockedOf([['r', 'r']])] };
      cons = this._snapConstraints((i) => (i === 0 ? 'c' : 'v0'));
    } else if (T === 'slot') {
      if (n === 1) {
        if (Math.hypot(p[0] - a[0], p[1] - a[1]) < 1e-9) return;
        meta.seg = { len: this._typed('len'), ang: this._typed('ang') };
        this.pts.push(p);
        this.meta.push(meta);
        this.fields = [];
        this.fields = this._defineFields();
        this._renderPreview(); this._renderHud();
        return;
      }
      const b = this.pts[1];
      const w = fv.w && fv.w.locked ? fv.w.value : fv.w ? fv.w.live : 0;
      if (!(w > 1e-9)) return;
      ent = { type: 'slot', x1: num(a[0]), y1: num(a[1]), x2: num(b[0]), y2: num(b[1]), w: exprOr('w', w), locked: [...posLocks('x1', 'y1'), ...lockedOf([['w', 'w']])] };
      cons = this._snapConstraints((i) => (i === 0 ? 'p1' : i === 1 ? 'p2' : null));
      const m1 = this.meta[1];
      if (m1.hv) cons.push({ type: m1.hv === 'h' ? 'horizontal' : 'vertical', refs: ['@:p1', '@:p2'] });
      if (m1.seg && m1.seg.len) cons.push({ type: 'distance', refs: ['@:p1', '@:p2'], value: m1.seg.len });
    }
    if (ent) {
      if (!ent.locked || !ent.locked.length) delete ent.locked;
      this._commit(ent, cons);
    }
    this.reset();
  }

  _finishChain(closed = false) {
    if (this.tool !== 'line') return;
    const pts = this.pts;
    if (pts.length < 2) { this.reset(); return; }
    const isLine = pts.length === 2 && !closed;
    const partOf = (i) => (isLine ? (i === 0 ? 'p1' : 'p2') : `v${i}`);
    const segOf = (i) => (isLine ? 'seg' : `s${i}`);
    const cons = this._snapConstraints(partOf);
    const locked = [];
    if (this.meta[0].typed.x) locked.push(isLine ? 'x1' : 'pts.0.0');
    if (this.meta[0].typed.y) locked.push(isLine ? 'y1' : 'pts.0.1');
    this.meta.forEach((m, i) => {
      if (i === 0) return;
      const seg = `@:${segOf(i - 1)}`;
      if (m.hv) cons.push({ type: m.hv === 'h' ? 'horizontal' : 'vertical', refs: [seg] });
      if (m.seg && m.seg.len) cons.push({ type: 'length', refs: [seg], value: m.seg.len });
      if (m.seg && m.seg.ang && !m.hv) {
        const A = pts[i - 1], B = pts[i];
        const raw = dirAngle([B[0] - A[0], B[1] - A[1]], [1, 0]);
        if (Math.abs(raw) > 1e-6) cons.push({ type: 'angle', refs: [seg, 'xaxis'], value: String(Math.abs(this._evalField(m.seg.ang))), sgn: Math.sign(raw) });
      }
    });
    const ent = isLine
      ? { type: 'line', x1: num(pts[0][0]), y1: num(pts[0][1]), x2: num(pts[1][0]), y2: num(pts[1][1]) }
      : { type: 'polyline', pts: pts.map(([x, y]) => [num(x), num(y)]), closed };
    if (locked.length) ent.locked = locked;
    this._commit(ent, cons);
    this.reset();
  }

  // ------------------------------------------------------------ constraint + dimension tools
  _wantedKinds() {
    if (this.ctype === 'hv') return ['line', 'point'];
    const def = CONSTRAINTS[this.ctype];
    const kinds = ['point', 'line', 'circle'].filter((k) => def.check([...this.picks.map((r) => this.ctx.table.get(r)?.kind), k]));
    return kinds.length ? kinds : ['point', 'line', 'circle'];
  }

  _pickClick(e) {
    const ref = this._elementAt(e, this.tool === 'dimension' ? ['point', 'line', 'circle'] : this._wantedKinds());
    if (!ref) {
      if (this.tool === 'dimension' && this.picks.length === 1 && this.ctx.table.get(this.picks[0])?.kind === 'line') this._createDimension(this.picks);
      else { this.picks = []; this._renderPicks(); }
      this.app.emit('sketchTool');
      return;
    }
    if (this.picks.includes(ref)) return;
    this.picks.push(ref);
    if (this.tool === 'dimension') {
      const kinds = this.picks.map((r) => this.ctx.table.get(r).kind);
      if (this.picks.length === 2 || (kinds.length === 1 && kinds[0] === 'circle')) this._createDimension(this.picks);
    } else this._tryConstraint();
    this._renderPicks();
    this.app.emit('sketchTool');
  }

  _tryConstraint() {
    const T = this.ctx.table;
    const kinds = this.picks.map((r) => T.get(r).kind);
    let type = this.ctype;
    let state;
    if (type === 'hv') {
      state = (kinds.length === 1 && kinds[0] === 'line') || (kinds.length === 2 && kinds.every((k) => k === 'point')) ? 'ok' : kinds.length === 1 && kinds[0] === 'point' ? 'more' : false;
    } else state = CONSTRAINTS[type].check(kinds);
    if (state === 'more') return;
    if (!state) {
      const def = type === 'hv' ? HV : CONSTRAINTS[type];
      toast(`${def.label}: ${def.desc}`, 'info', 2600);
      this.picks = [];
      return;
    }
    let refs = this.picks.slice();
    const els = refs.map((r) => T.get(r));
    if (type === 'hv') {
      const d = els.length === 1 ? [els[0].b[0] - els[0].a[0], els[0].b[1] - els[0].a[1]] : [els[1].p[0] - els[0].p[0], els[1].p[1] - els[0].p[1]];
      type = Math.abs(d[0]) >= Math.abs(d[1]) ? 'horizontal' : 'vertical';
    }
    const def = CONSTRAINTS[type];
    if (def.normalize) refs = def.normalize(refs, kinds);
    const extra = def.init ? def.init(refs.map((r) => T.get(r))) : {};
    this.picks = [];
    this.app.addConstraint({ type, refs, ...extra });
  }

  _createDimension(refs) {
    const T = this.ctx.table;
    const els = refs.map((r) => T.get(r));
    const kinds = els.map((x) => x.kind);
    this.picks = [];
    this._renderPicks();
    const openEditor = (id) => setTimeout(() => this.vp.editDimension(id), 30);
    const lockField = (entId, k) => { this.app.applySketchAction({ ent: entId, lock: [k] }, 'Add dimension'); openEditor(`${entId}:${k}`); };
    const addCons = (type, r, extra = {}) => {
      const m = CONSTRAINTS[type].measure(r.map((x) => T.get(x)));
      const id = newId('k');
      const res = this.app.applySketchAction({ add: { id, type, refs: r, value: num(m.value), ...(m.sgn ? { sgn: m.sgn } : {}), ...extra } }, 'Add dimension', true);
      if (!res.ok) { toast('That dimension would over-constrain the sketch', 'warn'); return; }
      openEditor(`c:${id}`);
    };
    if (refs.length === 1) {
      const [el] = els, [ref] = refs;
      const ent = this.ctx.ents.find((x) => x.id === el.ent);
      if (!ent) return;
      if (el.kind === 'circle') return lockField(ent.id, ent.type === 'circle' ? 'd' : 'w');
      if (el.kind === 'line') {
        if (ent.type === 'rect') return lockField(ent.id, el.part === 'e0' || el.part === 'e2' ? 'w' : 'h');
        if (ent.type === 'slot') return addCons('distance', [`${ent.id}:p1`, `${ent.id}:p2`]);
        return addCons('length', [ref]);
      }
      return;
    }
    const [a, b] = els;
    if (kinds.every((k) => k === 'point' || k === 'circle')) {
      const pa = a.kind === 'point' ? a.p : a.c, pb = b.kind === 'point' ? b.p : b.c;
      const type = Math.abs(pa[1] - pb[1]) < 1e-6 ? 'hdistance' : Math.abs(pa[0] - pb[0]) < 1e-6 ? 'vdistance' : 'distance';
      return addCons(type, refs);
    }
    if (kinds.includes('line') && (kinds.includes('point') || kinds.includes('circle'))) {
      const r = kinds[0] === 'line' ? [refs[1], refs[0]] : refs;
      return addCons('pldistance', r);
    }
    if (kinds[0] === 'line' && kinds[1] === 'line') {
      const d1 = [a.b[0] - a.a[0], a.b[1] - a.a[1]], d2 = [b.b[0] - b.a[0], b.b[1] - b.a[1]];
      const s = Math.abs(d1[0] * d2[1] - d1[1] * d2[0]) / ((Math.hypot(...d1) * Math.hypot(...d2)) || 1);
      if (s < 1e-4) {
        const startPart = { seg: 'p1' }[b.part] || (/^[es]\d+$/.test(b.part) ? `v${b.part.slice(1)}` : null);
        if (!startPart || !b.ent) { toast('Pick a point and a line to dimension the gap between parallel lines', 'info'); return; }
        return addCons('pldistance', [`${b.ent}:${startPart}`, refs[0]]);
      }
      return addCons('angle', refs);
    }
    toast('Pick a line or circle, or two points / lines / circles', 'info');
  }

  // ------------------------------------------------------------ select tool: hit test + solver drag
  _entityAt(e) {
    const ctx = this.ctx;
    let best = null, bd = 7;
    for (const ent of ctx.ents) {
      if (ent.error) continue;
      const o = outline(ent);
      const pts = isOpenOutline(ent) ? o : [...o, o[0]];
      const sp = pts.map((p) => this.screenOf(p));
      for (let i = 0; i < sp.length - 1; i++) {
        const [ax, ay] = sp[i], [bx, by] = sp[i + 1];
        const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
        let t = L2 ? ((e.clientX - ax) * dx + (e.clientY - ay) * dy) / L2 : 0;
        t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(e.clientX - ax - t * dx, e.clientY - ay - t * dy);
        if (d < bd) { bd = d; best = ent.id; }
      }
    }
    return best;
  }

  _dragMove(e) {
    const d = this.drag;
    const raw = this.local(e);
    if (!raw || !d.start) return;
    let dx = raw[0] - d.start[0], dy = raw[1] - d.start[1];
    if (!d.moved && Math.hypot(dx, dy) < 2 * this.vp.pixelSize()) return;
    d.moved = true;
    const stiffIds = new Set(d.ids);
    if (d.mode === 'point') d.res = this.app.dragSolve({ drag: { ref: d.ref, target: raw }, stiffIds });
    else if (d.mode === 'circle') d.res = this.app.dragSolve({ drag: { circleRef: `${d.ent}:circ`, target: raw }, stiffIds });
    else {
      if (this.snapGrid) { const st = this.snapStep(); dx = Math.round(dx / st) * st; dy = Math.round(dy / st) * st; }
      const f = this.app.activeSketch();
      const ents = f.entities.map((x) => (d.ids.includes(x.id) ? shiftEntity(x, dx, dy) : x));
      d.res = this.app.dragSolve({ entities: ents, stiffIds });
    }
  }

  _dragEnd() {
    const d = this.drag;
    this.drag = null;
    if (d.moved && d.res) this.app.endDrag(d.res, d.mode === 'circle' ? 'Resize circle' : 'Move sketch geometry');
    else {
      this.app.endDrag(null);
      if (d.shift && this.selected.has(d.clicked) && d.ids.length > 1) { this.selected.delete(d.clicked); this.app.refreshSketches(); this.app.emit('sketchSelection'); }
    }
  }

  // ------------------------------------------------------------ preview + HUD
  _renderPicks() {
    const ctx = this.ctx;
    if (!ctx) return;
    const items = [], points = [];
    const draw = (ref, color) => {
      const el = ctx.table.get(ref);
      if (!el) return;
      if (el.kind === 'point') points.push({ p: el.p, color, size: 11 });
      else if (el.kind === 'line') {
        if (el.infinite) { const L = 1e4; items.push({ pts: [[el.a[0] - (el.b[0] - el.a[0]) * L, el.a[1] - (el.b[1] - el.a[1]) * L], [el.a[0] + (el.b[0] - el.a[0]) * L, el.a[1] + (el.b[1] - el.a[1]) * L]], color, dashed: true }); }
        else items.push({ pts: [el.a, el.b], color });
      } else items.push({ pts: outline({ type: 'circle', cx: el.c[0], cy: el.c[1], d: 2 * el.r }), closed: true, color });
    };
    if (this.hoverCons) {
      const c = (this.app.activeSketch().constraints || []).find((x) => x.id === this.hoverCons);
      if (c) c.refs.forEach((r) => draw(r, CONS_HL));
    }
    for (const r of this.picks) draw(r, PICK);
    if (this.hoverEl && !this.picks.includes(this.hoverEl)) draw(this.hoverEl, PICK_HOVER);
    this.vp.setPreview(ctx.frame, items, points);
  }

  _renderPreview() {
    const ctx = this.ctx;
    if (!ctx) return;
    const items = [];
    const T = this.tool;
    const c = this.cursor ? this._constrained() : null;
    const col = this.construction ? '#ff9a3c' : '#4f8cff';
    for (const g of this.guides) items.push({ pts: g, color: '#3fb950', dashed: true, opacity: 0.8 });
    const n = this.pts.length;
    if (c && n) {
      const a = this.pts[0];
      if (T === 'line') items.push({ pts: [...this.pts, c], color: col });
      if (T === 'rect') items.push({ pts: [[a[0], a[1]], [c[0], a[1]], [c[0], c[1]], [a[0], c[1]]], closed: true, color: col });
      if (T === 'centerRect') { const dx = c[0] - a[0], dy = c[1] - a[1]; items.push({ pts: [[a[0] - dx, a[1] - dy], [a[0] + dx, a[1] - dy], [a[0] + dx, a[1] + dy], [a[0] - dx, a[1] + dy]], closed: true, color: col }); }
      if (T === 'circle') items.push({ pts: outline({ type: 'circle', cx: a[0], cy: a[1], d: 2 * Math.hypot(c[0] - a[0], c[1] - a[1]) }), closed: true, color: col }, { pts: [a, c], color: col, dashed: true, opacity: 0.6 });
      if (T === 'polygon') {
        const nf = this.fields.find((f) => f.key === 'n');
        const sides = nf && Number.isFinite(nf.value) ? Math.max(3, Math.round(nf.value)) : 6;
        items.push({ pts: outline({ type: 'polygon', cx: a[0], cy: a[1], r: Math.hypot(c[0] - a[0], c[1] - a[1]), n: sides, rot: (Math.atan2(c[1] - a[1], c[0] - a[0]) * 180) / Math.PI }), closed: true, color: col });
      }
      if (T === 'slot') {
        if (n === 1) items.push({ pts: [a, c], color: col, dashed: true });
        else {
          const b = this.pts[1];
          const wf = this.fields.find((f) => f.key === 'w');
          const w = wf ? (wf.locked ? wf.value : wf.live) : 0;
          if (w > 1e-9) items.push({ pts: outline({ type: 'slot', x1: a[0], y1: a[1], x2: b[0], y2: b[1], w }), closed: true, color: col });
          items.push({ pts: [a, b], color: col, dashed: true, opacity: 0.6 });
        }
      }
    }
    const points = [];
    if (c) points.push({ p: c, color: SNAP_COLORS[this.snapInfo?.kind] || '#4f8cff', size: this.snapInfo?.kind && this.snapInfo.kind !== 'grid' ? 11 : 7 });
    this.vp.setPreview(ctx.frame, items, points);
  }

  _renderHud() {
    const el = this.hudEl;
    if (!this.active || this.tool === 'select' || this.picking || !this.cursor || !this._lastClient) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const wrap = el.parentElement.getBoundingClientRect();
    el.style.left = `${this._lastClient[0] - wrap.left}px`;
    el.style.top = `${this._lastClient[1] - wrap.top}px`;
    el.innerHTML = this.fields.map((f, i) => {
      const val = f.locked ? (f.text || '') : fmt(f.value, 2);
      const unit = f.unit === '°' ? '°' : '';
      return `<div class="hud-field${i === this.activeField ? ' active' : ''}${f.locked ? ' locked' : ''}"><b>${f.label}</b>${escapeHtml(val)}${unit}</div>`;
    }).join('');
  }
}

function escapeHtml(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

const POS_FIELDS = { line: [['x1', 'y1'], ['x2', 'y2']], rect: [['x', 'y']], circle: [['cx', 'cy']], polygon: [['cx', 'cy']], slot: [['x1', 'y1'], ['x2', 'y2']], arc: [['cx', 'cy']] };

/** Shift the free (literal, unlocked) position fields of a stored entity. Driven values stay put. */
export function shiftEntity(e, dx, dy) {
  if (e.fixed) return e;
  const locked = new Set(e.locked || []);
  const mv = (key, v, d) => (locked.has(key) || !isLiteral(v) || Math.abs(d) < 1e-12 ? v : num(parseFloat(v) + d));
  const o = { ...e };
  for (const [kx, ky] of POS_FIELDS[e.type] || []) { o[kx] = mv(kx, String(e[kx]), dx); o[ky] = mv(ky, String(e[ky]), dy); }
  if (e.type === 'polyline') o.pts = e.pts.map(([x, y], i) => [mv(`pts.${i}.0`, String(x), dx), mv(`pts.${i}.1`, String(y), dy)]);
  return o;
}
