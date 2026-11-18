// Floating, context-aware toolbar (switches between modeling and sketching tools).
import { h, clear, tooltip, contextMenu } from './dom.js';
import { icon } from './icons.js';
import { MODEL_TOOLBAR, SKETCH_TOOLBAR, ASSEMBLY_TOOLBAR } from './commands.js';

export class Toolbar {
  constructor(host, app, commands) {
    this.app = app;
    this.byId = new Map(commands.map((c) => [c.id, c]));
    this.el = h('div.floating-toolbar', { role: 'toolbar', 'aria-label': 'Modeling tools' });
    host.append(this.el);
    this.host = host;
    for (const evt of ['mode', 'command', 'sketchTool', 'selection', 'suggestion', 'result']) app.on(evt, () => this.render());
    new ResizeObserver(() => this.fit()).observe(host);
    this.render();
  }

  /** Switch to icon-only mode when space is tight, and keep the view cube clear of the toolbar. */
  fit() {
    const avail = this.host.clientWidth - 24;
    this.el.classList.remove('compact');
    if (this.el.scrollWidth > avail) this.el.classList.add('compact');
    const cube = document.getElementById('viewcube');
    if (!cube) return;
    cube.style.top = '10px';
    const t = this.el.getBoundingClientRect(), c = cube.getBoundingClientRect();
    const overlap = t.right > c.left - 8 && t.left < c.right && t.bottom > c.top && window.innerWidth > 820;
    if (overlap) cube.style.top = `${t.bottom - this.host.getBoundingClientRect().top + 10}px`;
  }

  button(id) {
    const c = this.byId.get(id);
    const primary = id === 'finish-sketch';
    const suggest = id === 'extrude' && this.app.suggestion && !this.app.cmd;
    const b = h(`button.tool${primary ? '.primary' : ''}${c.active?.() ? '.active' : ''}${suggest ? '.suggest' : ''}`, {
      html: icon(c.icon), 'aria-label': c.label, on: { click: () => c.run() },
    }, h('span', { text: primary ? c.label : c.short || c.label.replace(' / Copy', '').replace('Center rect', 'Ctr rect') }));
    tooltip(b, { title: c.label, desc: c.desc, key: c.key });
    return b;
  }

  menuButton(spec) {
    const anyActive = spec.items.some((id) => this.byId.get(id).active?.());
    const b = h(`button.tool${anyActive ? '.active' : ''}`, { html: icon(spec.icon), 'aria-label': spec.menu, 'aria-haspopup': 'menu' },
      h('span', { html: `${spec.menu} ▾` }));
    b.addEventListener('click', () => {
      const r = b.getBoundingClientRect();
      contextMenu(r.left, r.bottom + 6, spec.items.map((id) => { const c = this.byId.get(id); return { label: c.label, icon: c.icon, key: c.key, run: c.run }; }));
    });
    tooltip(b, { title: spec.menu, desc: spec.items.map((id) => this.byId.get(id).label).join(', ') });
    return b;
  }

  render() {
    clear(this.el);
    const layout = this.app.mode === 'sketch' ? SKETCH_TOOLBAR : this.app.isAssembly ? ASSEMBLY_TOOLBAR : MODEL_TOOLBAR;
    for (const g of layout) {
      const group = h('div.tb-group');
      if (g.label) group.append(h('div.tb-label', { text: g.label }));
      for (const it of g.items) group.append(typeof it === 'string' ? this.button(it) : this.menuButton(it));
      this.el.append(group);
    }
    this.fit();
  }
}
