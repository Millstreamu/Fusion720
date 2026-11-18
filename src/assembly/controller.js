// Assembly mode: components (instances of library parts), joints, solving, dragging and export.
import * as THREE from 'three';
import { library, newDocId } from '../model/library.js';
import { newAssembly, JOINT_TYPES, solveAssembly, perpendicular, qRotate, qToAxisAngle, toWorld, v3, Q_ID } from '../model/assembly.js';
import { activeFeatures, newId } from '../model/features.js';
import { BODY_COLORS } from '../viewer/viewport.js';
import { toast, download } from '../ui/dom.js';
import { exampleDoc } from '../model/example.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
const SEP = '|';
const matrixOf = ({ t, q }) => {
  const [x, y, z, w] = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y), 0,
    2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x), 0,
    2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y), 0,
    t[0], t[1], t[2], 1,
  ];
};

export class AssemblyController {
  constructor(app) {
    this.app = app;
    this.parts = {}; // part key → { bodies, errors }
    this.frames = new Map();
    this.status = { dof: 0, failing: new Set(), determined: new Set(), ok: true };
    this.preview = null; // poses shown while previewing a joint or dragging
    this.drag = null;
    this.faceCaches = new WeakMap();
  }

  get doc() { return this.app.doc; }
  get vp() { return this.app.vp; }
  get active() { return this.app.doc.kind === 'assembly'; }
  comp(id) { return this.doc.components.find((c) => c.id === id); }
  compOfBody(bodyId) { return bodyId ? bodyId.split(SEP)[0] : null; }
  partName(key) { return this.doc.parts[key]?.name || 'Part'; }

  // ------------------------------------------------------------ library links
  /** Pull newer versions of linked parts from the library. Returns how many changed. */
  refreshLinks() {
    let n = 0;
    for (const [key, p] of Object.entries(this.doc.parts || {})) {
      const lib = library.get(key);
      if (lib && (lib.savedAt || 0) > (p.savedAt || 0)) {
        this.doc.parts[key] = { name: lib.name, savedAt: lib.savedAt, doc: lib };
        n++;
      }
    }
    return n;
  }

  onLoad() {
    this.parts = {};
    this.frames = new Map();
    this.preview = null;
    const n = this.refreshLinks();
    if (n) { toast(`Updated ${n} part${n > 1 ? 's' : ''} from your designs`, 'info', 2600); this.app.autosave(); }
  }

  // ------------------------------------------------------------ build + solve
  rebuild() {
    const used = new Set(this.doc.components.map((c) => c.part));
    const parts = [...used].filter((k) => this.doc.parts[k]).map((key) => {
      const d = this.doc.parts[key].doc;
      return { key, params: d.params || [], features: activeFeatures(d) };
    });
    const app = this.app;
    app.busy = true;
    app.emit('busy', true);
    app.kernel.rebuild({ parts, quality: 'normal' }, 'assembly').then((r) => {
      if (!r || !this.active) return;
      app.busy = app.kernel.running || !!app.kernel.queued;
      this.parts = r.parts;
      const errors = {};
      for (const [k, p] of Object.entries(r.parts)) if (Object.keys(p.errors || {}).length) errors[k] = Object.values(p.errors)[0];
      app.result = { bodies: [], errors, warnings: {}, ms: r.ms };
      this.resolveFrames();
      this.solveAndStore();
      this.applyStyles();
      app.emit('result', app.result);
      app.emit('busy', app.busy);
    }).catch((e) => { app.busy = false; app.emit('busy', false); toast(e.message, 'err'); });
  }

  charLength() {
    const box = this.vp.sceneBounds();
    if (box.isEmpty()) return 50;
    const s = box.getSize(new THREE.Vector3());
    return Math.max(20, s.length() / 4);
  }

  jointsWithDraft() {
    const c = this.app.cmd;
    const list = this.doc.joints.filter((j) => !(c && c.type === 'joint' && c.editId === j.id));
    if (c && c.type === 'joint' && c.joint.a && c.joint.b) list.push(c.joint);
    return list;
  }

  /** Solve with the stored joints and quietly write any pose changes (e.g. after a part changed). */
  solveAndStore() {
    const res = solveAssembly(this.doc.components, this.doc.joints, this.frames, { scope: this.app.scope, L: this.charLength() });
    this.status = res;
    let changed = false;
    for (const c of this.doc.components) {
      const p = res.poses[c.id];
      if (!c.grounded && (v3.len(v3.sub(p.t, c.t)) > 1e-6 || Math.abs(Math.abs(p.q[0] * c.q[0] + p.q[1] * c.q[1] + p.q[2] * c.q[2] + p.q[3] * c.q[3]) - 1) > 1e-9)) {
        c.t = p.t.map((v) => +v.toFixed(6)); c.q = p.q.map((v) => +v.toFixed(9)); changed = true;
      }
    }
    if (changed) this.app.autosave();
    if (this.app.cmd && this.app.cmd.type === 'joint') this.previewJoint();
  }

  previewJoint() {
    const res = solveAssembly(this.doc.components, this.jointsWithDraft(), this.frames, { scope: this.app.scope, L: this.charLength() });
    this.preview = res.poses;
    this.previewStatus = res;
    this.applyStyles();
    this.app.emit('draft');
  }

  pose(c) { return (this.preview && this.preview[c.id]) || { t: c.t, q: c.q }; }

  // ------------------------------------------------------------ joint frames from geometry
  partData(key, bodyId) { return this.parts[key]?.bodies.find((b) => b.id === bodyId) || null; }

  faceInfo(data, fi) {
    let cache = this.faceCaches.get(data);
    if (!cache) { cache = new Map(); this.faceCaches.set(data, cache); }
    return this.vp.faceInfo({ data, faceCache: cache }, fi);
  }

  /** Orient a circle's axis like the flat face it lies on (so mating faces point at each other). */
  orientAxis(data, c, axis) {
    let best = null;
    data.groups.forEach((_, fi) => {
      const f = this.faceInfo(data, fi);
      if (!f.planar || Math.abs(v3.dot(f.normal, axis)) < 0.999) return;
      const off = Math.abs(v3.dot(v3.sub(c, f.center), f.normal));
      if (off < 1e-3 + 1e-4 * f.size && (!best || f.area > best.area)) best = f;
    });
    return best ? best.normal : axis;
  }

  /** Turn a viewport pick into a joint reference stored in the part's own coordinates. */
  refFromHit(hit) {
    const comp = this.compOfBody(hit.bodyId);
    const c = this.comp(comp);
    if (!c) return null;
    const bodyId = hit.bodyId.split(SEP)[1];
    const data = this.partData(c.part, bodyId);
    if (!data) return null;
    const [lo, hi] = data.bbox;
    const np = (p) => [0, 1, 2].map((k) => (p[k] - lo[k]) / Math.max(hi[k] - lo[k], 1e-6));
    if (hit.kind === 'face') {
      const f = hit.info;
      return { comp, ref: { kind: 'face', body: bodyId, p: f.center, n: f.normal, np: np(f.center), size: f.size, label: 'Face center' } };
    }
    if (hit.kind === 'edge') {
      const info = hit.info;
      if (info.type === 'CIRCLE') {
        const circ = this.vp.circleOf({ data }, hit.index);
        if (!circ) return null;
        const axis = this.orientAxis(data, circ.c, circ.axis);
        return { comp, ref: { kind: 'circle', body: bodyId, p: circ.c, n: axis, r: circ.r, np: np(circ.c), label: `Circle center (⌀${(circ.r * 2).toFixed(2)})` } };
      }
      if (info.type === 'LINE') return { comp, ref: { kind: 'edge', body: bodyId, p: info.mid, n: info.dir, len: info.len, np: np(info.mid), label: 'Edge midpoint' } };
      toast('Pick a flat face, a circular edge or a straight edge', 'info', 2200);
    }
    return null;
  }

  /** Find the reference again on the current part geometry (parts can change after the joint was made). */
  resolveRef(key, ref) {
    const data = this.partData(key, ref.body) || (this.parts[key]?.bodies || [])[0];
    const fallback = { o: ref.p, z: v3.norm(ref.n), x: perpendicular(v3.norm(ref.n)) };
    if (!data) return fallback;
    const [lo, hi] = data.bbox;
    const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
    const np = (p) => [0, 1, 2].map((k) => (p[k] - lo[k]) / Math.max(hi[k] - lo[k], 1e-6));
    const score = (p) => v3.len(v3.sub(np(p), ref.np || np(ref.p))) * diag + 0.25 * v3.len(v3.sub(p, ref.p));
    let best = null, bs = Infinity;
    if (ref.kind === 'face') {
      data.groups.forEach((_, fi) => {
        const f = this.faceInfo(data, fi);
        if (!f.planar || v3.dot(f.normal, ref.n) < 0.98) return;
        const s = score(f.center);
        if (s < bs) { bs = s; best = { o: f.center, z: f.normal }; }
      });
    } else if (ref.kind === 'circle') {
      data.edgeInfo.forEach((e, ei) => {
        if (e.type !== 'CIRCLE') return;
        const c = this.vp.circleOf({ data }, ei);
        if (!c || Math.abs(Math.abs(v3.dot(c.axis, ref.n)) - 1) > 0.02) return;
        const s = score(c.c) + Math.abs(c.r - (ref.r || c.r)) * 2;
        if (s < bs) { bs = s; const ax = this.orientAxis(data, c.c, c.axis); best = { o: c.c, z: v3.dot(ax, ref.n) < 0 ? v3.scale(ax, -1) : ax }; }
      });
    } else if (ref.kind === 'edge') {
      data.edgeInfo.forEach((e) => {
        if (e.type !== 'LINE' || !e.dir || Math.abs(v3.dot(e.dir, ref.n)) < 0.98) return;
        const s = score(e.mid);
        if (s < bs) { bs = s; best = { o: e.mid, z: v3.dot(e.dir, ref.n) < 0 ? v3.scale(e.dir, -1) : e.dir }; }
      });
    }
    if (!best || bs > Math.max(2, diag * 0.5)) return fallback;
    return { o: best.o, z: v3.norm(best.z), x: perpendicular(v3.norm(best.z)) };
  }

  resolveFrames() {
    this.frames = new Map();
    for (const j of this.jointsWithDraft()) this.frames.set(j.id, this.frameFor(j));
  }

  frameFor(j) {
    const side = (s) => { const c = this.comp(s.comp); return c ? this.resolveRef(c.part, s.ref) : null; };
    const a = side(j.a), b = side(j.b);
    return a && b ? { a, b } : null;
  }

  // ------------------------------------------------------------ rendering
  applyStyles() {
    const list = [];
    for (const c of this.doc.components) {
      const part = this.parts[c.part];
      if (!part) continue;
      const pd = this.doc.parts[c.part]?.doc;
      const m = matrixOf(this.pose(c));
      for (const b of part.bodies) {
        const meta = pd?.bodies?.[b.id] || {};
        if (meta.visible === false) continue;
        list.push({
          id: `${c.id}${SEP}${b.id}`, data: b, matrix: m, visible: c.visible !== false,
          color: c.color || meta.color || BODY_COLORS[(b.n - 1) % BODY_COLORS.length],
        });
      }
    }
    this.vp.setBodies(list);
    this.updateHighlights();
  }

  updateHighlights() {
    const H = { bodies: new Set(), faces: [], edges: [] };
    const cmd = this.app.cmd;
    const sel = cmd ? new Set() : this.app.selection;
    for (const id of this.vp.bodies.keys()) if (sel.has(this.compOfBody(id))) H.bodies.add(id);
    this.vp.setHighlights(H);
    // joint frame markers
    const markers = [];
    const show = [];
    if (cmd && cmd.type === 'joint') show.push(cmd.joint);
    else if (this.app.selectedJoint) { const j = this.doc.joints.find((x) => x.id === this.app.selectedJoint); if (j) show.push(j); }
    for (const j of show) {
      for (const [side, color] of [['a', '#ff7a1a'], ['b', '#4f8cff']]) {
        const s = j[side];
        const c = s && this.comp(s.comp);
        if (!c) continue;
        const fr = this.resolveRef(c.part, s.ref);
        const P = this.pose(c);
        markers.push({ p: toWorld(P, fr.o), z: qRotate(P.q, fr.z), color });
      }
    }
    this.vp.setMarkers(markers);
  }

  // ------------------------------------------------------------ picking + selection
  handlePick(hit, e) {
    const app = this.app;
    const cmd = app.cmd;
    if (cmd && cmd.type === 'joint') {
      if (!hit || !cmd.pick) return;
      const r = this.refFromHit(hit);
      if (!r) return;
      const other = cmd.pick === 'a' ? cmd.joint.b : cmd.joint.a;
      if (other && other.comp === r.comp) { toast('Pick the second point on a different component', 'warn', 2200); return; }
      cmd.joint[cmd.pick] = r;
      cmd.pick = cmd.pick === 'a' && !cmd.joint.b ? 'b' : null;
      this.vp.pickFilter = cmd.pick ? 'joint' : 'none';
      this.resolveFrames();
      this.previewJoint();
      app.emit('command');
      return;
    }
    if (cmd) return;
    app.selectedJoint = null;
    const id = hit && hit.bodyId ? this.compOfBody(hit.bodyId) : null;
    const multi = e && (e.shiftKey || e.ctrlKey || e.metaKey);
    if (id) {
      if (multi) { if (app.selection.has(id)) app.selection.delete(id); else app.selection.add(id); }
      else app.selection = new Set(app.selection.size === 1 && app.selection.has(id) ? [] : [id]);
    } else if (!multi) app.selection.clear();
    this.updateHighlights();
    app.emit('selection');
  }

  selectJoint(id) {
    this.app.selection.clear();
    this.app.selectedJoint = id;
    this.updateHighlights();
    this.app.emit('selection');
  }

  // ------------------------------------------------------------ commands
  insertPart(source) {
    const app = this.app;
    const lib = typeof source === 'string' ? library.get(source) : source;
    if (!lib) return toast('That design could not be found', 'err');
    if ((lib.kind || 'part') !== 'part') return toast('Only parts can be inserted (assemblies inside assemblies are not supported yet)', 'warn');
    if (!lib.id) lib.id = newDocId();
    const box = this.vp.sceneBounds();
    const known = this.parts[lib.id]?.bodies?.[0]?.bbox;
    let t = [0, 0, 0];
    if (!box.isEmpty()) t = [box.max.x + 25 - (known ? known[0][0] : 0), 0, 0];
    const count = this.doc.components.filter((c) => c.part === lib.id).length;
    const comp = { id: newId('c'), name: `${lib.name || 'Part'}:${count + 1}`, part: lib.id, t, q: Q_ID.slice(), grounded: this.doc.components.length === 0 };
    app.commit(`Insert ${lib.name}`, (d) => {
      d.parts = d.parts || {};
      d.parts[lib.id] = { name: lib.name, savedAt: lib.savedAt || Date.now(), doc: clone(lib) };
      d.components.push(comp);
    });
    app.selection = new Set([comp.id]);
    app.emit('selection');
    if (comp.grounded) toast(`${comp.name} is grounded (fixed in place). Insert another part and join them.`, 'info', 3600);
  }

  startJoint(editId = null) {
    const app = this.app;
    if (this.doc.components.length < 2) { toast('Insert at least two parts first, then join them', 'warn'); return; }
    app.cancelCommand(true);
    const existing = editId && this.doc.joints.find((j) => j.id === editId);
    const n = this.doc.joints.length + 1;
    const joint = existing ? clone(existing) : { id: newId('j'), name: `Joint${n}`, type: 'rigid', a: null, b: null, offset: '0 mm', angle: '0 deg', flip: false };
    app.cmd = { type: 'joint', joint, editId, pick: existing ? null : 'a' };
    app.selection.clear();
    app.selectedJoint = null;
    this.vp.pickFilter = existing ? 'none' : 'joint';
    this.resolveFrames();
    this.previewJoint();
    app.emit('command');
    app.emit('selection');
  }

  setJointPick(side) {
    const c = this.app.cmd;
    if (!c || c.type !== 'joint') return;
    c.pick = c.pick === side ? null : side;
    this.vp.pickFilter = c.pick ? 'joint' : 'none';
    this.app.emit('command');
  }

  updateJoint(patch) {
    const c = this.app.cmd;
    if (!c || c.type !== 'joint') return;
    Object.assign(c.joint, patch);
    this.resolveFrames();
    this.previewJoint();
  }

  jointError() {
    const c = this.app.cmd;
    if (!c || c.type !== 'joint') return null;
    if (!c.joint.a || !c.joint.b) return 'Pick a point on each of two components';
    if (this.previewStatus && this.previewStatus.failing.has(c.joint.id)) return 'This joint conflicts with other joints or grounded parts';
    return null;
  }

  okJoint() {
    const app = this.app;
    const c = app.cmd;
    const err = this.jointError();
    if (err) { toast(err, 'err'); return; }
    const joint = clone(c.joint);
    const poses = this.preview;
    app.cmd = null;
    this.preview = null;
    this.vp.pickFilter = 'idle';
    app.commit(c.editId ? `Edit ${joint.name}` : `Add ${JOINT_TYPES[joint.type].label.toLowerCase()} joint`, (d) => {
      if (c.editId) d.joints[d.joints.findIndex((j) => j.id === c.editId)] = joint; else d.joints.push(joint);
      for (const comp of d.components) if (poses && poses[comp.id] && !comp.grounded) { comp.t = poses[comp.id].t.map((v) => +v.toFixed(6)); comp.q = poses[comp.id].q.map((v) => +v.toFixed(9)); }
    });
    app.selectedJoint = joint.id;
    app.emit('command');
    this.updateHighlights();
  }

  afterCancel() {
    this.preview = null;
    this.vp.setMarkers([]);
    this.resolveFrames();
    this.applyStyles();
  }

  toggleGround(ids) {
    const comps = this.doc.components.filter((c) => ids.includes(c.id));
    if (!comps.length) return;
    const ground = !comps.every((c) => c.grounded);
    this.app.commit(ground ? 'Ground' : 'Unground', (d) => { for (const c of d.components) if (ids.includes(c.id)) c.grounded = ground; });
  }

  removeComponents(ids) {
    if (!ids.length) return;
    this.app.commit(ids.length > 1 ? `Remove ${ids.length} components` : `Remove ${this.comp(ids[0])?.name}`, (d) => {
      d.components = d.components.filter((c) => !ids.includes(c.id));
      d.joints = d.joints.filter((j) => !ids.includes(j.a?.comp) && !ids.includes(j.b?.comp));
      const used = new Set(d.components.map((c) => c.part));
      for (const k of Object.keys(d.parts)) if (!used.has(k)) delete d.parts[k];
      if (d.components.length && !d.components.some((c) => c.grounded)) d.components[0].grounded = true;
    });
    this.app.selection.clear();
    this.app.emit('selection');
  }

  deleteJoint(id) {
    const j = this.doc.joints.find((x) => x.id === id);
    if (!j) return;
    this.app.commit(`Delete ${j.name}`, (d) => { d.joints = d.joints.filter((x) => x.id !== id); });
    if (this.app.selectedJoint === id) this.app.selectedJoint = null;
  }

  toggleSuppressJoint(id) {
    this.app.commit('Suppress joint', (d) => { const j = d.joints.find((x) => x.id === id); j.suppressed = !j.suppressed; });
  }

  setComponent(id, patch, label = 'Edit component') {
    this.app.commit(label, (d) => { Object.assign(d.components.find((c) => c.id === id), patch); }, { rebuild: !('color' in patch || 'name' in patch || 'visible' in patch) });
    if ('color' in patch || 'visible' in patch) this.applyStyles();
  }

  /** Open a component's part for editing; a "Back to assembly" button returns here. */
  editPart(compId) {
    const c = this.comp(compId);
    if (!c) return;
    const app = this.app;
    let part = library.get(c.part);
    if (!part) { part = clone(this.doc.parts[c.part].doc); part.id = c.part; library.put(part); }
    app.flushSave();
    app.returnTo = { id: this.doc.id, name: this.doc.name };
    app.openDesign(c.part);
    toast(`Editing ${part.name}. Changes flow into the assembly when you go back.`, 'info', 3600);
  }

  // ------------------------------------------------------------ dragging components (viewport interceptor)
  wantsLeft() {
    if (!this.active || this.app.cmd) return false;
    const h = this.vp.hover;
    const c = h && h.bodyId && this.comp(this.compOfBody(h.bodyId));
    return !!(c && !c.grounded);
  }

  pointerdown(e) {
    if (!this.active || this.app.cmd || e.button !== 0) return false;
    const hit = this.vp.pick(e.clientX, e.clientY, 'faces'); // face hits carry the 3D grab point
    const c = hit && this.comp(this.compOfBody(hit.bodyId));
    if (!c || c.grounded || !hit.point) return false;
    const P = { t: c.t, q: c.q };
    const inv = [-P.q[0], -P.q[1], -P.q[2], P.q[3]];
    const local = qRotate(inv, v3.sub(hit.point, P.t));
    const camDir = this.vp.camera.getWorldDirection(new THREE.Vector3());
    this.drag = { comp: c.id, local, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(camDir, new THREE.Vector3(...hit.point)), moved: false, start: [e.clientX, e.clientY], e };
    return true;
  }

  pointermove(e) {
    if (!this.drag) return false;
    const d = this.drag;
    if (!d.moved && Math.hypot(e.clientX - d.start[0], e.clientY - d.start[1]) < 4) return true;
    d.moved = true;
    this.vp.raycaster.setFromCamera(this.vp.ndc(e.clientX, e.clientY), this.vp.camera);
    const target = this.vp.raycaster.ray.intersectPlane(d.plane, new THREE.Vector3());
    if (!target) return true;
    const res = solveAssembly(this.doc.components, this.doc.joints, this.frames, {
      scope: this.app.scope, L: this.charLength(), drag: { comp: d.comp, local: d.local, target: target.toArray() }, stiffComp: d.comp,
    });
    this.preview = res.poses;
    d.res = res;
    this.applyStyles();
    this.vp.renderer.domElement.style.cursor = 'grabbing';
    return true;
  }

  pointerup(e) {
    if (!this.drag) return false;
    const d = this.drag;
    this.drag = null;
    this.vp.renderer.domElement.style.cursor = '';
    if (d.moved && d.res) {
      const poses = d.res.poses;
      this.preview = null;
      this.app.commit(`Move ${this.comp(d.comp)?.name}`, (doc) => {
        for (const c of doc.components) if (!c.grounded && poses[c.id]) { c.t = poses[c.id].t.map((v) => +v.toFixed(6)); c.q = poses[c.id].q.map((v) => +v.toFixed(9)); }
      }, { rebuild: false });
      this.status = d.res;
      this.applyStyles();
    } else {
      this.preview = null;
      this.handlePick(this.vp.pick(e.clientX, e.clientY, 'idle'), e);
    }
    return true;
  }

  // ------------------------------------------------------------ export
  async exportFile(format) {
    const app = this.app;
    const instances = [];
    for (const c of this.doc.components) {
      if (c.visible === false || !this.parts[c.part]) continue;
      const { axis, angle } = qToAxisAngle(c.q);
      for (const b of this.parts[c.part].bodies) {
        instances.push({ key: c.part, bodyId: b.id, name: `${c.name}`, color: c.color || BODY_COLORS[(b.n - 1) % BODY_COLORS.length], t: c.t, axis, angle });
      }
    }
    if (!instances.length) return toast('Nothing to export — insert a part first.', 'warn');
    try {
      toast(`Exporting ${format.toUpperCase()}…`, 'info', 1500);
      const blob = await app.kernel.exportAssembly({ format, instances });
      download(blob, `${(this.doc.name || 'assembly').replace(/[^\w\- ]+/g, '').trim() || 'assembly'}.${format}`);
      toast(`Exported ${this.doc.components.length} components to ${format.toUpperCase()}`, 'ok');
    } catch (e) { toast(`Export failed: ${e.message}`, 'err'); }
  }
}

// ------------------------------------------------------------ example: bracket + pin on a revolute joint
export function exampleAssembly() {
  let bracket = library.get('ex-bracket');
  if (!bracket) { bracket = { ...exampleDoc(), id: 'ex-bracket', name: 'Bracket' }; library.put(bracket); }
  let pin = library.get('ex-pin');
  if (!pin) {
    pin = {
      format: 'fusion720', version: 1, id: 'ex-pin', name: 'Pin', units: 'mm', marker: null, bodies: { 'b:sh': { name: 'Pin', color: '#cdbf86' } },
      params: [{ name: 'pin_d', expr: '13.6 mm', comment: 'Shaft diameter' }, { name: 'pin_l', expr: '40 mm', comment: 'Shaft length' }],
      features: [
        { id: 'sh', type: 'cylinder', name: 'Shaft', d: 'pin_d', h: 'pin_l', axis: 'Z', x: '0', y: '0', z: '0', operation: 'new', targets: [] },
        { id: 'hd', type: 'cylinder', name: 'Head', d: '22 mm', h: '6 mm', axis: 'Z', x: '0', y: '0', z: 'pin_l', operation: 'join', targets: [] },
        { id: 'ch', type: 'chamfer', name: 'Tip chamfer', distance: '1 mm', edges: [{ body: 'b:sh', p: [-6.8, 0, 0], np: [0.191, 0.5, 0], adj: 'CYLINDRE+PLANE', dir: null, type: 'CIRCLE', len: 42.73 }] },
      ],
    };
    library.put(pin);
  }
  const asm = newAssembly('Hinge assembly');
  asm.id = 'ex-assembly';
  asm.parts = { 'ex-bracket': { name: bracket.name, savedAt: bracket.savedAt, doc: clone(bracket) }, 'ex-pin': { name: pin.name, savedAt: pin.savedAt, doc: clone(pin) } };
  asm.components = [
    { id: 'c1', name: 'Bracket:1', part: 'ex-bracket', t: [0, 0, 0], q: [0, 0, 0, 1], grounded: true },
    { id: 'c2', name: 'Pin:1', part: 'ex-pin', t: [80, 40, 0], q: [0, 0, 0, 1], grounded: false },
  ];
  asm.joints = [{
    id: 'j1', name: 'Pin hinge', type: 'revolute', offset: '0 mm', angle: '0 deg', flip: false,
    a: { comp: 'c1', ref: { kind: 'face', body: 'b:ex_plate', p: [0, 0, 30], n: [0, 0, 1], np: [0.5, 0.5, 1], size: 42.4, label: 'Face center' } },
    b: { comp: 'c2', ref: { kind: 'face', body: 'b:sh', p: [0, 0, 40], n: [0, 0, -1], np: [0.5, 0.5, 0.8696], size: 31.1, label: 'Face center' } },
  }];
  return asm;
}
