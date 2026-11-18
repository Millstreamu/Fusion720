// Parametric history timeline with a draggable rollback marker.
import { h, clear, tooltip } from './dom.js';
import { icon } from './icons.js';
import { FEATURES } from '../model/features.js';
import { JOINT_TYPES } from '../model/assembly.js';

export class Timeline {
  constructor(el, app, ui) {
    this.el = el;
    this.app = app;
    this.ui = ui;
    for (const evt of ['doc', 'result', 'command', 'mode', 'selection']) app.on(evt, () => this.render());
    this.render();
  }

  renderAssembly() {
    const app = this.app, asm = app.asm, doc = app.doc;
    clear(this.el);
    const failing = asm.status.failing || new Set();
    const track = h('div.tl-track', { role: 'list', 'aria-label': 'Joints' });
    track.append(h('span.tl-empty', { style: { paddingLeft: '0', paddingRight: '6px', whiteSpace: 'nowrap' }, text: `${doc.components.length} components · ${doc.joints.length} joints${doc.joints.length ? ` · ${asm.status.dof ?? 0} DOF` : ''}` }));
    if (!doc.joints.length) track.append(h('span.tl-empty', { text: '— insert parts, then use Joint (J) to connect them' }));
    const editingId = app.cmd && app.cmd.type === 'joint' ? app.cmd.editId : null;
    for (const j of doc.joints) {
      const cls = ['chip', j.suppressed ? 'suppressed' : '', failing.has(j.id) ? 'err' : '', editingId === j.id ? 'editing' : '', app.selectedJoint === j.id ? 'selected' : ''].filter(Boolean).join('.');
      const chip = h(`div.${cls}`, {
        role: 'listitem', tabindex: 0, html: icon(failing.has(j.id) ? 'error' : JOINT_TYPES[j.type].icon),
        on: {
          click: () => asm.selectJoint(j.id),
          dblclick: () => asm.startJoint(j.id),
          keydown: (e) => { if (e.key === 'Enter') asm.startJoint(j.id); },
          contextmenu: (e) => { e.preventDefault(); this.ui.jointMenu(j.id, e.clientX, e.clientY); },
        },
      }, h('span.chip-name', { text: j.name }));
      tooltip(chip, { title: j.name, desc: `${JOINT_TYPES[j.type].label}: ${asm.comp(j.a.comp)?.name} → ${asm.comp(j.b.comp)?.name}${failing.has(j.id) ? ' — can’t be satisfied' : ''}` });
      track.append(chip);
    }
    if (app.cmd && app.cmd.type === 'joint' && !editingId) track.append(h('div.chip.draft', { html: icon(JOINT_TYPES[app.cmd.joint.type].icon) }, h('span.chip-name', { text: app.cmd.joint.name })));
    this.el.append(track);
  }

  render() {
    const app = this.app;
    if (app.isAssembly) return this.renderAssembly();
    const feats = app.doc.features;
    const marker = app.doc.marker == null ? feats.length : app.doc.marker;
    clear(this.el);
    const ctl = (name, title, fn, disabled) => {
      const b = h('button.icon-btn', { html: icon(name), 'aria-label': title, disabled, on: { click: fn } });
      tooltip(b, { title });
      return b;
    };
    const controls = h('div.tl-controls', {},
      ctl('first', 'Roll back to start', () => app.moveMarker(0), marker === 0),
      ctl('prev', 'Step back', () => app.moveMarker(marker - 1), marker === 0),
      ctl('next', 'Step forward', () => app.moveMarker(marker + 1), marker >= feats.length),
      ctl('last', 'Roll to end', () => app.moveMarker(feats.length), marker >= feats.length));
    const track = h('div.tl-track', { role: 'list', 'aria-label': 'Feature history' });
    if (!feats.length && !(app.cmd && app.cmd.draft)) track.append(h('span.tl-empty', { text: 'Your modeling history will appear here' }));
    const editingId = app.cmd && app.cmd.editId;
    const sketchId = app.mode === 'sketch' ? app.sketchId : null;
    const chips = [];
    const hasDraft = !editingId && app.cmd && app.cmd.draft;
    feats.forEach((f, i) => {
      if (i === marker) { if (hasDraft) track.append(this.draftChip()); track.append(this.markerEl(chips, feats.length)); }
      const err = app.result.errors[f.id] && i < marker;
      const warn = app.result.warnings[f.id] && i < marker;
      const cls = ['chip', i >= marker ? 'rolled' : '', f.suppressed ? 'suppressed' : '', err ? 'err' : warn ? 'warn' : '', editingId === f.id || sketchId === f.id ? 'editing' : ''].filter(Boolean).join('.');
      const chip = h(`div.${cls}`, {
        role: 'listitem', tabindex: 0, 'data-index': i,
        html: icon(err ? 'error' : FEATURES[f.type]?.icon || 'info'),
        on: {
          dblclick: () => app.editFeature(f.id),
          keydown: (e) => { if (e.key === 'Enter') app.editFeature(f.id); },
          contextmenu: (e) => { e.preventDefault(); this.ui.featureMenu(f.id, e.clientX, e.clientY); },
        },
      }, h('span.chip-name', { text: f.name }));
      tooltip(chip, { title: f.name, desc: err ? `⚠ ${app.result.errors[f.id]}` : warn ? `⚠ ${app.result.warnings[f.id]}` : `${FEATURES[f.type]?.label} · double-click to edit, right-click for more` });
      chips.push(chip);
      track.append(chip);
    });
    if (marker >= feats.length) {
      if (hasDraft) track.append(this.draftChip());
      track.append(this.markerEl(chips, feats.length));
    }
    this.el.append(controls, track);
    const m = track.querySelector('.tl-marker');
    if (m) m.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  draftChip() {
    const c = this.app.cmd;
    return h('div.chip.draft', { html: icon(FEATURES[c.type].icon) }, h('span.chip-name', { text: c.draft.name }));
  }

  markerEl(chips, total) {
    const m = h('div.tl-marker', { title: 'Drag to roll back the timeline', role: 'slider', 'aria-label': 'Timeline marker', 'aria-valuemin': 0, 'aria-valuemax': total, tabindex: 0 });
    m.addEventListener('keydown', (e) => {
      const cur = this.app.doc.marker == null ? total : this.app.doc.marker;
      if (e.key === 'ArrowLeft') this.app.moveMarker(cur - 1);
      if (e.key === 'ArrowRight') this.app.moveMarker(cur + 1);
    });
    m.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      m.setPointerCapture(e.pointerId);
      let target = null;
      const drop = h('div.tl-drop');
      const move = (ev) => {
        let idx = chips.length;
        for (let i = 0; i < chips.length; i++) {
          const r = chips[i].getBoundingClientRect();
          if (ev.clientX < r.left + r.width / 2) { idx = i; break; }
        }
        target = idx;
        drop.remove();
        if (idx < chips.length) chips[idx].before(drop); else chips[chips.length - 1]?.after(drop);
      };
      const up = () => {
        m.removeEventListener('pointermove', move);
        m.removeEventListener('pointerup', up);
        drop.remove();
        if (target != null) this.app.moveMarker(target);
      };
      m.addEventListener('pointermove', move);
      m.addEventListener('pointerup', up);
    });
    return m;
  }
}
