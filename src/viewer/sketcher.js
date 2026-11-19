// Interactive 2D sketching on a plane: drawing tools, snapping + inference with
// automatic constraints, type-to-dimension input, constraint and dimension tools,
// and solver-driven dragging.
import { evaluate, fmt } from '../model/expr.js';
import { outline, isOpenOutline, slotFrame, evalEntity } from '../model/profiles.js';
import { toWorld, toLocal } from '../model/geom.js';
import { newId } from '../model/features.js';
import { CONSTRAINTS, HV, isLiteral, dirAngle } from '../model/constraints.js';
import {
  primsOf, primsOutline, endTangent, tangentBulge, bulgeFromThreePoints, arcFromBulge,
  trimEntity, extendEntity, offsetEntity, filletCorner,
} from '../model/sketchgeom.js';
import { toast } from '../ui/dom.js';

const NICE = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
const SNAP_COLORS = { end: '#ff7a1a', mid: '#ff7a1a', center: '#3fb950', quad: '#3fb950', origin: '#e5534b', first: '#ff7a1a', grid: '#4f8cff' };
const PICK = '#ffb020', PICK_HOVER = '#ffd27a', CONS_HL = '#22d3ee';
const num = (v) => fmt(v, 4);

export const SKETCH_TOOLS = {
  select: { label: 'Select', icon: 'cursor', key: 'Esc', desc: 'Select and drag. Drag points to reshape, a circle’s edge to resize — constraints are kept.' },
  line: { label: 'Line', icon: 'line', key: 'L', desc: 'Click points to draw connected lines. Press A to switch the next segments to tangent arcs (and back). Click the first point to close the shape.' },
  arc: { label: '3-point arc', short: 'Arc', icon: 'arc', key: 'A', desc: 'Click the start, then the end, then a point the arc passes through' },
  rect: { label: 'Rectangle', icon: 'rect', key: 'R', desc: 'Two-corner rectangle' },
  centerRect: { label: 'Center rect', icon: 'centerRect', key: 'Shift+R', desc: 'Rectangle drawn from its center' },
  circle: { label: 'Circle', icon: 'circle', key: 'C', desc: 'Center + diameter circle' },
  polygon: { label: 'Polygon', icon: 'polygon', desc: 'Regular polygon (type a side count with Tab)' },
  slot: { label: 'Slot', icon: 'slot', desc: 'Center-to-center slot: two centers, then the width' },
  fillet: { label: 'Sketch fillet', short: 'Fillet', icon: 'fillet', key: 'F', desc: 'Click a corner to round it. Type a number to change the radius.' },
  trim: { label: 'Trim', icon: 'trim', key: 'T', desc: 'Click a piece of a curve to cut it back to the nearest crossings' },
  extend: { label: 'Extend', icon: 'extend', key: 'E', desc: 'Click near the end of a line to stretch it to the next curve' },
  offset: { label: 'Offset', icon: 'offset', key: 'O', desc: 'Click a curve or shape to add a parallel copy. Type the distance; hold Shift for the other side.' },
  project: { label: 'Project', icon: 'project', key: 'P', desc: 'Click model edges to copy them into this sketch' },
  dimension: { label: 'Dimension', icon: 'dimension', key: 'D', desc: 'Click a line, arc or circle, or two items (points, lines, circles) to add a driving dimension. Click empty space after one line for its length.' },
};
const MODIFY_TOOLS = new Set(['fillet', 'trim', 'extend', 'offset', 'project']);

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
    this.arcMode = false;
    this.modText = { fillet: '2', offset: '2' };
    this.reset();
  }

  get active() { return this.app.mode === 'sketch'; }
  get ctx() { return this.app.activeSketchContext(); }
  get picking() { return this.tool === 'constraint' || this.tool === 'dimension'; }
  get modifying() { return MODIFY_TOOLS.has(this.tool); }

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
    if (tool !== 'line') this.arcMode = false;
    this.modTarget = null;
    this.vp.setHover(null);
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
      if (el.kind === 'point') cands.push({ p: el.p, kind: ref === 'origin' ? 'origin' : el.part === 'c' || el.part.startsWith('ac') ? 'center' : 'end', ref });
      else if (el.kind === 'line' && !el.infinite) cands.push({ p: [(el.a[0] + el.b[0]) / 2, (el.a[1] + el.b[1]) / 2], kind: 'mid', lineRef: ref });
      else if (el.kind === 'circle' && el.part === 'circ') for (const a of [0, 0.5, 1, 1.5]) cands.push({ p: [el.c[0] + el.r * Math.cos(a * Math.PI), el.c[1] + el.r * Math.sin(a * Math.PI)], kind: 'quad', curveRef: ref });
    }
    if (this.tool === 'line' && this.pts.length >= (this.arcMode ? 2 : 3)) cands.push({ p: this.pts[0], kind: 'first' });
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
    if (last && ((this.tool === 'line' && !this.arcMode) || ((this.tool === 'slot' || this.tool === 'arc') && this.pts.length === 1))) {
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
    if (MODIFY_TOOLS.has(T)) {
      if (T !== 'fillet' && T !== 'offset') return [];
      const key = T === 'fillet' ? 'r' : 'd';
      const p = prev.get(key);
      const text = this.modText[T];
      return [{ key, label: T === 'fillet' ? 'R' : 'D', unit: 'mm', live: this._evalField(text), locked: true, text, value: this._evalField(text), fresh: p ? p.fresh : true }];
    }
    if (n === 0) return [mk('x', 'X', c[0]), mk('y', 'Y', c[1])];
    const last = this.pts[n - 1];
    if (T === 'arc' && n === 2) return [];
    if (T === 'line' || (T === 'arc' && n === 1)) {
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
    if (this.tool === 'line' || ((this.tool === 'slot' || this.tool === 'arc') && n === 1)) {
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
    if (this.modifying) {
      const raw = this.local(e);
      if (!raw) return true;
      this.cursor = raw;
      this._lastClient = [e.clientX, e.clientY];
      this._lastEvent = e;
      this.fields = this._defineFields();
      this._modifyHover(e, raw);
      this._renderHud();
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
      if (this.picking) this._pickClick(e); else if (this.modifying) this._modifyClick(e); else this._place();
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
      f.text = (f.locked && !f.fresh ? f.text : '') + k; // the first key replaces a preset value
      f.fresh = false;
      f.locked = true;
      f.value = this._evalField(f.text);
      if (this.modifying) { this.modText[this.tool] = f.text; this._refreshModify(); this.app.emit('sketchTool'); } else this._renderPreview();
      this._renderHud();
      return true;
    }
    if (drawing && k === 'Backspace' && this.fields.length) {
      const f = this.fields[this.activeField];
      if (this.modifying) {
        f.text = f.text.slice(0, -1); f.fresh = false; f.value = this._evalField(f.text);
        this.modText[this.tool] = f.text; this._refreshModify(); this._renderHud();
      } else if (f.locked) { f.text = f.text.slice(0, -1); if (!f.text) f.locked = false; f.value = f.locked ? this._evalField(f.text) : f.live; this._renderPreview(); this._renderHud(); }
      return true;
    }
    if (drawing && k === 'Tab' && this.fields.length) {
      this.activeField = (this.activeField + (e.shiftKey ? this.fields.length - 1 : 1)) % this.fields.length;
      this._renderHud();
      return true;
    }
    if (k === 'Enter' && this.tool === 'dimension' && this.picks.length === 1) { this._createDimension(this.picks); return true; }
    if (k === 'Enter' && this.modifying) return true;
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
    if (k === 'a' || k === 'A') {
      // in a line chain, A switches the next segments between straight and tangent arcs
      if (this.tool === 'line' && this.pts.length) {
        this.arcMode = !this.arcMode;
        this.app.emit('sketchTool');
        if (this._lastEvent) this.pointermove(this._lastEvent); else { this._renderPreview(); this._renderHud(); }
        return true;
      }
      this.setTool('arc');
      return true;
    }
    const map = { l: 'line', r: 'rect', R: 'centerRect', c: 'circle', d: 'dimension', f: 'fillet', t: 'trim', e: 'extend', o: 'offset', p: 'project' };
    if (map[k]) { this.setTool(map[k]); return true; }
    if (k === 'h') { this.setTool('constraint', 'hv'); return true; }
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
      const bulge = this._chainBulge(p);
      if (this.snapInfo?.kind === 'first' && !this.fields.some((f) => f.locked)) { this._closingBulge = bulge; this._closingTangent = this.arcMode && bulge !== 0; this._finishChain(true); return; }
      this.pts.push(p);
      meta.seg = { len: bulge ? null : this._typed('len'), ang: bulge ? null : this._typed('ang') };
      meta.bulge = bulge;
      meta.tangentArc = this.arcMode && bulge !== 0;
      if (bulge) meta.hv = null;
      this.meta.push(meta);
      this.fields = [];
      this.fields = this._defineFields();
      this._renderPreview(); this._renderHud();
      return;
    }
    if (T === 'arc') {
      if (n === 1) {
        if (Math.hypot(p[0] - a[0], p[1] - a[1]) < 1e-9) return;
        this.pts.push(p);
        this.meta.push(meta);
        this.fields = [];
        this.fields = this._defineFields();
        this._renderPreview(); this._renderHud();
        return;
      }
      const b = this.pts[1];
      const bulge = bulgeFromThreePoints(a, p, b);
      if (Math.abs(bulge) < 1e-9) return;
      const ent = { type: 'polyline', pts: [[num(a[0]), num(a[1])], [num(b[0]), num(b[1])]], bulges: [fmt(bulge, 9)], closed: false };
      const cons = this._snapConstraints((i) => (i === 0 ? 'v0' : i === 1 ? 'v1' : null));
      this._commit(ent, cons);
      this.reset();
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

  /** Bulge for the next chain segment: a tangent arc in arc mode, otherwise straight. */
  _chainBulge(p, quiet = false) {
    const n = this.pts.length;
    if (!this.arcMode || n < 1) return 0;
    if (n < 2) { if (!quiet && !this._arcHinted) { toast('Tangent arcs continue from the previous segment — draw a line first', 'info', 2600); this._arcHinted = true; } return 0; }
    const prev = { k: 'A', a: this.pts[n - 2], b: this.pts[n - 1], bulge: this.meta[n - 1].bulge || 0 };
    return tangentBulge(this.pts[n - 1], endTangent(prev), p);
  }

  _finishChain(closed = false) {
    if (this.tool !== 'line') return;
    const pts = this.pts;
    if (pts.length < 2) { this.reset(); return; }
    // bulge of segment i (pts[i] → pts[i+1]); the closing segment (closed chains) is last
    const bulges = this.meta.slice(1).map((m) => m.bulge || 0);
    if (closed) bulges.push(this._closingBulge || 0);
    const isLine = pts.length === 2 && !closed && !bulges[0];
    const partOf = (i) => (isLine ? (i === 0 ? 'p1' : 'p2') : `v${i}`);
    const segRef = (i) => (isLine ? 'seg' : `${bulges[i] ? 'a' : 's'}${i}`);
    const cons = this._snapConstraints(partOf);
    const locked = [];
    if (this.meta[0].typed.x) locked.push(isLine ? 'x1' : 'pts.0.0');
    if (this.meta[0].typed.y) locked.push(isLine ? 'y1' : 'pts.0.1');
    const tangentTo = (i) => {
      // segment i is a tangent arc: keep it tangent to the segment before it
      const j = i - 1;
      if (j < 0) return;
      const t = { type: 'tangent', refs: [`@:${segRef(j)}`, `@:${segRef(i)}`] };
      if (bulges[j]) t.mode = Math.sign(bulges[j]) === Math.sign(bulges[i]) ? 'int' : 'ext';
      cons.push(t);
    };
    this.meta.forEach((m, i) => {
      if (i === 0) return;
      const seg = `@:${segRef(i - 1)}`;
      if (m.tangentArc) tangentTo(i - 1);
      if (bulges[i - 1]) return;
      if (m.hv) cons.push({ type: m.hv === 'h' ? 'horizontal' : 'vertical', refs: [seg] });
      if (m.seg && m.seg.len) cons.push({ type: 'length', refs: [seg], value: m.seg.len });
      if (m.seg && m.seg.ang && !m.hv) {
        const A = pts[i - 1], B = pts[i];
        const raw = dirAngle([B[0] - A[0], B[1] - A[1]], [1, 0]);
        if (Math.abs(raw) > 1e-6) cons.push({ type: 'angle', refs: [seg, 'xaxis'], value: String(Math.abs(this._evalField(m.seg.ang))), sgn: Math.sign(raw) });
      }
    });
    if (closed && this._closingTangent) tangentTo(pts.length - 1);
    const ent = isLine
      ? { type: 'line', x1: num(pts[0][0]), y1: num(pts[0][1]), x2: num(pts[1][0]), y2: num(pts[1][1]) }
      : { type: 'polyline', pts: pts.map(([x, y]) => [num(x), num(y)]), bulges: bulges.map((b) => (b ? fmt(b, 9) : '0')), closed };
    if (locked.length) ent.locked = locked;
    this._closingBulge = 0;
    this._closingTangent = false;
    this._commit(ent, cons);
    this.reset();
  }

  // ------------------------------------------------------------ modify tools: fillet, trim, extend, offset, project
  stored(id) { return this.app.activeSketch().entities.find((x) => x.id === id); }
  _modValue() { const v = this._evalField(this.modText[this.tool]); return Number.isFinite(v) ? v : NaN; }

  _refreshModify() {
    if (this._lastEvent && this.cursor) this._modifyHover(this._lastEvent, this.cursor);
  }

  _modifyHover(e, raw) {
    const ctx = this.ctx, T = this.tool;
    const items = [], points = [];
    this.modTarget = null;
    if (T === 'project') {
      const hit = this.vp.pick(e.clientX, e.clientY, 'edges');
      this.vp.setHover(hit && hit.kind === 'edge' ? hit : null);
      this.modTarget = hit && hit.kind === 'edge' ? hit : null;
      this.vp.renderer.domElement.style.cursor = this.modTarget ? 'pointer' : 'crosshair';
      this.vp.setPreview(ctx.frame, []);
      return;
    }
    if (T === 'fillet') {
      const c = this._findCorner(raw, this._modValue());
      this.modTarget = c;
      if (c && c.res && !c.res.error) items.push({ pts: primsOutline([{ k: 'A', a: c.res.t1, b: c.res.t2, bulge: c.res.bulge }], false), color: PICK });
      if (c) points.push({ p: c.V, color: c.res && c.res.error ? '#ef5350' : PICK, size: 10 });
    } else {
      const id = this._entityAt(e);
      const ent = id && ctx.ents.find((x) => x.id === id);
      if (ent && !ent.error) {
        if (T === 'trim') {
          const r = trimEntity(ent, ctx.ents, raw);
          if (r) { this.modTarget = { ent, r }; for (const p of r.removed) items.push({ pts: primsOutline([p], false), color: '#ef5350' }); }
        } else if (T === 'extend') {
          const r = extendEntity(ent, this.stored(id), ctx.ents, raw);
          if (r) { this.modTarget = { ent, r }; items.push({ pts: [r.from, r.to], color: '#3fb950', dashed: true }); }
        } else if (T === 'offset') {
          const d = this._modValue() * (e.shiftKey ? -1 : 1);
          const off = Number.isFinite(d) ? offsetEntity(ent, d) : null;
          if (off) {
            this.modTarget = { ent, off };
            const ev = evalEntity(off, this.app.scope);
            items.push({ pts: outline(ev), closed: !isOpenOutline(ev), color: '#4f8cff', dashed: true });
          }
        }
      }
    }
    this.vp.renderer.domElement.style.cursor = this.modTarget ? 'pointer' : 'crosshair';
    this.vp.setPreview(ctx.frame, items, points);
  }

  _modifyClick(e) {
    const raw = this.local(e);
    if (raw) this._modifyHover(e, raw);
    const t = this.modTarget;
    if (!t) {
      const hints = { fillet: 'Click near a corner between two straight segments', trim: 'Click the piece of a curve you want to remove', extend: 'Click near the end of a line that points at another curve', offset: 'Click a curve or shape to offset', project: 'Click an edge of the model' };
      toast(hints[this.tool], 'info', 2000);
      return;
    }
    const T = this.tool;
    if (T === 'fillet') this._applyFillet(t, this._modValue());
    else if (T === 'trim') this._applyTrim(t);
    else if (T === 'extend') this.app.updateSketchEntities([t.ent.id], (x) => ({ ...x, ...t.r.patch }), 'Extend');
    else if (T === 'offset') {
      const off = { ...t.off };
      if (t.ent.construction || this.construction) off.construction = true;
      this._commit(off, []);
    } else if (T === 'project') this._applyProject(t);
    this.modTarget = null;
    this.vp.setPreview(this.ctx.frame, []);
    if (this._lastEvent) setTimeout(() => this._refreshModify(), 0);
  }

  /** Nearest roundable corner: polyline vertices, rectangle/polygon corners, or two lines that meet. */
  _findCorner(raw, r) {
    const ctx = this.ctx;
    const tol = 14 * this.vp.pixelSize();
    let best = null;
    const consider = (c) => { const d = Math.hypot(raw[0] - c.V[0], raw[1] - c.V[1]); if (d < tol && (!best || d < best.d)) best = { ...c, d }; };
    const lines = [];
    for (const e of ctx.ents) {
      if (e.error) continue;
      if (e.type === 'polyline') {
        const n = e.pts.length;
        for (let k = 0; k < n; k++) {
          if (!e.closed && (k === 0 || k === n - 1)) continue;
          const prevSeg = k === 0 ? n - 1 : k - 1;
          if ((e.bulges[prevSeg] || 0) !== 0 || (e.bulges[k] || 0) !== 0) continue;
          consider({ kind: 'poly', ent: e, k, P: e.pts[(k - 1 + n) % n], V: e.pts[k], N: e.pts[(k + 1) % n] });
        }
      } else if (e.type === 'rect' || e.type === 'polygon') {
        const v = primsOf(e).prims.map((p) => p.a), n = v.length;
        v.forEach((V, k) => consider({ kind: 'convert', ent: e, k, P: v[(k - 1 + n) % n], V, N: v[(k + 1) % n] }));
      } else if (e.type === 'line') lines.push(e);
    }
    const ends = (l) => [['p1', [l.x1, l.y1], [l.x2, l.y2]], ['p2', [l.x2, l.y2], [l.x1, l.y1]]];
    for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
      for (const [e1, V1, O1] of ends(lines[i])) for (const [e2, V2, O2] of ends(lines[j])) {
        if (Math.hypot(V1[0] - V2[0], V1[1] - V2[1]) < 1e-6) consider({ kind: 'lines', l1: lines[i], end1: e1, l2: lines[j], end2: e2, P: O1, V: V1, N: O2 });
      }
    }
    if (best) best.res = Number.isFinite(r) && r > 0 ? filletCorner(best.P, best.V, best.N, r) : { error: 'Type a radius greater than zero' };
    return best;
  }

  _applyFillet(c, r) {
    if (!c.res || c.res.error) { toast(c.res ? c.res.error : 'No corner here', 'warn', 2400); return; }
    const app = this.app;
    const rText = this.modText.fillet;
    const P2 = (p) => [num(p[0]), num(p[1])];
    if (c.kind === 'lines') {
      const arcId = newId('e');
      const { t1, t2, bulge } = c.res;
      app.commitSketch('Sketch fillet', (d) => {
        d.entities = d.entities.map((x) => {
          if (x.id === c.l1.id) return { ...x, ...(c.end1 === 'p1' ? { x1: P2(t1)[0], y1: P2(t1)[1] } : { x2: P2(t1)[0], y2: P2(t1)[1] }) };
          if (x.id === c.l2.id) return { ...x, ...(c.end2 === 'p1' ? { x1: P2(t2)[0], y1: P2(t2)[1] } : { x2: P2(t2)[0], y2: P2(t2)[1] }) };
          return x;
        });
        d.entities.push({ id: arcId, type: 'polyline', pts: [P2(t1), P2(t2)], bulges: [fmt(bulge, 9)], closed: false });
        const r1 = `${c.l1.id}:${c.end1}`, r2 = `${c.l2.id}:${c.end2}`;
        d.constraints = d.constraints.filter((k) => !(k.type === 'coincident' && k.refs.includes(r1) && k.refs.includes(r2)));
        d.constraints.push(
          { type: 'coincident', refs: [`${arcId}:v0`, r1] }, { type: 'coincident', refs: [`${arcId}:v1`, r2] },
          { type: 'tangent', refs: [`${c.l1.id}:seg`, `${arcId}:a0`] }, { type: 'tangent', refs: [`${c.l2.id}:seg`, `${arcId}:a0`] },
          { type: 'radius', refs: [`${arcId}:a0`], value: rText });
      });
      return;
    }
    app.commitSketch('Sketch fillet', (d) => {
      const idx = d.entities.findIndex((x) => x.id === c.ent.id);
      let s = d.entities[idx];
      if (c.kind === 'convert') {
        const conv = toPolyline(s, c.ent);
        s = conv.ent;
        d.constraints = remapConstraints(d.constraints, s.id, conv.remap).concat(conv.cons);
      }
      const f = filletPolyline(s, c.k, c.res);
      d.entities[idx] = f.ent;
      d.constraints = remapConstraints(d.constraints, s.id, f.remap).concat(
        { type: 'tangent', refs: [`${s.id}:${f.prevSeg}`, `${s.id}:${f.arc}`] },
        { type: 'tangent', refs: [`${s.id}:${f.nextSeg}`, `${s.id}:${f.arc}`] },
        { type: 'radius', refs: [`${s.id}:${f.arc}`], value: rText });
    });
  }

  _applyTrim(t) {
    const pieces = t.r.pieces.filter(Boolean).map((p) => ({ ...p, id: newId('e') }));
    const id = t.ent.id;
    const dropped = (this.app.activeSketch().constraints || []).filter((c) => c.refs.some((r) => r.startsWith(`${id}:`))).length;
    this.app.commitSketch('Trim', (d) => {
      const i = d.entities.findIndex((x) => x.id === id);
      d.entities.splice(i, 1, ...pieces);
      d.constraints = d.constraints.filter((c) => !c.refs.some((r) => r.startsWith(`${id}:`)));
    });
    if (dropped) toast(`Removed ${dropped} constraint${dropped > 1 ? 's' : ''} on the trimmed curve`, 'info', 2200);
  }

  _applyProject(hit) {
    const frame = this.ctx.frame;
    const entry = this.vp.bodies.get(hit.bodyId);
    const info = hit.info, P = entry.data.edgePts;
    const local = [];
    for (let i = 0; i < info.count; i++) { const k = (info.start + i) * 3; local.push(toLocal(frame, this.vp.toWorldOf(hit.bodyId, [P[k], P[k + 1], P[k + 2]]))); }
    const first = local[0], last = local[local.length - 1];
    const closedEdge = Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-6;
    let ent = null;
    if (info.type === 'LINE') ent = { type: 'line', x1: num(first[0]), y1: num(first[1]), x2: num(last[0]), y2: num(last[1]) };
    else if (info.type === 'CIRCLE') {
      const circ = this.vp.circleOf(entry, hit.index);
      const axis = circ && this.vp.toWorldOf(hit.bodyId, circ.axis, true);
      const flat = axis && Math.abs(axis[0] * frame.normal[0] + axis[1] * frame.normal[1] + axis[2] * frame.normal[2]) > 0.999;
      if (flat && closedEdge) {
        const c = toLocal(frame, this.vp.toWorldOf(hit.bodyId, circ.c));
        ent = { type: 'circle', cx: num(c[0]), cy: num(c[1]), d: num(2 * circ.r) };
      } else if (flat) {
        const mid = local[Math.floor(local.length / 2)];
        ent = { type: 'polyline', pts: [[num(first[0]), num(first[1])], [num(last[0]), num(last[1])]], bulges: [fmt(bulgeFromThreePoints(first, mid, last), 9)], closed: false };
      }
    }
    if (!ent) {
      const pts = (closedEdge ? local.slice(0, -1) : local).map(([x, y]) => [num(x), num(y)]);
      if (pts.length < 2) return;
      ent = { type: 'polyline', pts, bulges: pts.map(() => '0').slice(0, closedEdge ? pts.length : pts.length - 1), closed: closedEdge };
    }
    this._commit(ent, []);
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
      if (el.kind === 'circle') {
        if (ent.type === 'polyline') return addCons('radius', [ref]);
        return lockField(ent.id, ent.type === 'circle' ? 'd' : 'w');
      }
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
      if (T === 'line') {
        const prims = [];
        for (let i = 1; i < n; i++) prims.push({ k: this.meta[i].bulge ? 'A' : 'L', a: this.pts[i - 1], b: this.pts[i], bulge: this.meta[i].bulge || 0 });
        const live = this._chainBulge(c, true);
        if (Math.hypot(c[0] - this.pts[n - 1][0], c[1] - this.pts[n - 1][1]) > 1e-9) prims.push({ k: live ? 'A' : 'L', a: this.pts[n - 1], b: c, bulge: live });
        if (prims.length) items.push({ pts: primsOutline(prims, false), color: col });
      }
      if (T === 'arc') {
        if (n === 1) items.push({ pts: [a, c], color: col, dashed: true });
        else {
          const b = this.pts[1];
          const bu = bulgeFromThreePoints(a, c, b);
          items.push({ pts: Math.abs(bu) > 1e-9 ? primsOutline([{ k: 'A', a, b, bulge: bu }], false) : [a, b], color: col });
        }
      }
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
    const arcBadge = this.tool === 'line' && this.arcMode;
    if (!this.active || this.tool === 'select' || this.picking || !this.cursor || !this._lastClient || (!this.fields.length && !arcBadge)) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const wrap = el.parentElement.getBoundingClientRect();
    el.style.left = `${this._lastClient[0] - wrap.left}px`;
    el.style.top = `${this._lastClient[1] - wrap.top}px`;
    el.innerHTML = (arcBadge ? '<div class="hud-field locked"><b>Arc</b>tangent · A</div>' : '') + this.fields.map((f, i) => {
      const val = f.locked ? (f.text || '') : fmt(f.value, 2);
      const unit = f.unit === '°' ? '°' : '';
      return `<div class="hud-field${i === this.activeField ? ' active' : ''}${f.locked ? ' locked' : ''}"><b>${f.label}</b>${escapeHtml(val)}${unit}</div>`;
    }).join('');
  }
}

function escapeHtml(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

/**
 * Rectangle / polygon → closed polyline (same id) so its corners can be rounded or trimmed.
 * Keeps the shape's intent as constraints (H/V sides, driving width/height, equal polygon sides).
 */
function toPolyline(s, e) {
  const prims = primsOf(e).prims;
  const pts = prims.map((p) => [num(p.a[0]), num(p.a[1])]);
  const ent = { id: s.id, type: 'polyline', pts, bulges: pts.map(() => '0'), closed: true };
  if (s.construction) ent.construction = true;
  if (s.fixed) ent.fixed = true;
  const remap = (part) => (/^v\d+$/.test(part) || /^s\d+$/.test(part) ? part : /^e\d+$/.test(part) ? `s${part.slice(1)}` : null);
  const cons = [];
  if (s.type === 'rect') {
    cons.push({ type: 'horizontal', refs: [`${s.id}:s0`] }, { type: 'vertical', refs: [`${s.id}:s1`] }, { type: 'horizontal', refs: [`${s.id}:s2`] }, { type: 'vertical', refs: [`${s.id}:s3`] });
    const locked = new Set(s.locked || []);
    const drives = (k) => locked.has(k) || !isLiteral(s[k]);
    const abs = (v) => (isLiteral(v) ? num(Math.abs(parseFloat(v))) : `abs(${v})`);
    if (drives('w')) cons.push({ type: 'length', refs: [`${s.id}:s0`], value: abs(s.w) });
    if (drives('h')) cons.push({ type: 'length', refs: [`${s.id}:s1`], value: abs(s.h) });
  } else if (s.type === 'polygon') {
    for (let i = 1; i < pts.length; i++) cons.push({ type: 'equal', refs: [`${s.id}:s0`, `${s.id}:s${i}`] });
  }
  return { ent, remap, cons };
}

/** Replace polyline vertex k by a tangent fillet arc (res from filletCorner). */
function filletPolyline(s, k, res) {
  const n = s.pts.length, closed = !!s.closed;
  const segs = closed ? n : n - 1;
  const bulges = Array.from({ length: segs }, (_, i) => (s.bulges && s.bulges[i] != null ? s.bulges[i] : '0'));
  const T1 = [num(res.t1[0]), num(res.t1[1])], T2 = [num(res.t2[0]), num(res.t2[1])];
  const ab = fmt(res.bulge, 9);
  let pts, nb, remap, lockMap, prevSeg, nextSeg, arc;
  if (closed && k === 0) {
    pts = [T2, ...s.pts.slice(1), T1];
    nb = [...bulges, ab];
    remap = (part) => (part === 'v0' ? null : part);
    lockMap = (key) => (/^pts\.0\./.test(key) ? null : key);
    prevSeg = `s${n - 1}`; nextSeg = 's0'; arc = `a${n}`;
  } else {
    pts = [...s.pts.slice(0, k), T1, T2, ...s.pts.slice(k + 1)];
    nb = [...bulges.slice(0, k), ab, ...bulges.slice(k)];
    remap = (part) => {
      const m = /^(v|s|a|ac)(\d+)$/.exec(part);
      if (!m) return part;
      const j = +m[2];
      if (m[1] === 'v') return j < k ? part : j === k ? null : `v${j + 1}`;
      return j < k ? part : `${m[1]}${j + 1}`;
    };
    lockMap = (key) => {
      const m = /^(pts|bulges)\.(\d+)(\..*)?$/.exec(key);
      if (!m) return key;
      const j = +m[2];
      if (m[1] === 'pts') return j < k ? key : j === k ? null : `pts.${j + 1}${m[3]}`;
      return j < k ? key : `bulges.${j + 1}`;
    };
    prevSeg = `s${k - 1}`; nextSeg = `s${k + 1}`; arc = `a${k}`;
  }
  const ent = { ...s, pts, bulges: nb };
  if (s.locked) { ent.locked = s.locked.map(lockMap).filter(Boolean); if (!ent.locked.length) delete ent.locked; }
  return { ent, remap, prevSeg, nextSeg, arc };
}

/** Rewrite (or drop) constraint references after an entity's vertices were renumbered. */
function remapConstraints(list, entId, remap) {
  const out = [];
  for (const c of list) {
    let ok = true;
    const refs = c.refs.map((r) => {
      if (!r.startsWith(`${entId}:`)) return r;
      const np = remap(r.slice(entId.length + 1));
      if (!np) { ok = false; return r; }
      return `${entId}:${np}`;
    });
    if (ok) out.push({ ...c, refs });
  }
  return out;
}

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
