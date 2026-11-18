// Left "Browser" panel: origin planes, bodies and sketches with visibility toggles.
import { h, clear, iconEl, contextMenu } from './dom.js';
import { icon } from './icons.js';
import { activeFeatures } from '../model/features.js';

export class Browser {
  constructor(el, app, ui) {
    this.el = el;
    this.app = app;
    this.ui = ui;
    this.open = { origin: false, bodies: true, sketches: true, params: false };
    this.renaming = null;
    for (const evt of ['doc', 'result', 'selection', 'mode', 'command']) app.on(evt, () => this.render());
    this.render();
  }

  section(key, label, iconName, count, children, extra) {
    const caret = iconEl('caret', `caret${this.open[key] ? ' open' : ''}`);
    const row = h('div.tree-row', { on: { click: () => { this.open[key] = !this.open[key]; this.render(); } } },
      caret, iconEl(iconName, 'ico'), h('span.name', { text: label }), count != null ? h('span.count', { text: count }) : null, extra);
    const wrap = h('div.tree-section', {}, row);
    if (this.open[key]) wrap.append(h('div.tree-children', {}, children));
    return wrap;
  }

  eyeBtn(visible, onToggle, label) {
    const b = h(`button.icon-btn.row-btn${visible ? '' : '.keep'}`, { html: icon(visible ? 'eye' : 'eyeOff'), title: visible ? `Hide ${label}` : `Show ${label}`, 'aria-label': visible ? `Hide ${label}` : `Show ${label}` });
    b.addEventListener('click', (e) => { e.stopPropagation(); onToggle(); });
    return b;
  }

  nameNode(id, name, onRename) {
    if (this.renaming === id) {
      const input = h('input.rename', { value: name, spellcheck: false });
      const done = (ok) => { if (this.renaming !== id) return; this.renaming = null; if (ok && input.value.trim() && input.value !== name) onRename(input.value.trim()); else this.render(); };
      input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
      input.addEventListener('blur', () => done(true));
      input.addEventListener('click', (e) => e.stopPropagation());
      setTimeout(() => { input.focus(); input.select(); });
      return h('span.name', {}, input);
    }
    return h('span.name', { text: name });
  }

  render() {
    const app = this.app;
    clear(this.el);
    const head = h('div.panel-head', {}, h('span', { text: 'Browser' }),
      h('button.icon-btn', { html: icon('panelLeft'), title: 'Collapse panel', 'aria-label': 'Collapse browser panel', on: { click: () => this.ui.togglePanel('left') } }));
    const tree = h('div.tree');

    // parameters
    const params = app.doc.params;
    tree.append(h('div.tree-section', {}, h('div.tree-row', { on: { click: () => this.ui.openParams() } },
      h('span', { style: { width: '14px' } }), iconEl('params', 'ico'), h('span.name', { text: 'Parameters' }), h('span.count', { text: params.length || '' }))));

    // origin
    const planes = ['XY', 'XZ', 'YZ'].map((p) => h('div.tree-row', {
      on: {
        click: () => { if (app.cmd && app.cmd.type === 'sketchPlane') app.createSketch({ type: 'std', name: p, offset: '0' }); },
        mouseenter: () => app.vp.setHover({ kind: 'plane', plane: p }), mouseleave: () => app.vp.setHover(null),
      },
    }, iconEl('plane', 'ico'), h('span.name', { text: `${p} plane` })));
    tree.append(this.section('origin', 'Origin', 'origin', null, planes,
      this.eyeBtn(app.vp.planeGroup.visible, () => { app.vp.showOriginPlanes(!app.vp.planeGroup.visible); this.render(); }, 'origin planes')));

    // bodies
    const bodies = app.result.bodies;
    const bodyRows = bodies.length ? bodies.map((b) => {
      const vis = app.bodyVisible(b.id);
      const sel = app.selection.has(b.id);
      const row = h(`div.tree-row${sel ? '.selected' : ''}${vis ? '' : '.dim'}`, {
        on: {
          click: (e) => app.selectBodies([b.id], e.shiftKey || e.ctrlKey),
          dblclick: () => { this.renaming = b.id; this.render(); },
          contextmenu: (e) => { e.preventDefault(); this.ui.bodyMenu(b.id, e.clientX, e.clientY); },
          mouseenter: () => app.vp.setHover({ kind: 'body', bodyId: b.id }), mouseleave: () => app.vp.setHover(null),
        },
      }, h('span.swatch', { style: { background: app.bodyColor(b.id) } }), this.nameNode(b.id, app.bodyName(b.id), (n) => app.setBodyMeta(b.id, { name: n }, 'Rename body')),
      this.eyeBtn(vis, () => app.setBodyMeta(b.id, { visible: !vis }, vis ? 'Hide body' : 'Show body'), 'body'));
      return row;
    }) : [h('div.tree-empty', { text: 'No bodies yet' })];
    tree.append(this.section('bodies', 'Bodies', 'body', bodies.length, bodyRows));

    // sketches
    const sketches = activeFeatures(app.doc).filter((f) => f.type === 'sketch');
    const skRows = sketches.length ? sketches.map((f) => {
      const vis = app.sketchVisible(f);
      const editing = app.mode === 'sketch' && app.sketchId === f.id;
      return h(`div.tree-row${editing ? '.selected' : ''}${vis ? '' : '.dim'}`, {
        on: {
          dblclick: () => app.enterSketch(f.id),
          contextmenu: (e) => { e.preventDefault(); this.ui.featureMenu(f.id, e.clientX, e.clientY); },
        },
        title: 'Double-click to edit',
      }, iconEl('sketch', 'ico'), this.nameNode(f.id, f.name, (n) => app.renameFeature(f.id, n)),
      this.eyeBtn(vis, () => app.toggleSketchVisibility(f.id), 'sketch'));
    }) : [h('div.tree-empty', { text: 'No sketches yet' })];
    tree.append(this.section('sketches', 'Sketches', 'folder', sketches.length, skRows));

    this.el.append(head, tree);
  }

  startRename(id) { this.renaming = id; this.render(); }
}
