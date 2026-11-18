// Application controller: document, history, commands, picking and rebuilds.
import { FEATURES, newDoc, newId, nextName, activeFeatures } from './model/features.js';
import { evaluateParams, tryEvaluate } from './model/expr.js';
import { sketchDimensions, sketchGlyphs } from './viewer/dimensions.js';
import { solveSketch, elementTable, CONSTRAINTS } from './model/constraints.js';
import { evalEntity, computeRegions } from './model/profiles.js';
import { planeFrame, framesForFace, STD_PLANES, dist } from './model/geom.js';
import { BODY_COLORS } from './viewer/viewport.js';
import { toast, download } from './ui/dom.js';
import { exampleDoc } from './model/example.js';
import { library, newDocId } from './model/library.js';
import { newAssembly } from './model/assembly.js';
import { AssemblyController, exampleAssembly } from './assembly/controller.js';

const clone = (o) => JSON.parse(JSON.stringify(o));

export class App {
  constructor({ kernel, viewport }) {
    this.kernel = kernel;
    this.vp = viewport;
    this.listeners = new Map();
    this.doc = newDoc();
    this.scope = {};
    this.result = { bodies: [], errors: {}, warnings: {} };
    this.mode = 'model';
    this.sketchId = null;
    this.cmd = null;
    this.selection = new Set();
    this.undoStack = [];
    this.redoStack = [];
    this.sketchCache = new Map();
    this.busy = false;
    this.measure = null;
    this.suggestion = null;
    this.returnTo = null;
    this.selectedJoint = null;
    this.asm = new AssemblyController(this);
    viewport.onPick = (hit, e) => this.handlePick(hit, e);
    viewport.onContext = (hit, e) => this.emit('context', { hit, event: e });
  }

  get isAssembly() { return this.doc.kind === 'assembly'; }

  // ------------------------------------------------------------ events
  on(evt, fn) { if (!this.listeners.has(evt)) this.listeners.set(evt, new Set()); this.listeners.get(evt).add(fn); return () => this.listeners.get(evt).delete(fn); }
  emit(evt, data) { for (const fn of this.listeners.get(evt) || []) fn(data); for (const fn of this.listeners.get('*') || []) fn(evt, data); }

  // ------------------------------------------------------------ document + history
  load(doc, { keepHistory = false } = {}) {
    this.doc = { ...newDoc(), ...clone(doc) };
    if (!this.doc.id) this.doc.id = newDocId();
    if (!keepHistory) { this.undoStack = []; this.redoStack = []; }
    this.mode = 'model'; this.sketchId = null; this.cmd = null; this.selection.clear(); this.measure = null; this.suggestion = null; this.selectedJoint = null;
    this.result = { bodies: [], errors: {}, warnings: {} };
    this.vp.setMarkers?.([]);
    this.vp.pickFilter = 'idle';
    if (this.isAssembly) this.asm.onLoad();
    library.setCurrent(this.doc.id);
    this._afterDocChange();
    this.emit('mode');
    this.emit('command');
  }

  _afterDocChange() {
    this.scope = evaluateParams(this.doc.params);
    this.sketchCache.clear();
    this.emit('doc');
    this.refreshSketches();
    this.requestRebuild();
  }

  /** Apply a change to the document as one undoable step. */
  commit(label, mutate, { rebuild = true } = {}) {
    const before = JSON.stringify(this.doc);
    mutate(this.doc);
    if (JSON.stringify(this.doc) === before) return;
    this.undoStack.push({ label, doc: before });
    if (this.undoStack.length > 150) this.undoStack.shift();
    this.redoStack = [];
    if (rebuild) this._afterDocChange();
    else { this.emit('doc'); this.refreshSketches(); this.applyBodyStyles(); }
    this.autosave();
  }

  undo() {
    if (this.cmd) return this.cancelCommand();
    const s = this.undoStack.pop();
    if (!s) return toast('Nothing to undo', 'info', 1500);
    this.redoStack.push({ label: s.label, doc: JSON.stringify(this.doc) });
    this._restore(s.doc);
    toast(`Undid: ${s.label}`, 'info', 1600);
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return toast('Nothing to redo', 'info', 1500);
    this.undoStack.push({ label: s.label, doc: JSON.stringify(this.doc) });
    this._restore(s.doc);
    toast(`Redid: ${s.label}`, 'info', 1600);
  }

  _restore(json) {
    this.doc = JSON.parse(json);
    if (this.mode === 'sketch' && !this.doc.features.some((f) => f.id === this.sketchId)) { this.mode = 'model'; this.sketchId = null; this.emit('mode'); }
    for (const id of [...this.selection]) this.selection.delete(id);
    this._afterDocChange();
    this.autosave();
  }

  /** Every design autosaves into "My designs" (this browser's library). */
  autosave() {
    clearTimeout(this._saveTimer);
    this.emit('saveState', 'Saving…');
    this._saveTimer = setTimeout(() => this.flushSave(), 350);
  }

  flushSave() {
    clearTimeout(this._saveTimer);
    const ok = library.put(this.doc);
    library.setCurrent(this.doc.id);
    this.emit('saveState', ok ? 'Saved to My designs' : 'Not saved (browser storage full?)');
  }

  restoreAutosave() {
    library.migrate();
    const d = library.get(library.getCurrent());
    if (d && d.format === 'fusion720') { this.load(d); return true; }
    return false;
  }

  /** Open a design from the library by id (saving the current one first). */
  openDesign(id) {
    const d = library.get(id);
    if (!d) { toast('That design is no longer in My designs', 'err'); return; }
    if (this.doc.features.length || (this.doc.components || []).length) this.flushSave();
    if (this.returnTo && this.returnTo.id === id) this.returnTo = null;
    this.load(d);
    this.emit('returnTo');
    setTimeout(() => this.vp.setView('home'), 400);
  }

  newAssemblyDoc() {
    if (this.doc.features.length || (this.doc.components || []).length) this.flushSave();
    this.returnTo = null;
    this.load(newAssembly());
    this.flushSave();
    this.emit('returnTo');
    this.vp.setView('home');
  }

  loadExampleAssembly() {
    if (this.doc.features.length || (this.doc.components || []).length) this.flushSave();
    const existing = library.get('ex-assembly');
    this.load(existing || exampleAssembly());
    this.flushSave();
    setTimeout(() => this.vp.setView('home'), 600);
  }

  // ------------------------------------------------------------ rebuild
  featuresForRebuild() {
    let feats = this.doc.features.slice();
    let end = this.doc.marker == null ? feats.length : this.doc.marker;
    const c = this.cmd;
    if (this.mode === 'sketch') {
      const i = feats.findIndex((f) => f.id === this.sketchId);
      if (i >= 0) end = i + 1;
    } else if (c && c.draft) {
      const pickingBase = c.pick && (c.pick === 'edges' || c.pick === 'faces');
      if (c.editId) {
        const i = feats.findIndex((f) => f.id === c.editId);
        feats[i] = c.draft;
        end = pickingBase ? i : i + 1;
      } else {
        if (!pickingBase) feats.splice(end, 0, c.draft);
        if (!pickingBase) end += 1;
      }
    }
    return feats.slice(0, end);
  }

  requestRebuild() {
    if (!this.kernel.isReady) { this._pendingRebuild = true; return; }
    if (this.isAssembly) { this.asm.rebuild(); return; }
    const features = this.featuresForRebuild();
    this.busy = true;
    this.emit('busy', true);
    this.kernel.rebuild({ params: this.doc.params, features, quality: 'normal' }).then((r) => {
      if (!r) return;
      this.busy = this.kernel.running || !!this.kernel.queued;
      this.result = r;
      this.applyBodyStyles();
      this.emit('result', r);
      this.emit('busy', this.busy);
      if (this._okWhenIdle && !this.busy) { this._okWhenIdle = false; this.okCommand(); }
    }).catch((e) => { this.busy = false; this.emit('busy', false); toast(e.message, 'err'); });
  }

  kernelReady() {
    this.requestRebuild();
  }

  // ------------------------------------------------------------ bodies
  bodyMeta(id) { return this.doc.bodies[id] || {}; }
  bodyName(id) {
    const m = this.bodyMeta(id);
    if (m.name) return m.name;
    const b = this.result.bodies.find((x) => x.id === id);
    return b ? `Body${b.n}` : 'Body';
  }
  bodyColor(id) {
    const m = this.bodyMeta(id);
    if (m.color) return m.color;
    const b = this.result.bodies.find((x) => x.id === id);
    return BODY_COLORS[((b ? b.n : 1) - 1) % BODY_COLORS.length];
  }
  bodyVisible(id) { return this.bodyMeta(id).visible !== false; }

  applyBodyStyles() {
    if (this.isAssembly) { this.asm.applyStyles(); return; }
    const draftNew = this.cmd && this.cmd.draft && !this.cmd.editId ? `b:${this.cmd.draft.id}` : null;
    this.vp.setBodies(this.result.bodies.map((b) => ({
      id: b.id, data: b, color: b.id.startsWith(draftNew || '\u0000') ? '#7fb0ff' : this.bodyColor(b.id),
      visible: this.bodyVisible(b.id) || (this.cmd && b.id.startsWith(draftNew || '\u0000')),
    })));
    this.updateHighlights();
  }

  setBodyMeta(id, patch, label = 'Edit body') {
    this.commit(label, (d) => { d.bodies[id] = { ...(d.bodies[id] || {}), ...patch }; }, { rebuild: false });
  }

  // ------------------------------------------------------------ sketches
  sketchEval(f) {
    const key = JSON.stringify([f.entities, f.plane, f.constraints]);
    const c = this.sketchCache.get(f.id);
    if (c && c.key === key) return c.value;
    const ents = f.entities.map((e) => evalEntity(e, this.scope));
    const value = { id: f.id, feature: f, frame: planeFrame(f.plane, this.scope), ents, regions: computeRegions(ents), table: elementTable(ents) };
    // constraint status (degrees of freedom, fully-constrained entities, conflicts) — only needed while editing
    Object.defineProperty(value, 'status', {
      configurable: true,
      get: () => {
        const r = solveSketch({ entities: f.entities, constraints: f.constraints || [] }, this.scope);
        const st = { dof: r.dof, determined: r.determined, conflictEnts: r.conflictEnts, failing: r.failing, ok: r.ok };
        Object.defineProperty(value, 'status', { value: st });
        return st;
      },
    });
    this.sketchCache.set(f.id, { key, value });
    return value;
  }

  activeSketch() { return this.doc.features.find((f) => f.id === this.sketchId); }
  activeSketchContext() { const f = this.activeSketch(); return f ? this.sketchEval(f) : null; }

  consumedSketches() {
    const s = new Set();
    for (const f of this.doc.features) if ((f.type === 'extrude' || f.type === 'revolve') && f.sketch) s.add(f.sketch);
    return s;
  }

  sketchVisible(f) {
    const v = f.visible;
    if (v === true || v === false) return v;
    return !this.consumedSketches().has(f.id);
  }

  refreshSketches() {
    if (this.isAssembly) { this.vp.setSketches([]); this.vp.setDimensions(null); this.vp.setGlyphs(null); return; }
    const list = [];
    const c = this.cmd;
    const active = activeFeatures(this.doc);
    const sk = this.sketcher;
    if (this.mode === 'sketch') {
      const f = this.activeSketch();
      if (f) {
        const s0 = this.sketchEval(f);
        const ov = this.sketchOverride;
        const s = ov ? { ...s0, ents: ov, regions: computeRegions(ov) } : s0;
        list.push({ ...s, active: true, status: s0.status, selectedEnts: sk?.selected, hoverEnt: sk?.hoverEnt, showProfiles: true });
        if (sk?.showDims && !ov) {
          this.vp.setDimensions(s.frame, sketchDimensions(s0, f, sk.selected), {
            onEdit: (dim, text) => this.applyDimension(dim, text),
            onRemove: (dim) => dim.remove && this.applySketchAction(dim.remove(), 'Remove dimension'),
          });
        } else this.vp.setDimensions(null);
        if (!ov) {
          this.vp.setGlyphs(s.frame, sketchGlyphs(s0, f, sk?.selectedCons || new Set()), {
            onClick: (cid, e) => sk?.selectConstraint(cid, e.shiftKey || e.ctrlKey),
            onContext: (cid) => this.removeConstraints([cid]),
            onHover: (cid) => sk?.highlightConstraint(cid),
          });
        } else this.vp.setGlyphs(null);
      }
    } else {
      this.vp.setDimensions(null);
      this.vp.setGlyphs(null);
      const pickingProfiles = c && c.pick === 'profiles';
      const pool = c && c.editId ? this.doc.features.slice(0, this.doc.features.findIndex((f) => f.id === c.editId)) : active;
      for (const f of pool) {
        if (f.type !== 'sketch') continue;
        const isDraftSketch = c && c.draft && c.draft.sketch === f.id;
        if (!this.sketchVisible(f) && !pickingProfiles && !isDraftSketch) continue;
        const s = this.sketchEval(f);
        list.push({
          ...s, active: false,
          showProfiles: pickingProfiles || isDraftSketch || !c,
          selectedRegions: isDraftSketch ? new Set(c.draft.profiles) : null,
          hoverRegion: this.vp.hover && this.vp.hover.kind === 'profile' && this.vp.hover.sketchId === f.id ? this.vp.hover.regionId : null,
        });
      }
    }
    this.vp.setSketches(list);
  }

  // ------------------------------------------------------------ sketch mode
  startSketchFlow() {
    if (this.mode === 'sketch') return;
    if (this.isAssembly) { toast('Sketches live in parts. Open a part (right-click a component → Edit part) to model it.', 'info', 3500); return; }
    this.cancelCommand(true);
    this.cmd = { type: 'sketchPlane' };
    this.vp.showOriginPlanes(true);
    this.vp.pickFilter = 'sketchPlane';
    this.emit('command');
  }

  createSketch(plane) {
    const f = { id: newId('s'), type: 'sketch', name: nextName(this.doc, 'sketch'), plane, entities: [] };
    this.vp.showOriginPlanes(false);
    this.cmd = null;
    this.commit('Create sketch', (d) => this._insertFeature(d, f));
    this.enterSketch(f.id, true);
  }

  _insertFeature(d, f) {
    const at = d.marker == null ? d.features.length : d.marker;
    d.features.splice(at, 0, f);
    if (d.marker != null) d.marker = at + 1;
  }

  enterSketch(id, isNew = false) {
    this.cancelCommand(true);
    this.mode = 'sketch';
    this.sketchId = id;
    this.selection.clear();
    this.suggestion = null;
    const ctx = this.activeSketchContext();
    this.vp.grid.setFrame(ctx.frame);
    this.vp.lookAtFrame(ctx.frame);
    this.vp.pickFilter = 'none';
    this.sketcher.selected.clear();
    this.sketcher.setTool(isNew ? 'line' : 'select');
    this.emit('mode');
    this.emit('command');
    this.refreshSketches();
    this.requestRebuild();
  }

  finishSketch() {
    if (this.mode !== 'sketch') return;
    const f = this.activeSketch();
    this.sketcher.reset();
    this.sketcher.selected.clear();
    this.mode = 'model';
    this.sketchId = null;
    this.vp.grid.setFrame({ origin: [0, 0, 0], xDir: [1, 0, 0], yDir: [0, 1, 0], normal: [0, 0, 1] });
    this.vp.pickFilter = 'idle';
    this.vp.renderer.domElement.style.cursor = '';
    if (f && !f.entities.length) {
      const top = this.undoStack[this.undoStack.length - 1];
      if (top && top.label === 'Create sketch' && !JSON.parse(top.doc).features.some((x) => x.id === f.id)) {
        this.undoStack.pop();
        this.doc = JSON.parse(top.doc);
        this._afterDocChange();
        this.autosave();
      } else {
        this.commit('Delete empty sketch', (d) => {
          const i = d.features.findIndex((x) => x.id === f.id);
          d.features.splice(i, 1);
          if (d.marker != null && d.marker > i) d.marker -= 1;
        });
      }
    } else if (f) {
      const regions = this.sketchEval(f).regions;
      if (regions.length) this.suggestion = { sketchId: f.id };
    }
    this.emit('mode');
    this.emit('command');
    this.refreshSketches();
    this.requestRebuild();
  }

  /**
   * Change the active sketch, re-solve its constraints and commit as one undo step.
   * strict: refuse the change if it creates new constraint conflicts.
   */
  commitSketch(label, mutate, { strict = false, sketchId = this.sketchId } = {}) {
    const f0 = this.doc.features.find((f) => f.id === sketchId);
    if (!f0) return { ok: false };
    const draft = clone(f0);
    draft.constraints = draft.constraints || [];
    mutate(draft);
    draft.constraints = draft.constraints.map((c) => (c.id ? c : { ...c, id: newId('k') }));
    const before = this.sketchEval(f0).status.failing.size;
    const res = solveSketch(draft, this.scope);
    if (strict && res.failing.size > before) return { ok: false, res };
    draft.entities = res.entities;
    if (res.invalid.length) draft.constraints = draft.constraints.filter((c) => !res.invalid.includes(c.id));
    this.commit(label, (d) => { d.features[d.features.findIndex((x) => x.id === sketchId)] = draft; });
    return { ok: true, res };
  }

  addSketchEntity(ent, constraints = []) {
    const label = `Add ${ent.type}`;
    if (constraints.length) {
      const r = this.commitSketch(label, (d) => { d.entities.push(ent); d.constraints.push(...constraints.map((c) => ({ id: newId('k'), ...c }))); }, { strict: true });
      if (r.ok) return;
    }
    this.commitSketch(label, (d) => { d.entities.push(ent); });
  }

  updateSketchEntities(ids, fn, label = 'Edit sketch') {
    return this.commitSketch(label, (d) => { d.entities = d.entities.map((e) => (ids.includes(e.id) ? fn(e) : e)); });
  }

  /** Set entity fields as driving dimensions (locked) and re-solve. */
  setEntityFields(id, patch, label = 'Edit dimension') {
    const r = this.applySketchAction({ ent: id, patch, lock: Object.keys(patch) }, label, true);
    if (!r.ok) toast('That value conflicts with the sketch constraints', 'err');
    return r;
  }

  /** Actions produced by dimensions: field edits/locks, constraint values, new or removed constraints. */
  applySketchAction(a, label, strict = false) {
    return this.commitSketch(label, (d) => {
      if (a.ent) {
        d.entities = d.entities.map((e) => {
          if (e.id !== a.ent) return e;
          const o = { ...e, ...(a.patch || {}) };
          const locked = new Set(e.locked || []);
          for (const k of a.lock || []) locked.add(k);
          for (const k of a.unlock || []) locked.delete(k);
          if (locked.size) o.locked = [...locked]; else delete o.locked;
          return o;
        });
      }
      if (a.cons) d.constraints = d.constraints.map((c) => (c.id === a.cons ? { ...c, value: a.value } : c));
      if (a.add) d.constraints.push({ id: newId('k'), ...a.add });
      if (a.delCons) d.constraints = d.constraints.filter((c) => c.id !== a.delCons);
    }, { strict });
  }

  /** Apply a value typed into an on-canvas sketch dimension. */
  applyDimension(dim, text) {
    const r = tryEvaluate(text, this.scope);
    if (r.error) { toast(`${text}: ${r.error}`, 'err'); return; }
    if (dim.positive && !(r.value > 0)) { toast('That dimension must be greater than zero', 'err'); return; }
    const res = this.applySketchAction(dim.edit(text, r.value), 'Edit dimension', true);
    if (!res.ok) toast('That value can’t be reached with the current constraints', 'err');
  }

  addConstraint(c) {
    const def = CONSTRAINTS[c.type];
    const r = this.commitSketch(`Add ${def ? def.label.toLowerCase() : 'constraint'}`, (d) => { d.constraints.push({ id: newId('k'), ...c }); }, { strict: true });
    if (!r.ok) toast('That constraint conflicts with existing constraints or dimensions', 'warn');
    return r.ok;
  }

  removeConstraints(ids) {
    if (!ids.length) return;
    this.commitSketch(ids.length > 1 ? `Delete ${ids.length} constraints` : 'Delete constraint', (d) => { d.constraints = d.constraints.filter((c) => !ids.includes(c.id)); });
    this.sketcher?.selectedCons.clear();
    this.emit('sketchSelection');
  }

  toggleFix(ids) {
    const f = this.activeSketch();
    const allFixed = f.entities.filter((e) => ids.includes(e.id)).every((e) => e.fixed);
    this.commitSketch(allFixed ? 'Unfix' : 'Fix', (d) => {
      d.entities = d.entities.map((e) => { if (!ids.includes(e.id)) return e; const o = { ...e }; if (allFixed) delete o.fixed; else o.fixed = true; return o; });
    });
  }

  /** Live solve while dragging (not committed). spec: { entities?, drag?, stiffIds? } */
  dragSolve(spec) {
    const f = this.activeSketch();
    const res = solveSketch({ entities: spec.entities || f.entities, constraints: f.constraints || [] }, this.scope,
      { drag: spec.drag, stiff: (id) => (spec.stiffIds && spec.stiffIds.has(id) ? 60 : 1) });
    this.sketchOverride = res.numeric;
    this.refreshSketches();
    return res;
  }

  endDrag(res, label = 'Move sketch geometry') {
    this.sketchOverride = null;
    if (res) this.commitSketch(label, (d) => { d.entities = res.entities; });
    else this.refreshSketches();
  }

  removeSketchEntities(ids) {
    const used = (ref) => ids.some((id) => ref.startsWith(`${id}:`));
    this.commitSketch(ids.length > 1 ? `Delete ${ids.length} entities` : 'Delete entity', (d) => {
      d.entities = d.entities.filter((e) => !ids.includes(e.id));
      d.constraints = d.constraints.filter((c) => !c.refs.some(used));
    });
    this.emit('sketchSelection');
  }

  // ------------------------------------------------------------ feature commands
  startCommand(type, preset = {}) {
    if (this.isAssembly) { toast('That is a part tool. In an assembly, insert parts and join them — or right-click a component → Edit part.', 'info', 3500); return; }
    if (this.mode === 'sketch') this.finishSketch();
    this.cancelCommand(true);
    const def = FEATURES[type];
    const draft = { id: newId('f'), type, name: nextName(this.doc, type), ...def.defaults(), ...preset };
    if (def.needsSketch && !draft.sketch) {
      const sketches = activeFeatures(this.doc).filter((f) => f.type === 'sketch');
      const withRegions = sketches.filter((f) => this.sketchEval(f).regions.length);
      if (!withRegions.length) {
        toast('Draw a sketch with a closed profile first — use Sketch, then Rectangle or Circle.', 'warn', 4500);
        return;
      }
      const pref = (this.suggestion && withRegions.find((f) => f.id === this.suggestion.sketchId)) || withRegions[withRegions.length - 1];
      draft.sketch = pref.id;
      const regions = this.sketchEval(pref).regions;
      if (regions.length === 1 || (this.suggestion && this.suggestion.sketchId === pref.id)) {
        const top = regions.filter((r) => !regions.some((o) => o.children.includes(r.id)));
        draft.profiles = (top.length ? top : regions).map((r) => r.id);
      }
    }
    if (['move', 'mirror', 'pattern', 'remove'].includes(type) && this.selection.size) draft.bodies = [...this.selection];
    if (type === 'combine' && this.selection.size) { const s = [...this.selection]; draft.target = [s[0]]; draft.tools = s.slice(1); }
    this.suggestion = null;
    this.cmd = { type, draft, editId: null, pick: null };
    this._autoPick();
    this._enterCommand();
  }

  editFeature(id) {
    const f = this.doc.features.find((x) => x.id === id);
    if (!f) return;
    if (f.type === 'sketch') return this.enterSketch(id);
    if (this.mode === 'sketch') this.finishSketch();
    this.cancelCommand(true);
    this.cmd = { type: f.type, draft: clone(f), editId: id, pick: null };
    this._enterCommand();
  }

  _autoPick() {
    const def = FEATURES[this.cmd.type];
    const first = (def.fields || []).find((fl) => fl.kind === 'pick' && !fl.optional && !(this.cmd.draft[fl.key] || []).length);
    this.cmd.pick = first ? first.pick : null;
    this.cmd.pickKey = first ? first.key : null;
  }

  _enterCommand() {
    this.selection.clear();
    this.vp.pickFilter = this._pickFilter();
    this.emit('command');
    this.emit('selection');
    this.refreshSketches();
    this.requestRebuild();
  }

  _pickFilter() {
    const c = this.cmd;
    if (!c) return 'idle';
    if (c.type === 'sketchPlane') return 'sketchPlane';
    if (c.type === 'measure') return 'measure';
    return { profiles: 'profiles', edges: 'edges', faces: 'faces', bodies: 'bodies', body: 'bodies' }[c.pick] || 'none';
  }

  setPickField(key) {
    const c = this.cmd;
    if (!c || !c.draft) return;
    const fl = (FEATURES[c.type].fields || []).find((x) => x.key === key);
    const was = c.pick;
    if (!fl || c.pickKey === key) { c.pick = null; c.pickKey = null; } else { c.pick = fl.pick; c.pickKey = key; }
    this.vp.pickFilter = this._pickFilter();
    this.emit('command');
    this.refreshSketches();
    const baseChanged = ['edges', 'faces'].includes(was) !== ['edges', 'faces'].includes(c.pick);
    if (baseChanged) this.requestRebuild(); else this.updateHighlights();
  }

  updateDraft(patch) {
    if (!this.cmd || !this.cmd.draft) return;
    Object.assign(this.cmd.draft, patch);
    this.emit('draft');
    this.refreshSketches();
    this.requestRebuild();
  }

  okCommand() {
    const c = this.cmd;
    if (c && c.type === 'joint') { this.asm.okJoint(); return; }
    if (!c || !c.draft) return;
    if (this.busy) { this._okWhenIdle = true; return; }
    const err = this.result.errors[c.draft.id];
    if (err && c.pick !== 'edges' && c.pick !== 'faces') { toast(err, 'err'); return; }
    const draft = clone(c.draft);
    this.cmd = null;
    this.vp.pickFilter = 'idle';
    if (c.editId) this.commit(`Edit ${draft.name}`, (d) => { const i = d.features.findIndex((f) => f.id === c.editId); d.features[i] = draft; });
    else this.commit(`Add ${draft.name}`, (d) => this._insertFeature(d, draft));
    this.emit('command');
  }

  cancelCommand(silent = false) {
    const c = this.cmd;
    if (!c) return;
    this.cmd = null;
    this.vp.showOriginPlanes(false);
    this.vp.setMeasure(null, null);
    this.vp.setLabels([]);
    this.measure = null;
    this.vp.pickFilter = this.mode === 'sketch' ? 'none' : 'idle';
    this.emit('command');
    this.refreshSketches();
    if (c.type === 'joint') this.asm.afterCancel();
    else if (c.draft) this.requestRebuild();
    else this.applyBodyStyles();
    if (!silent) this.emit('selection');
  }

  // ------------------------------------------------------------ picking
  handlePick(hit, e) {
    const c = this.cmd;
    const multi = e && (e.shiftKey || e.ctrlKey || e.metaKey);
    if (this.mode === 'sketch') return;
    if (this.isAssembly && !(c && c.type === 'measure')) { this.asm.handlePick(hit, e); return; }
    if (c && c.type === 'sketchPlane') {
      if (!hit) return;
      if (hit.kind === 'plane') return this.createSketch({ type: 'std', name: hit.plane, offset: '0' });
      if (hit.kind === 'face' && hit.info.planar) {
        const fr = framesForFace(hit.info.center, hit.info.normal);
        return this.createSketch({ ...fr, origin: fr.origin.map((v) => +v.toFixed(6)) });
      }
      return;
    }
    if (c && c.type === 'measure') return this._measurePick(hit);
    if (c && c.draft) {
      if (!c.pick) {
        // clicking a profile while not picking still toggles profiles for convenience
        if (hit && hit.kind === 'profile' && FEATURES[c.type].needsSketch) { this.cmd.pick = 'profiles'; this.cmd.pickKey = 'profiles'; }
        else return;
      }
      if (!hit) return;
      const d = c.draft;
      const key = c.pickKey;
      if (c.pick === 'profiles' && hit.kind === 'profile') {
        if (d.sketch !== hit.sketchId) this.updateDraft({ sketch: hit.sketchId, profiles: [hit.regionId] });
        else this.updateDraft({ profiles: toggle(d.profiles, hit.regionId) });
      } else if (c.pick === 'edges' && hit.kind === 'edge') {
        const ref = { body: hit.bodyId, p: hit.info.mid, np: hit.info.np, adj: hit.info.adj, dir: hit.info.dir, type: hit.info.type, len: hit.info.len };
        const list = d[key] || [];
        const i = list.findIndex((r) => r.body === ref.body && dist(r.p, ref.p) < 1e-4);
        this.updateDraft({ [key]: i >= 0 ? list.filter((_, j) => j !== i) : [...list, ref] });
      } else if (c.pick === 'faces' && hit.kind === 'face') {
        const info = hit.info;
        const bb = this.vp.bodies.get(hit.bodyId)?.data.bbox;
        const np = bb ? [0, 1, 2].map((k) => (info.center[k] - bb[0][k]) / Math.max(bb[1][k] - bb[0][k], 1e-6)) : undefined;
        const ref = { body: hit.bodyId, p: info.center, np, n: info.normal, planar: info.planar, size: info.size };
        const list = d[key] || [];
        const i = list.findIndex((r) => r.body === ref.body && dist(r.p, ref.p) < 1e-4);
        this.updateDraft({ [key]: i >= 0 ? list.filter((_, j) => j !== i) : [...list, ref] });
      } else if ((c.pick === 'bodies' || c.pick === 'body') && hit.kind === 'body') {
        if (d.id && hit.bodyId.startsWith(`b:${d.id}`)) return;
        const list = d[key] || [];
        if (c.pick === 'body') this.updateDraft({ [key]: [hit.bodyId] });
        else this.updateDraft({ [key]: toggle(list, hit.bodyId) });
      }
      this.updateHighlights();
      return;
    }
    // idle selection
    if (hit && (hit.kind === 'face' || hit.kind === 'body')) {
      const id = hit.bodyId;
      if (multi) { if (this.selection.has(id)) this.selection.delete(id); else this.selection.add(id); }
      else { this.selection = new Set(this.selection.size === 1 && this.selection.has(id) ? [] : [id]); }
    } else if (!multi) this.selection.clear();
    this.suggestion = this.suggestion && hit ? this.suggestion : null;
    this.updateHighlights();
    this.emit('selection');
  }

  selectBodies(ids, additive = false) {
    if (!additive) this.selection.clear();
    for (const id of ids) this.selection.add(id);
    this.updateHighlights();
    this.emit('selection');
  }

  updateHighlights() {
    if (this.isAssembly) { this.asm.updateHighlights(); return; }
    const c = this.cmd;
    const H = { bodies: new Set(), faces: [], edges: [] };
    if (c && c.draft) {
      const d = c.draft;
      if (c.pick === 'edges') for (const r of d[c.pickKey] || []) H.edges.push({ bodyId: r.body, index: this.vp.findEdge(r.body, r) });
      if (c.pick === 'faces') for (const r of d[c.pickKey] || []) H.faces.push({ bodyId: r.body, index: this.vp.findFace(r.body, r) });
      if (c.pick === 'bodies' || c.pick === 'body') for (const id of d[c.pickKey] || []) H.bodies.add(id);
    } else if (!c) {
      for (const id of this.selection) H.bodies.add(id);
    }
    this.vp.setHighlights(H);
  }

  // ------------------------------------------------------------ measure
  startMeasure() {
    if (this.mode === 'sketch') this.finishSketch();
    this.cancelCommand(true);
    this.cmd = { type: 'measure' };
    this.measure = { a: null, b: null };
    this.vp.pickFilter = 'measure';
    this.emit('command');
    this.emit('measure');
  }

  _measurePick(hit) {
    if (!hit) return;
    let p = hit.point;
    if (hit.kind === 'edge') {
      const e = this.vp.bodies.get(hit.bodyId).data;
      const info = hit.info, P = e.edgePts;
      const w = (q) => this.vp.toWorldOf(hit.bodyId, q); // component placement in assemblies
      const s = w([P[info.start * 3], P[info.start * 3 + 1], P[info.start * 3 + 2]]);
      const end = (info.start + info.count - 1) * 3;
      const t = w([P[end], P[end + 1], P[end + 2]]);
      const cands = [s, t, w(info.mid)];
      const px = this.vp.pixelSize() * 14;
      const near = cands.map((q) => [q, dist(q, p)]).sort((a, b) => a[1] - b[1])[0];
      if (near[1] < px) p = near[0];
    }
    const m = this.measure;
    if (!m.a || m.b) { m.a = p; m.b = null; } else m.b = p;
    this.vp.setMeasure(m.a, m.b);
    if (m.a && m.b) {
      const mid = [0, 1, 2].map((k) => (m.a[k] + m.b[k]) / 2);
      this.vp.setLabels([{ pos: mid, text: `${dist(m.a, m.b).toFixed(3)} mm` }]);
    } else this.vp.setLabels([]);
    this.emit('measure');
  }

  // ------------------------------------------------------------ timeline + features
  moveMarker(n) {
    const len = this.doc.features.length;
    const m = n >= len ? null : Math.max(0, n);
    if (m === this.doc.marker) return;
    this.cancelCommand(true);
    if (this.mode === 'sketch') this.finishSketch();
    this.commit('Move timeline marker', (d) => { d.marker = m; });
  }

  renameFeature(id, name) {
    if (!name.trim()) return;
    this.commit('Rename', (d) => { d.features.find((f) => f.id === id).name = name.trim(); }, { rebuild: false });
  }

  toggleSuppress(id) {
    this.commit('Suppress', (d) => { const f = d.features.find((x) => x.id === id); f.suppressed = !f.suppressed; });
  }

  deleteFeature(id) {
    const f = this.doc.features.find((x) => x.id === id);
    if (!f) return;
    if (this.mode === 'sketch' && this.sketchId === id) this.finishSketch();
    const dependents = this.doc.features.filter((x) => x.sketch === id);
    this.commit(`Delete ${f.name}`, (d) => {
      const i = d.features.findIndex((x) => x.id === id);
      d.features.splice(i, 1);
      if (d.marker != null && d.marker > i) d.marker -= 1;
    });
    if (dependents.length) toast(`${dependents.map((x) => x.name).join(', ')} depended on ${f.name} and now show an error.`, 'warn', 5000);
  }

  toggleSketchVisibility(id) {
    const f = this.doc.features.find((x) => x.id === id);
    const vis = this.sketchVisible(f);
    this.commit(vis ? 'Hide sketch' : 'Show sketch', (d) => { d.features.find((x) => x.id === id).visible = !vis; }, { rebuild: false });
  }

  removeBodies(ids) {
    if (!ids.length) return;
    if (this.isAssembly) { this.asm.removeComponents(ids); return; }
    const f = { id: newId('f'), type: 'remove', name: nextName(this.doc, 'remove'), bodies: ids };
    this.selection.clear();
    this.commit(`Remove ${ids.length > 1 ? `${ids.length} bodies` : this.bodyName(ids[0])}`, (d) => this._insertFeature(d, f));
    this.emit('selection');
  }

  // ------------------------------------------------------------ parameters
  setParams(params) {
    this.commit('Edit parameters', (d) => {
      d.params = params;
      // parameters can drive constrained sketches: re-solve them so dependent geometry follows
      const scope = evaluateParams(params);
      for (const f of d.features) {
        if (f.type === 'sketch' && f.constraints && f.constraints.length) f.entities = solveSketch(f, scope).entities;
      }
    });
  }

  // ------------------------------------------------------------ files
  /** New part. The current design stays in My designs. */
  newDocument() {
    if (this.doc.features.length || (this.doc.components || []).length) this.flushSave();
    this.returnTo = null;
    this.load({ ...newDoc(), id: newDocId() });
    this.flushSave();
    this.emit('returnTo');
    this.vp.setView('home');
  }

  loadExample() {
    if (this.doc.features.length || (this.doc.components || []).length) this.flushSave();
    this.load({ ...exampleDoc(), id: newDocId() });
    this.flushSave();
    setTimeout(() => this.vp.setView('home'), 400);
  }

  saveFile() {
    const blob = new Blob([JSON.stringify(this.doc, null, 2)], { type: 'application/json' });
    download(blob, `${safeName(this.doc.name)}.f720.json`);
    toast('Design saved as a .f720.json file', 'ok');
  }

  async openFile(file) {
    try {
      const d = JSON.parse(await file.text());
      if (d.format !== 'fusion720') throw new Error('Not a Fusion720 design file');
      if (this.doc.features.length || (this.doc.components || []).length) this.flushSave();
      if (!d.id || (library.has(d.id) && !confirm(`"${d.name}" is already in My designs. Replace it with the copy from this file?`))) d.id = newDocId();
      // assemblies carry copies of their parts: add any that aren't in My designs yet so they can be edited
      let imported = 0;
      for (const [key, p] of Object.entries(d.parts || {})) if (!library.has(key)) { library.put({ ...p.doc, id: key }); imported++; }
      this.load(d);
      this.flushSave();
      setTimeout(() => this.vp.setView('home'), 400);
      toast(`Opened ${file.name}${imported ? ` (added ${imported} part${imported > 1 ? 's' : ''} to My designs)` : ''}`, 'ok');
    } catch (e) { toast(`Could not open file: ${e.message}`, 'err'); }
  }

  async exportFile(format) {
    if (this.isAssembly) return this.asm.exportFile(format);
    const bodies = this.result.bodies.filter((b) => this.bodyVisible(b.id)).map((b) => ({ id: b.id, name: this.bodyName(b.id), color: this.bodyColor(b.id) }));
    if (!bodies.length) return toast('Nothing to export — create a body first.', 'warn');
    try {
      toast(`Exporting ${format.toUpperCase()}…`, 'info', 1500);
      const blob = await this.kernel.export({ format, bodies });
      download(blob, `${safeName(this.doc.name)}.${format === 'step' ? 'step' : 'stl'}`);
      toast(`Exported ${bodies.length} bod${bodies.length > 1 ? 'ies' : 'y'} to ${format.toUpperCase()}`, 'ok');
    } catch (e) { toast(`Export failed: ${e.message}`, 'err'); }
  }

  renameDoc(name) { this.commit('Rename design', (d) => { d.name = name || 'Untitled'; }, { rebuild: false }); }
}

const toggle = (list, id) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
const safeName = (s) => (s || 'design').replace(/[^\w\- ]+/g, '').trim() || 'design';
export { STD_PLANES };
