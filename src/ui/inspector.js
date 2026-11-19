// Right "Inspector" panel: feature dialogs (non-modal, live preview), sketch editing,
// body properties and getting-started help.
import { h, clear, iconEl, toast } from './dom.js';
import { CONSTRAINTS, HV, isLiteral as isFreeLiteral } from '../model/constraints.js';
import { JOINT_TYPES, qToEuler, qFromEuler } from '../model/assembly.js';
import { icon } from './icons.js';
import { FEATURES } from '../model/features.js';
import { tryEvaluate, fmt } from '../model/expr.js';
import { NUMERIC_FIELDS, FIELD_LABELS, ENTITY_NAMES } from '../model/profiles.js';
import { SKETCH_TOOLS } from '../viewer/sketcher.js';
import { BODY_COLORS } from '../viewer/viewport.js';
import { STD_PLANES, dist } from '../model/geom.js';

const isLiteral = (s) => /^\s*-?\d*\.?\d+(e[+-]?\d+)?\s*(mm|deg)?\s*$/i.test(String(s));

export class Inspector {
  constructor(el, app, ui) {
    this.el = el;
    this.app = app;
    this.ui = ui;
    for (const evt of ['command', 'draft', 'result', 'selection', 'mode', 'sketchTool', 'sketchSelection', 'doc', 'measure']) {
      app.on(evt, () => this.schedule());
    }
    this.render();
  }

  schedule() {
    if (this._q) return;
    this._q = requestAnimationFrame(() => { this._q = 0; this.render(); });
  }

  // ------------------------------------------------------------ widgets
  exprField({ key, label, value, unit, onInput, onCommit, drag, step, half, extra }) {
    const scope = this.app.scope;
    const input = h('input', { value: value ?? '', spellcheck: false, 'data-key': key, 'aria-label': label });
    const val = h('div.expr-val');
    const box = h('div.expr', {}, input);
    const show = () => {
      const r = tryEvaluate(input.value, scope);
      box.classList.toggle('bad', !!r.error);
      val.classList.toggle('bad', !!r.error);
      val.textContent = r.error ? r.error : isLiteral(input.value) ? '' : `= ${fmt(r.value)}${unit === 'deg' ? '°' : unit ? ` ${unit}` : ''}`;
      return r;
    };
    show();
    input.addEventListener('input', () => { show(); onInput?.(input.value); });
    input.addEventListener('change', () => onCommit?.(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); onCommit?.(input.value); input.blur(); }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const r = tryEvaluate(input.value, scope);
        if (r.error || !isLiteral(input.value)) return;
        e.preventDefault();
        const s = (step || (unit === 'deg' ? 5 : 1)) * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
        input.value = `${fmt(r.value + s, 4)}${unit === 'deg' ? ' deg' : unit === 'mm' ? ' mm' : ''}`;
        show(); onInput?.(input.value); onCommit?.(input.value);
      }
    });
    if (drag) {
      const handle = h('span.drag', { html: icon('drag'), title: 'Drag to change the value (Shift = faster)' });
      handle.addEventListener('pointerdown', (e) => {
        const r = tryEvaluate(input.value, scope);
        if (r.error || !isLiteral(input.value)) return;
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        const x0 = e.clientX, v0 = r.value;
        const base = step || (unit === 'deg' ? 1 : Math.max(0.1, Math.abs(v0) * 0.01));
        const mv = (ev) => {
          const v = v0 + Math.round((ev.clientX - x0) / 3) * base * (ev.shiftKey ? 10 : 1);
          input.value = `${fmt(step === 1 ? Math.round(v) : v, 3)}${unit === 'deg' ? ' deg' : unit === 'mm' ? ' mm' : ''}`;
          show(); onInput?.(input.value);
        };
        const up = () => { handle.removeEventListener('pointermove', mv); handle.removeEventListener('pointerup', up); onCommit?.(input.value); };
        handle.addEventListener('pointermove', mv);
        handle.addEventListener('pointerup', up);
      });
      box.append(handle);
    }
    return h(`div.field${half ? '.half' : ''}`, {}, h('label', {}, h('span', { text: label }), extra || null), box, val);
  }

  segmented({ label, options, value, onChange }) {
    return h('div.field', {}, h('label', { text: label }),
      h('div.seg', { role: 'radiogroup', 'aria-label': label }, options.map(([v, l]) => h(`button${v === value ? '.on' : ''}`, { text: l, role: 'radio', 'aria-checked': String(v === value), on: { click: () => onChange(v) } }))));
  }

  toggle({ label, value, onChange }) {
    const input = h('input', { type: 'checkbox', checked: !!value, on: { change: () => onChange(input.checked) } });
    return h('label.toggle', {}, h('span', { text: label }), input, h('span.sw'));
  }

  pickField({ label, count, active, text, hint, onClick, onClear }) {
    const clearBtn = count ? h('button.icon-btn', { html: icon('x'), title: 'Clear selection', 'aria-label': `Clear ${label}`, on: { click: (e) => { e.stopPropagation(); onClear(); } } }) : null;
    return h('div.field', {}, h('div.field-label', {}, typeof label === 'string' ? h('span', { text: label }) : label),
      h(`div.pick${active ? '.active' : ''}`, { role: 'button', tabindex: 0, on: { click: onClick, keydown: (e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); } } },
        h(`span.pick-count${count ? '' : '.zero'}`, { text: count }), h('span.pick-text', { text }), clearBtn),
      active && hint ? h('div.hint', { text: hint }) : null);
  }

  head(iconName, title, sub, extra) {
    return h('div.insp-head', {}, h('div.badge', { html: icon(iconName) }), h('div', { style: { flex: 1, minWidth: 0 } }, title, sub ? h('div.insp-sub', { text: sub }) : null), extra);
  }

  // ------------------------------------------------------------ render
  render() {
    const focus = document.activeElement;
    const fkey = focus && this.el.contains(focus) ? focus.dataset.key : null;
    const sel = fkey && focus.selectionStart != null ? [focus.selectionStart, focus.selectionEnd] : null;
    clear(this.el);
    const app = this.app;
    let content;
    if (app.cmd && app.cmd.type === 'sketchPlane') content = this.renderSketchPlane();
    else if (app.cmd && app.cmd.type === 'measure') content = this.renderMeasure();
    else if (app.cmd && app.cmd.type === 'joint') content = this.renderJoint();
    else if (app.isAssembly) content = this.renderAssembly();
    else if (app.cmd && app.cmd.draft) content = this.renderFeature();
    else if (app.mode === 'sketch') content = this.renderSketch();
    else if (app.selection.size) content = this.renderBodies();
    else content = this.renderWelcome();
    this.el.append(content);
    if (fkey) {
      const el = this.el.querySelector(`[data-key="${CSS.escape(fkey)}"]`);
      if (el) { el.focus(); if (sel && el.setSelectionRange) try { el.setSelectionRange(sel[0], sel[1]); } catch { /* not a text input */ } }
    }
  }

  renderSketchPlane() {
    const app = this.app;
    const body = h('div.insp-body', {},
      h('div.banner.info', { html: icon('info') }, h('div', { text: 'Click an origin plane or any flat face of a body to start sketching on it.' })),
      h('div.field', {}, h('label', { text: 'Origin planes' }),
        ...Object.entries(STD_PLANES).map(([k, p]) => h('button.btn', { style: { justifyContent: 'flex-start' }, html: icon('plane'), on: { click: () => app.createSketch({ type: 'std', name: k, offset: '0' }) } }, h('span', { text: p.label })))));
    return h('div.insp', {}, this.head('sketch', h('div.insp-title', { text: 'New sketch' }), 'Choose a plane'), body,
      h('div.insp-foot', {}, h('button.btn.grow', { text: 'Cancel', on: { click: () => app.cancelCommand() } })));
  }

  renderMeasure() {
    const app = this.app;
    const m = app.measure || {};
    const p = (v) => (v ? v.map((x) => fmt(x, 2)).join(', ') : '—');
    const stats = h('dl.stats', {}, h('dt', { text: 'Point A' }), h('dd', { text: p(m.a) }), h('dt', { text: 'Point B' }), h('dd', { text: p(m.b) }));
    if (m.a && m.b) {
      const d = [0, 1, 2].map((k) => m.b[k] - m.a[k]);
      stats.append(h('dt', { text: 'Distance' }), h('dd', { text: `${fmt(dist(m.a, m.b), 3)} mm`, style: { color: 'var(--brand)', fontWeight: 600 } }),
        h('dt', { text: 'ΔX' }), h('dd', { text: fmt(d[0], 3) }), h('dt', { text: 'ΔY' }), h('dd', { text: fmt(d[1], 3) }), h('dt', { text: 'ΔZ' }), h('dd', { text: fmt(d[2], 3) }));
    }
    return h('div.insp', {}, this.head('measure', h('div.insp-title', { text: 'Measure' }), 'Point-to-point distance'),
      h('div.insp-body', {}, h('div.banner.info', { html: icon('info') }, h('div', { text: 'Click on faces or edges. Edge clicks snap to their ends and midpoints. A third click starts a new measurement.' })), stats),
      h('div.insp-foot', {}, h('button.btn.grow.primary', { text: 'Done', on: { click: () => app.cancelCommand() } })));
  }

  // ------------------------------------------------------------ assemblies
  renderJoint() {
    const app = this.app, asm = app.asm, c = app.cmd, j = c.joint;
    const set = (patch) => asm.updateJoint(patch);
    const typeGrid = h('div.seg', { role: 'radiogroup', 'aria-label': 'Joint type', style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)' } },
      Object.entries(JOINT_TYPES).map(([k, t]) => h(`button${k === j.type ? '.on' : ''}`, { role: 'radio', 'aria-checked': String(k === j.type), title: t.desc, on: { click: () => set({ type: k }) } }, t.label)));
    const pick = (side, label, color) => {
      const s = j[side];
      const comp = s && asm.comp(s.comp);
      return this.pickField({
        label: h('span', {}, h('span', { style: { display: 'inline-block', width: '9px', height: '9px', borderRadius: '50%', background: color, marginRight: '6px' } }), label),
        count: s ? 1 : 0, active: c.pick === side,
        text: s ? `${comp ? comp.name : '?'} · ${s.ref.label}` : c.pick === side ? 'Click a flat face, circular or straight edge' : 'Click to pick',
        hint: 'Circular edges snap to their center — great for pins and holes',
        onClick: () => asm.setJointPick(side), onClear: () => { set({ [side]: null }); asm.setJointPick(side); },
      });
    };
    const fields = [
      h('div.field', {}, h('label', { text: 'Type' }), typeGrid, h('div.hint', { text: JOINT_TYPES[j.type].desc })),
      pick('a', 'First component', '#ff7a1a'),
      pick('b', 'Second component (moves)', '#4f8cff'),
    ];
    if (j.type !== 'slider' && j.type !== 'cylindrical') fields.push(this.exprField({ key: 'j-offset', label: 'Offset (gap)', value: j.offset, unit: 'mm', drag: true, onInput: (v) => set({ offset: v }) }));
    if (j.type === 'rigid' || j.type === 'slider') fields.push(this.exprField({ key: 'j-angle', label: 'Angle', value: j.angle, unit: 'deg', drag: true, onInput: (v) => set({ angle: v }) }));
    fields.push(this.toggle({ label: 'Flip direction', value: j.flip, onChange: (v) => set({ flip: v }) }));
    const err = asm.jointError();
    const st = asm.previewStatus;
    if (err && j.a && j.b) fields.push(h('div.banner.err', { html: icon('error') }, h('div', { text: err })));
    else if (!err && st) fields.push(h('div.hint', { html: st.dof ? `Assembly has <b style="color:var(--text)">${st.dof}</b> degree${st.dof === 1 ? '' : 's'} of freedom left — drag parts to test the motion after OK.` : 'Assembly is fully constrained.' }));
    const nameInput = h('input.doc-name', { value: j.name, 'data-key': '__jname', spellcheck: false, 'aria-label': 'Joint name', style: { width: '100%' } });
    nameInput.addEventListener('change', () => { j.name = nameInput.value || j.name; });
    nameInput.addEventListener('keydown', (e) => e.stopPropagation());
    return h('div.insp', {}, this.head('joint', nameInput, c.editId ? 'Editing joint' : 'New joint'),
      h('div.insp-body', {}, ...fields),
      h('div.insp-foot', {}, h('button.btn', { text: 'Cancel', on: { click: () => app.cancelCommand() } }),
        h('button.btn.primary.grow', { html: icon('check'), disabled: !!err, on: { click: () => app.okCommand() } }, h('span', { text: 'OK' }), h('kbd', { text: 'Enter' }))));
  }

  renderAssembly() {
    const app = this.app, asm = app.asm, doc = app.doc;
    if (app.selectedJoint) {
      const j = doc.joints.find((x) => x.id === app.selectedJoint);
      if (j) {
        const failing = asm.status.failing?.has(j.id);
        return h('div.insp', {}, this.head(JOINT_TYPES[j.type].icon, h('div.insp-title', { text: j.name }), `${JOINT_TYPES[j.type].label} joint`),
          h('div.insp-body', {},
            failing ? h('div.banner.err', { html: icon('error') }, h('div', { text: 'This joint can’t be satisfied with the others — edit or delete one.' })) : null,
            h('dl.stats', {},
              h('dt', { text: 'Connects' }), h('dd', { text: `${asm.comp(j.a.comp)?.name} → ${asm.comp(j.b.comp)?.name}` }),
              h('dt', { text: 'Offset' }), h('dd', { text: j.offset }), h('dt', { text: 'Angle' }), h('dd', { text: j.angle }),
              h('dt', { text: 'Status' }), h('dd', { text: j.suppressed ? 'Suppressed' : failing ? 'Conflict' : 'OK' })),
            h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' } },
              h('button.btn', { html: icon('edit'), on: { click: () => asm.startJoint(j.id) } }, h('span', { text: 'Edit' })),
              h('button.btn', { html: icon('suppress'), on: { click: () => asm.toggleSuppressJoint(j.id) } }, h('span', { text: j.suppressed ? 'Unsuppress' : 'Suppress' })),
              h('button.btn.danger', { html: icon('trash'), on: { click: () => asm.deleteJoint(j.id) } }, h('span', { text: 'Delete' })))));
      }
    }
    const ids = [...app.selection].filter((id) => asm.comp(id));
    if (ids.length > 1) {
      return h('div.insp', {}, this.head('assembly', h('div.insp-title', { text: `${ids.length} components` }), 'Selection'),
        h('div.insp-body', {}, h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' } },
          h('button.btn', { html: icon('ground'), on: { click: () => asm.toggleGround(ids) } }, h('span', { text: 'Ground' })),
          h('button.btn.danger', { html: icon('remove'), on: { click: () => asm.removeComponents(ids) } }, h('span', { text: 'Remove' })))));
    }
    if (ids.length === 1) return this.renderComponent(asm.comp(ids[0]));
    const st = asm.status;
    const body = h('div.insp-body', {},
      doc.components.length >= 2 && doc.joints.length
        ? (st.failing?.size
          ? h('div.banner.err', { html: icon('error') }, h('div', { text: `${st.failing.size} joint${st.failing.size > 1 ? 's' : ''} can’t be satisfied (shown in red in the browser).` }))
          : h('div.hint', { html: st.dof ? `<b style="color:var(--text)">${st.dof}</b> degree${st.dof === 1 ? '' : 's'} of freedom — drag a part to move it along its joints.` : 'Fully constrained — every part is locked in place.' }))
        : null,
      h('div.card', {}, h('h3', { text: 'Build an assembly' }),
        h('ol.steps', {},
          h('li', { html: '<span><b>Insert</b> parts from My designs. The first one is grounded (fixed).</span>' }),
          h('li', { html: '<span><b>Joint</b>: click a point on one part, then on another — faces, circular edges (centers) or straight edges.</span>' }),
          h('li', { html: '<span>Pick the motion: <b>Rigid</b>, <b>Revolute</b> (hinge), <b>Slider</b>, <b>Cylindrical</b>, <b>Planar</b> or <b>Ball</b>.</span>' }),
          h('li', { html: '<span><b>Drag</b> parts to see them move. Edit a part and the assembly updates.</span>' }))),
      h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' } },
        h('button.btn.primary', { html: icon('insert'), on: { click: () => this.ui.openLibrary('insert') } }, h('span', { text: 'Insert part' })),
        h('button.btn', { html: icon('joint'), on: { click: () => asm.startJoint() } }, h('span', { text: 'Joint' }))),
      doc.components.length ? null : h('button.btn', { html: icon('sparkle'), on: { click: () => app.loadExampleAssembly() } }, h('span', { text: 'Open the example hinge assembly' })));
    return h('div.insp', {}, this.head('assembly', h('div.insp-title', { text: doc.name }), `${doc.components.length} components · ${doc.joints.length} joints`,
      h('button.icon-btn', { html: icon('panelRight'), title: 'Collapse panel', 'aria-label': 'Collapse inspector', on: { click: () => this.ui.togglePanel('right') } })), body);
  }

  renderComponent(c) {
    const app = this.app, asm = app.asm;
    const part = asm.parts[c.part];
    const vol = part ? part.bodies.reduce((s, b) => s + b.volume, 0) : 0;
    const nameInput = h('input.doc-name', { value: c.name, spellcheck: false, 'data-key': '__cname', 'aria-label': 'Component name', style: { width: '100%' } });
    nameInput.addEventListener('change', () => asm.setComponent(c.id, { name: nameInput.value.trim() || c.name }, 'Rename component'));
    nameInput.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') nameInput.blur(); });
    const jointed = app.doc.joints.some((j) => !j.suppressed && (j.a.comp === c.id || j.b.comp === c.id));
    const eul = qToEuler(c.q);
    const posField = (k, i) => this.exprField({
      key: `cp-${k}`, label: k.toUpperCase(), value: fmt(c.t[i], 3), unit: 'mm', half: true,
      onCommit: (v) => { const r = tryEvaluate(v, app.scope); if (!r.error) { const t = c.t.slice(); t[i] = r.value; asm.setComponent(c.id, { t }, 'Move component'); } },
    });
    const rotField = (k, i) => this.exprField({
      key: `cr-${k}`, label: `R${k}`, value: fmt(eul[i], 2), unit: 'deg', half: true,
      onCommit: (v) => { const r = tryEvaluate(v, app.scope); if (!r.error) { const e = eul.slice(); e[i] = r.value; asm.setComponent(c.id, { q: qFromEuler(e) }, 'Rotate component'); } },
    });
    const colorBtns = BODY_COLORS.map((col) => h(`button${col === c.color ? '.on' : ''}`, { style: { background: col }, title: col, 'aria-label': `Colour ${col}`, on: { click: () => asm.setComponent(c.id, { color: col }, 'Change colour') } }));
    return h('div.insp', {}, this.head(c.grounded ? 'ground' : 'body', nameInput, `${asm.partName(c.part)}${c.grounded ? ' · grounded' : ''}`),
      h('div.insp-body', {},
        this.toggle({ label: 'Grounded (fixed in place)', value: !!c.grounded, onChange: () => asm.toggleGround([c.id]) }),
        h('div.field-heading', { text: 'Position' }),
        h('div.field-row', {}, posField('x', 0), posField('y', 1), posField('z', 2)),
        h('div.field-row', {}, rotField('X', 0), rotField('Y', 1), rotField('Z', 2)),
        jointed && !c.grounded ? h('div.hint', { text: 'Joints control this part — typed positions get pulled back onto its joints.' }) : null,
        h('div.field', {}, h('label', { text: 'Appearance' }), h('div.colors', {}, ...colorBtns,
          h('button', { title: 'Use the part’s own colours', 'aria-label': 'Reset colour', style: { background: 'var(--panel)', border: '1px dashed var(--border-strong)' }, on: { click: () => asm.setComponent(c.id, { color: undefined }, 'Reset colour') } }))),
        h('dl.stats', {}, h('dt', { text: 'Volume' }), h('dd', { text: volume(vol) }), h('dt', { text: 'Bodies' }), h('dd', { text: part ? part.bodies.length : '—' })),
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' } },
          h('button.btn', { html: icon('edit'), on: { click: () => asm.editPart(c.id) } }, h('span', { text: 'Edit part' })),
          h('button.btn', { html: icon('joint'), on: { click: () => asm.startJoint() } }, h('span', { text: 'Joint' })),
          h('button.btn', { html: icon('insert'), on: { click: () => asm.insertPart(c.part) } }, h('span', { text: 'Duplicate' })),
          h('button.btn.danger', { html: icon('remove'), on: { click: () => asm.removeComponents([c.id]) } }, h('span', { text: 'Remove' })))));
  }

  renderFeature() {
    const app = this.app;
    const c = app.cmd;
    const d = c.draft;
    const def = FEATURES[c.type];
    const set = (patch) => app.updateDraft(patch);
    const fields = [];
    let row = null;
    for (const fl of def.fields || []) {
      if (fl.showIf && !fl.showIf(d)) continue;
      if (fl.kind === 'heading') { fields.push(h('div.field-heading', { text: fl.label })); row = null; continue; }
      let node;
      if (fl.kind === 'expr') node = this.exprField({ key: fl.key, label: fl.label, value: d[fl.key], unit: fl.unit, drag: fl.drag, step: fl.step, half: fl.half, onInput: (v) => set({ [fl.key]: v }) });
      else if (fl.kind === 'segmented' && fl.extraAxisLines) node = this.axisSelect(fl, d, set);
      else if (fl.kind === 'segmented') node = this.segmented({ label: fl.label, options: fl.options, value: d[fl.key], onChange: (v) => set({ [fl.key]: v }) });
      else if (fl.kind === 'bool') node = this.toggle({ label: fl.label, value: d[fl.key], onChange: (v) => set({ [fl.key]: v }) });
      else if (fl.kind === 'pick') node = this.pickFor(fl, d);
      if (fl.half) {
        if (!row) { row = h('div.field-row'); fields.push(row); }
        row.append(node);
        if (row.children.length === 3) row = null;
      } else { row = null; fields.push(node); }
    }
    const err = app.result.errors[d.id];
    const warn = app.result.warnings[d.id];
    const pickingBase = c.pick === 'edges' || c.pick === 'faces';
    const banners = [];
    if (pickingBase) banners.push(h('div.banner.info', { html: icon('info') }, h('div', { text: 'Selecting on the original geometry. Click the field again (or press Enter) to preview the result.' })));
    else if (err) banners.push(h('div.banner.err', { html: icon('error') }, h('div', { text: err })));
    if (warn && !pickingBase) banners.push(h('div.banner.warn', { html: icon('warn') }, h('div', { text: warn })));
    const nameInput = h('input.doc-name', { value: d.name, 'data-key': '__name', spellcheck: false, 'aria-label': 'Feature name', style: { width: '100%' } });
    nameInput.addEventListener('change', () => { d.name = nameInput.value || d.name; });
    nameInput.addEventListener('keydown', (e) => e.stopPropagation());
    const ok = h('button.btn.primary.grow', { html: icon('check'), disabled: !!err && !pickingBase, on: { click: () => (pickingBase ? app.setPickField(c.pickKey) : app.okCommand()) } }, h('span', { text: pickingBase ? 'Preview' : 'OK' }), h('kbd', { text: 'Enter' }));
    return h('div.insp', {},
      this.head(def.icon, nameInput, c.editId ? 'Editing feature' : `New ${def.label.toLowerCase()}`),
      h('div.insp-body', {}, ...fields, ...banners),
      h('div.insp-foot', {}, h('button.btn', { text: 'Cancel', on: { click: () => app.cancelCommand() } }), ok));
  }

  axisSelect(fl, d, set) {
    const sk = this.app.doc.features.find((f) => f.id === d.sketch);
    const opts = [['x', 'Sketch X axis'], ['y', 'Sketch Y axis']];
    if (sk) sk.entities.filter((e) => e.type === 'line').forEach((e, i) => opts.push([e.id, `${e.construction ? 'Construction line' : 'Line'} ${i + 1}`]));
    const s = h('select.select', { 'aria-label': fl.label, on: { change: () => set({ [fl.key]: s.value }) } }, opts.map(([v, l]) => h('option', { value: v, text: l, selected: d[fl.key] === v })));
    return h('div.field', {}, h('label', { text: fl.label }), s, h('div.hint', { text: 'Tip: draw a construction line in the sketch to revolve around it' }));
  }

  pickFor(fl, d) {
    const app = this.app;
    const list = d[fl.key] || [];
    const n = list.length;
    const active = app.cmd.pickKey === fl.key;
    const names = { profiles: ['profile', 'profiles'], edges: ['edge', 'edges'], faces: ['face', 'faces'], bodies: ['body', 'bodies'], body: ['body', 'bodies'] }[fl.pick];
    let text;
    if (!n) text = active ? `Click ${fl.pick === 'body' ? 'a body' : names[1]} in the view` : fl.optional ? 'Automatic' : `Select ${names[1]}`;
    else if ((fl.pick === 'bodies' || fl.pick === 'body') && n <= 2) text = list.map((id) => app.bodyName(id)).join(', ');
    else text = `${n} ${n === 1 ? names[0] : names[1]} selected`;
    return this.pickField({
      label: fl.label, count: n, active, text, hint: fl.hint,
      onClick: () => app.setPickField(fl.key),
      onClear: () => app.updateDraft({ [fl.key]: [] }),
    });
  }

  renderSketch() {
    const app = this.app;
    const f = app.activeSketch();
    const sk = app.sketcher;
    if (!f) return h('div');
    const ctx = app.sketchEval(f);
    const st = ctx.status;
    const cons = f.constraints || [];
    const tool = SKETCH_TOOLS[sk.tool];
    const selIds = [...sk.selected].filter((id) => f.entities.some((e) => e.id === id));
    const body = h('div.insp-body');
    // constraint status
    if (st.failing.size) {
      body.append(h('div.banner.err', { html: icon('error') }, h('div', { text: `${st.failing.size} constraint${st.failing.size > 1 ? 's' : ''} can’t be satisfied (shown in red). Delete one or change a dimension.` })));
    } else if (f.entities.length) {
      body.append(st.dof === 0
        ? h('div.banner.info', { html: icon('ok'), style: { color: 'var(--ok)', background: 'rgba(47,191,113,0.12)' } }, h('div', { text: 'Fully constrained — every entity is defined.' }))
        : h('div.hint', { html: `<b style="color:var(--text)">${st.dof}</b> degree${st.dof === 1 ? '' : 's'} of freedom. <span style="color:var(--accent)">Blue</span> geometry can still move; white is fully defined, green is fixed.` }));
    }
    if (sk.tool === 'constraint') {
      const def = sk.ctype === 'hv' ? HV : CONSTRAINTS[sk.ctype];
      body.append(h('div.card', {}, h('h3', { text: def.label }), h('p', { text: def.desc }),
        h('p', { style: { marginTop: '6px' }, text: sk.picks.length ? `${sk.picks.length} picked — keep clicking. Esc clears.` : 'Click geometry in the view. Selected lines/circles are used straight away.' })));
    } else if (sk.modifying) {
      const valueField = sk.tool === 'fillet' || sk.tool === 'offset'
        ? this.exprField({
          key: `mod-${sk.tool}`, label: sk.tool === 'fillet' ? 'Fillet radius' : 'Offset distance', value: sk.modText[sk.tool], unit: 'mm', drag: true,
          onInput: (v) => { sk.modText[sk.tool] = v; sk._refreshModify(); },
        })
        : null;
      body.append(h('div.card', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, h('h3', { text: tool.label, style: { margin: 0 } }), h('p', { text: tool.desc }), valueField));
    } else if (sk.tool !== 'select') {
      body.append(h('div.card', {}, h('h3', { text: tool.label }), h('p', { text: tool.desc }),
        sk.tool === 'dimension' ? null : h('p', { style: { marginTop: '6px' }, html: `Type a number while drawing to set a dimension, <kbd>Tab</kbd> to switch fields, <kbd>Enter</kbd> to place. Snapping to points adds constraints automatically.${sk.tool === 'line' ? ' Press <kbd>A</kbd> mid-chain for tangent arcs.' : ''}` })));
    }
    body.append(
      this.toggle({ label: 'Show dimensions', value: sk.showDims, onChange: () => sk.toggleDims() }),
      this.toggle({ label: 'Construction mode (X)', value: sk.construction, onChange: () => sk.toggleConstruction() }),
      this.toggle({ label: 'Snap to grid', value: sk.snapGrid, onChange: (v) => { sk.snapGrid = v; } }),
    );
    if (selIds.length === 1) body.append(this.entityEditor(f.entities.find((e) => e.id === selIds[0]), ctx));
    else if (selIds.length > 1) {
      body.append(h('div.card', {}, h('h3', { text: `${selIds.length} entities selected` }),
        h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' } },
          h('button.btn', { html: icon('lock'), on: { click: () => sk.toggleFix() } }, h('span', { text: 'Fix' })),
          h('button.btn', { html: icon('construction'), on: { click: () => sk.toggleConstruction() } }, h('span', { text: 'Construction' })),
          h('button.btn.danger', { html: icon('trash'), on: { click: () => sk.deleteSelected() } }, h('span', { text: 'Delete' })))));
    }
    if (sk.selectedCons.size) {
      body.append(h('div.card', {}, h('h3', { text: `${sk.selectedCons.size} constraint${sk.selectedCons.size > 1 ? 's' : ''} selected` }),
        h('button.btn.danger', { html: icon('trash'), style: { marginTop: '8px' }, on: { click: () => sk.deleteSelected() } }, h('span', { text: 'Delete' }), h('kbd', { text: 'Del' }))));
    }
    const list = h('div.ent-list');
    f.entities.forEach((e) => {
      const ev = ctx.ents.find((x) => x.id === e.id);
      const meta = ev && !ev.error ? entityMeta(ev) : ev?.error ? '⚠' : '';
      list.append(h(`div.ent-row${sk.selected.has(e.id) ? '.selected' : ''}`, {
        on: { click: (evt) => { if (!evt.shiftKey) sk.selected.clear(); sk.selected.add(e.id); if (sk.tool !== 'select') sk.setTool('select'); app.refreshSketches(); app.emit('sketchSelection'); } },
      }, iconEl(e.construction ? 'construction' : ({ rect: 'rect', circle: 'circle', polygon: 'polygon', slot: 'slot', line: 'line', polyline: 'line' }[e.type] || 'line'), 'ico'),
      h('span', { text: ENTITY_NAMES[e.type] + (e.type === 'polyline' ? (e.closed ? ' (closed)' : '') : '') }), h('span.meta', { text: meta })));
    });
    body.append(h('div.field', {}, h('div.field-label', {}, h('span', { text: `Entities (${f.entities.length})` }), h('span', { text: `${ctx.regions.length} profile${ctx.regions.length === 1 ? '' : 's'}` })),
      f.entities.length ? list : h('div.hint', { text: 'Nothing drawn yet. Pick a tool above — Rectangle (R) and Circle (C) are a good start.' })));
    if (cons.length) {
      const describe = refDescriber(f);
      const clist = h('div.ent-list');
      for (const c of cons) {
        const def = CONSTRAINTS[c.type];
        if (!def) continue;
        const del = h('button.icon-btn.row-del', { html: icon('x'), title: 'Delete constraint', 'aria-label': `Delete ${def.label}`, on: { click: (ev) => { ev.stopPropagation(); sk.highlightConstraint(null); app.removeConstraints([c.id]); } } });
        clist.append(h(`div.ent-row${sk.selectedCons.has(c.id) ? '.selected' : ''}${st.failing.has(c.id) ? '.bad' : ''}`, {
          title: c.refs.map(describe).join(' · '),
          on: {
            click: (ev) => sk.selectConstraint(c.id, ev.shiftKey || ev.ctrlKey),
            mouseenter: () => sk.highlightConstraint(c.id), mouseleave: () => sk.highlightConstraint(null),
          },
        }, iconEl(def.icon || 'dimension', 'ico'), h('span', { text: def.label }),
        h('span.meta', { text: def.dim ? `${c.value}${c.type === 'angle' ? '°' : ''}` : c.refs.map(describe).join(' · ') }), del));
      }
      body.append(h('div.field', {}, h('div.field-label', {}, h('span', { text: `Constraints (${cons.length})` })), clist));
    }
    const plane = f.plane.type === 'std' ? STD_PLANES[f.plane.name].label : 'Face plane';
    const offsetField = f.plane.type === 'std' ? this.exprField({
      key: '__offset', label: 'Plane offset', value: f.plane.offset ?? '0', unit: 'mm',
      onCommit: (v) => app.commit('Change sketch plane offset', (doc) => { doc.features.find((x) => x.id === f.id).plane.offset = v; }),
    }) : null;
    if (offsetField) body.append(offsetField);
    return h('div.insp', {}, this.head('sketch', h('div.insp-title', { text: f.name }), plane), body,
      h('div.insp-foot', {}, h('button.btn.primary.grow', { html: icon('check'), on: { click: () => app.finishSketch() } }, h('span', { text: 'Finish sketch' }))));
  }

  entityEditor(e, ctx) {
    const app = this.app;
    const commit = (patch, label = 'Edit sketch') => app.updateSketchEntities([e.id], (x) => ({ ...x, ...patch }), label);
    const ev = ctx.ents.find((x) => x.id === e.id);
    const locked = new Set(e.locked || []);
    const lockBtn = (k, value) => {
      const expr = !isFreeLiteral(value);
      const on = expr || locked.has(k) || !!e.fixed;
      return h(`button.lock-btn${on ? '.on' : ''}`, {
        html: icon(on ? 'lock' : 'unlock'), disabled: expr || !!e.fixed, 'aria-label': on ? `Free ${k}` : `Lock ${k}`,
        title: expr ? 'Driven by an expression' : e.fixed ? 'Entity is fixed' : on ? 'Driving dimension — click to let the solver change it' : 'Free — the solver may change it. Click to lock.',
        on: { click: (evt) => { evt.preventDefault(); app.applySketchAction({ ent: e.id, [on ? 'unlock' : 'lock']: [k] }, on ? 'Free dimension' : 'Lock dimension'); } },
      });
    };
    const fields = [];
    const keys = NUMERIC_FIELDS[e.type] || [];
    const row = h('div.field-row', { style: { gridTemplateColumns: '1fr 1fr' } });
    for (const k of keys) {
      const node = this.exprField({
        key: `ent-${k}`, label: FIELD_LABELS[k] + (k === 'rot' ? ' (°)' : ''), value: e[k], unit: k === 'n' ? '' : k === 'rot' ? 'deg' : 'mm',
        extra: k === 'n' ? null : lockBtn(k, e[k]),
        onCommit: (v) => (k === 'n' ? commit({ n: v }, 'Edit polygon') : app.setEntityFields(e.id, { [k]: v })),
      });
      row.append(node);
    }
    if (keys.length) fields.push(row);
    if (e.type === 'polyline') {
      const prow = h('div.field-row', { style: { gridTemplateColumns: '1fr 1fr' } });
      e.pts.forEach((p, i) => {
        for (const j of [0, 1]) {
          const key = `pts.${i}.${j}`;
          prow.append(this.exprField({
            key: `pt-${i}-${j}`, label: `P${i + 1} ${j ? 'Y' : 'X'}`, value: p[j], unit: 'mm', extra: lockBtn(key, p[j]),
            onCommit: (v) => {
              const r = app.applySketchAction({ ent: e.id, patch: { pts: e.pts.map((q, qi) => (qi === i ? (j ? [q[0], v] : [v, q[1]]) : q)) }, lock: [key] }, 'Edit dimension', true);
              if (!r.ok) toast('That value conflicts with the sketch constraints', 'err');
            },
          }));
        }
      });
      fields.push(prow, this.toggle({ label: 'Closed', value: e.closed, onChange: (v) => commit({ closed: v }) }));
    }
    if (ev && ev.error) fields.push(h('div.banner.err', { html: icon('error') }, h('div', { text: ev.error })));
    return h('div.card', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } }, h('h3', { text: ENTITY_NAMES[e.type], style: { margin: 0 } }),
        h('div', { style: { display: 'flex', gap: '2px' } },
          h('button.icon-btn', { html: icon('lock'), title: e.fixed ? 'Unfix' : 'Fix in place', class: e.fixed ? 'on' : '', on: { click: () => app.toggleFix([e.id]) } }),
          h('button.icon-btn', { html: icon('construction'), title: 'Toggle construction (X)', class: e.construction ? 'on' : '', on: { click: () => commit({ construction: !e.construction }, 'Toggle construction') } }),
          h('button.icon-btn', { html: icon('trash'), title: 'Delete (Del)', on: { click: () => app.sketcher.deleteSelected() } }))),
      ...fields,
      h('div.hint', { text: 'Typed values become driving dimensions (locked). Fields accept expressions such as plate_w/2 - 5.' }));
  }

  renderBodies() {
    const app = this.app;
    const ids = [...app.selection].filter((id) => app.result.bodies.some((b) => b.id === id));
    if (!ids.length) return this.renderWelcome();
    if (ids.length > 1) {
      return h('div.insp', {}, this.head('body', h('div.insp-title', { text: `${ids.length} bodies` }), 'Selection'),
        h('div.insp-body', {},
          h('dl.stats', {}, h('dt', { text: 'Total volume' }), h('dd', { text: volume(ids.reduce((s, id) => s + app.result.bodies.find((b) => b.id === id).volume, 0)) })),
          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' } },
            h('button.btn', { html: icon('combine'), on: { click: () => app.startCommand('combine') } }, h('span', { text: 'Combine' })),
            h('button.btn', { html: icon('move'), on: { click: () => app.startCommand('move') } }, h('span', { text: 'Move' })),
            h('button.btn', { html: icon('pattern'), on: { click: () => app.startCommand('pattern') } }, h('span', { text: 'Pattern' })),
            h('button.btn.danger', { html: icon('remove'), on: { click: () => app.removeBodies(ids) } }, h('span', { text: 'Remove' })))));
    }
    const id = ids[0];
    const b = app.result.bodies.find((x) => x.id === id);
    const color = app.bodyColor(id);
    const nameInput = h('input.doc-name', { value: app.bodyName(id), spellcheck: false, 'data-key': '__bodyname', 'aria-label': 'Body name', style: { width: '100%' } });
    nameInput.addEventListener('change', () => app.setBodyMeta(id, { name: nameInput.value.trim() || undefined }, 'Rename body'));
    nameInput.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') nameInput.blur(); });
    const custom = h('input', { type: 'color', value: color, title: 'Custom colour', style: { width: '28px', height: '24px', border: 0, padding: 0, background: 'none', cursor: 'pointer' } });
    custom.addEventListener('change', () => app.setBodyMeta(id, { color: custom.value }, 'Change colour'));
    const [lo, hi] = b.bbox;
    return h('div.insp', {}, this.head('body', nameInput, 'Solid body'),
      h('div.insp-body', {},
        h('div.field', {}, h('label', { text: 'Appearance' }),
          h('div.colors', {}, ...BODY_COLORS.map((c) => h(`button${c === color ? '.on' : ''}`, { style: { background: c }, title: c, 'aria-label': `Colour ${c}`, on: { click: () => app.setBodyMeta(id, { color: c }, 'Change colour') } })), custom)),
        this.toggle({ label: 'Visible', value: app.bodyVisible(id), onChange: (v) => app.setBodyMeta(id, { visible: v }, v ? 'Show body' : 'Hide body') }),
        h('div.field-heading', { text: 'Properties' }),
        h('dl.stats', {},
          h('dt', { text: 'Volume' }), h('dd', { text: volume(b.volume) }),
          h('dt', { text: 'Surface area' }), h('dd', { text: `${fmt(b.area, 1)} mm²` }),
          h('dt', { text: 'Mass (steel)' }), h('dd', { text: `${fmt((b.volume / 1000) * 7.85, 1)} g` }),
          h('dt', { text: 'Size X' }), h('dd', { text: `${fmt(hi[0] - lo[0], 2)} mm` }),
          h('dt', { text: 'Size Y' }), h('dd', { text: `${fmt(hi[1] - lo[1], 2)} mm` }),
          h('dt', { text: 'Size Z' }), h('dd', { text: `${fmt(hi[2] - lo[2], 2)} mm` }),
          h('dt', { text: 'Faces / edges' }), h('dd', { text: `${b.groups.length} / ${b.edgeInfo.length}` })),
        h('div.field-heading', { text: 'Actions' }),
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' } },
          h('button.btn', { html: icon('move'), on: { click: () => app.startCommand('move') } }, h('span', { text: 'Move' })),
          h('button.btn', { html: icon('mirror'), on: { click: () => app.startCommand('mirror') } }, h('span', { text: 'Mirror' })),
          h('button.btn', { html: icon('pattern'), on: { click: () => app.startCommand('pattern') } }, h('span', { text: 'Pattern' })),
          h('button.btn.danger', { html: icon('remove'), on: { click: () => app.removeBodies([id]) } }, h('span', { text: 'Remove' })))));
  }

  renderWelcome() {
    const app = this.app;
    const empty = !app.doc.features.length;
    const body = h('div.insp-body', {},
      h('div.card', {}, h('h3', { text: empty ? 'Start modeling' : 'How it works' }),
        h('ol.steps', {},
          h('li', { html: '<span><b>Sketch</b> on a plane — draw rectangles, circles, lines.</span>' }),
          h('li', { html: '<span><b>Extrude</b> or <b>Revolve</b> closed profiles into solids.</span>' }),
          h('li', { html: '<span><b>Fillet</b>, <b>Shell</b>, <b>Pattern</b>… everything is recorded in the timeline.</span>' }),
          h('li', { html: '<span>Use <b>Parameters</b> in any field, then change them to update the whole model.</span>' }))),
      empty ? h('button.btn', { html: icon('sparkle'), on: { click: () => app.loadExample() } }, h('span', { text: 'Open the example bracket' })) : null,
      h('div.field-heading', { text: 'Mouse' }),
      h('div.shortcuts', {},
        h('span', { text: 'Orbit' }), h('span', { html: '<kbd>Right-drag</kbd> or drag empty space' }),
        h('span', { text: 'Pan' }), h('span', { html: '<kbd>Middle-drag</kbd> / <kbd>Shift</kbd>+right' }),
        h('span', { text: 'Zoom' }), h('span', { html: '<kbd>Wheel</kbd> (to cursor)' }),
        h('span', { text: 'Select' }), h('span', { html: '<kbd>Click</kbd>, <kbd>Shift</kbd> to add' })),
      h('div.field-heading', { text: 'Keyboard' }),
      h('div.shortcuts', {},
        h('span', { text: 'Search all commands' }), h('span', { html: '<kbd>S</kbd> / <kbd>Ctrl K</kbd>' }),
        h('span', { text: 'Extrude · Fillet · Move' }), h('span', { html: '<kbd>E</kbd> <kbd>F</kbd> <kbd>M</kbd>' }),
        h('span', { text: 'Undo · Redo' }), h('span', { html: '<kbd>Ctrl Z</kbd> <kbd>Ctrl Y</kbd>' }),
        h('span', { text: 'All shortcuts' }), h('span', { html: '<kbd>?</kbd>' })));
    return h('div.insp', {}, this.head('sparkle', h('div.insp-title', { text: app.doc.name }), `${app.doc.features.length} features · ${app.result.bodies.length} bodies`,
      h('button.icon-btn', { html: icon('panelRight'), title: 'Collapse panel', 'aria-label': 'Collapse inspector', on: { click: () => this.ui.togglePanel('right') } })), body);
  }
}

/** Human-readable names for constraint references, e.g. "Line 2 end", "Rectangle 1 edge 3". */
function refDescriber(f) {
  const counters = {}, names = new Map();
  for (const e of f.entities) { counters[e.type] = (counters[e.type] || 0) + 1; names.set(e.id, `${ENTITY_NAMES[e.type]} ${counters[e.type]}`); }
  const part = (p) => {
    if (p === 'seg' || p === 'circ') return '';
    if (p === 'p1') return ' start';
    if (p === 'p2') return ' end';
    if (p === 'c') return ' center';
    const m = /^([vesa])\w*?(\d+)$/.exec(p);
    if (m) return ` ${{ v: 'pt', e: 'edge', s: 'seg', a: 'arc' }[m[1]] || ''} ${+m[2] + 1}`;
    return ` ${p}`;
  };
  return (ref) => {
    if (ref === 'origin') return 'Origin';
    if (ref === 'xaxis') return 'X axis';
    if (ref === 'yaxis') return 'Y axis';
    const [id, p] = ref.split(':');
    return `${names.get(id) || '?'}${part(p)}`;
  };
}

function volume(v) {
  return v > 1e5 ? `${fmt(v / 1000, 2)} cm³` : `${fmt(v, 1)} mm³`;
}

function entityMeta(e) {
  switch (e.type) {
    case 'rect': return `${fmt(Math.abs(e.w), 2)} × ${fmt(Math.abs(e.h), 2)}`;
    case 'circle': return `⌀ ${fmt(e.d, 2)}`;
    case 'polygon': return `${e.n} × R${fmt(e.r, 2)}`;
    case 'slot': return `W ${fmt(e.w, 2)}`;
    case 'line': return `L ${fmt(Math.hypot(e.x2 - e.x1, e.y2 - e.y1), 2)}`;
    case 'polyline': return `${e.pts.length} pts`;
    default: return '';
  }
}
