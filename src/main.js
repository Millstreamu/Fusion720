// Fusion720 — bootstrap and UI wiring.
import { Viewport } from './viewer/viewport.js';
import { Sketcher } from './viewer/sketcher.js';
import { Kernel } from './kernel/client.js';
import { App } from './app.js';
import { h, clear, tooltip, toast, contextMenu, modal, promptText } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { buildCommands } from './ui/commands.js';
import { Toolbar } from './ui/toolbar.js';
import { Browser } from './ui/browser.js';
import { Inspector } from './ui/inspector.js';
import { Timeline } from './ui/timeline.js';
import { openPalette } from './ui/palette.js';
import { openParams } from './ui/params.js';
import { FEATURES } from './model/features.js';
import { openLibrary } from './ui/library.js';

const $ = (id) => document.getElementById(id);
const appEl = $('app');
const wrap = $('viewport-wrap');

// ---------------------------------------------------------------- theme
const THEME_KEY = 'fusion720.theme';
let dark = (() => {
  try { const t = localStorage.getItem(THEME_KEY); if (t) return t === 'dark'; } catch { /* ignore */ }
  return !window.matchMedia || window.matchMedia('(prefers-color-scheme: dark)').matches;
})();

// ---------------------------------------------------------------- core objects
const vp = new Viewport($('viewport'), $('viewcube'));
const loadingBar = $('loading-bar'), loadingDetail = $('loading-detail');
const kernel = new Kernel({
  onProgress: (loaded, total) => {
    loadingBar.style.width = `${Math.min(100, (100 * loaded) / total).toFixed(1)}%`;
    loadingDetail.textContent = `Downloading OpenCascade… ${(loaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB (cached after the first visit)`;
  },
  onReady: () => {
    $('loading').classList.add('done');
    setTimeout(() => $('loading').classList.add('hidden'), 450);
    setKernelPill('ready');
    app.kernelReady();
  },
  onFatal: (err) => {
    loadingDetail.textContent = `The geometry kernel could not start: ${err}. Check your internet connection (the kernel loads from cdn.jsdelivr.net) and reload.`;
    loadingDetail.style.color = 'var(--err)';
    setKernelPill('error');
  },
});
const app = new App({ kernel, viewport: vp });
app.sketcher = new Sketcher(app, vp, $('hud'));
// pointer handling: the sketcher (sketch mode) first, then assembly dragging
const handlers = [app.sketcher, app.asm];
vp.interceptor = {
  wantsLeft: () => handlers.some((x) => x.wantsLeft?.()),
  pointerdown: (e) => handlers.some((x) => x.pointerdown?.(e)),
  pointermove: (e) => handlers.some((x) => x.pointermove?.(e)),
  pointerup: (e, click) => handlers.some((x) => x.pointerup?.(e, click)),
  pointerleave: () => handlers.some((x) => x.pointerleave?.()),
  dblclick: (e) => handlers.forEach((x) => x.dblclick?.(e)),
};

// ---------------------------------------------------------------- UI helpers exposed to panels/commands
const ui = {
  openParams: () => openParams(app),
  openFilePicker: () => fileInput.click(),
  toggleSection,
  toggleOrtho: () => { vp.setProjection(!vp.isOrtho); renderViewControls(); },
  cycleDisplay: () => {
    const order = ['shadedEdges', 'shaded', 'wire'];
    vp.setDisplayMode(order[(order.indexOf(vp.displayMode) + 1) % order.length]);
    renderViewControls();
  },
  toggleTheme: () => setTheme(!dark),
  togglePanel,
  showShortcuts,
  featureMenu,
  bodyMenu,
  componentMenu,
  jointMenu,
  openLibrary: (mode = 'open') => openLibrary(app, { mode, onFile: () => fileInput.click() }),
};

const commands = buildCommands(app, ui);
const cmdById = new Map(commands.map((c) => [c.id, c]));
new Toolbar(wrap, app, commands);
const browser = new Browser($('browser'), app, ui);
const inspector = new Inspector($('inspector'), app, ui);
const timeline = new Timeline($('timeline'), app, ui);

// ---------------------------------------------------------------- top bar
const fileInput = h('input', { type: 'file', accept: '.json,.f720,application/json', style: { display: 'none' } });
fileInput.addEventListener('change', () => { if (fileInput.files[0]) app.openFile(fileInput.files[0]); fileInput.value = ''; });
document.body.append(fileInput);

function topButton(iconName, label, title, onClick, showLabel = false) {
  const b = h('button.icon-btn', { html: icon(iconName), 'aria-label': title, on: { click: onClick } }, showLabel ? h('span.lbl', { text: label }) : null);
  tooltip(b, { title, key: cmdById.get(label.toLowerCase())?.key });
  return b;
}
const undoBtn = topButton('undo', 'Undo', 'Undo (Ctrl+Z)', () => app.undo());
const redoBtn = topButton('redo', 'Redo', 'Redo (Ctrl+Y)', () => app.redo());
const exportBtn = h('button.icon-btn', { html: icon('download'), 'aria-label': 'Export', 'aria-haspopup': 'menu' }, h('span.lbl', { text: 'Export' }));
exportBtn.addEventListener('click', () => {
  const r = exportBtn.getBoundingClientRect();
  contextMenu(r.left, r.bottom + 6, [
    { label: 'STEP (.step) — for CAD', icon: 'download', run: () => app.exportFile('step') },
    { label: 'STL (.stl) — for 3D printing', icon: 'download', run: () => app.exportFile('stl') },
    '-',
    { label: 'Design file (.f720.json)', icon: 'save', key: 'Ctrl+S', run: () => app.saveFile() },
  ]);
});
tooltip(exportBtn, { title: 'Export', desc: 'STEP for other CAD tools, STL for 3D printing' });
const newBtn = h('button.icon-btn', { html: icon('file'), 'aria-label': 'New', 'aria-haspopup': 'menu' }, h('span.lbl', { text: 'New' }));
newBtn.addEventListener('click', () => {
  const r = newBtn.getBoundingClientRect();
  contextMenu(r.left, r.bottom + 6, [
    { label: 'New part', icon: 'body', run: () => app.newDocument() },
    { label: 'New assembly', icon: 'assembly', run: () => app.newAssemblyDoc() },
    '-',
    { label: 'Example part: bracket', icon: 'sparkle', run: () => app.loadExample() },
    { label: 'Example assembly: hinge', icon: 'sparkle', run: () => app.loadExampleAssembly() },
  ]);
});
tooltip(newBtn, { title: 'New', desc: 'Start a new part or assembly. Everything is kept in My designs.' });
const openBtn = h('button.icon-btn', { html: icon('folder'), 'aria-label': 'My designs', on: { click: () => ui.openLibrary('open') } }, h('span.lbl', { text: 'Open' }));
tooltip(openBtn, { title: 'My designs', desc: 'Open any part or assembly saved in this browser, or a file', key: 'Ctrl+O' });
const returnChip = h('button.return-chip.hidden', { html: icon('prev'), on: { click: () => app.returnTo && app.openDesign(app.returnTo.id) } });
$('file-actions').append(
  newBtn, openBtn,
  topButton('save', 'Save', 'Download design file (Ctrl+S)', () => app.saveFile()),
  exportBtn, undoBtn, redoBtn, returnChip,
);
function renderReturn() {
  const r = app.returnTo;
  returnChip.classList.toggle('hidden', !r);
  if (r) { returnChip.innerHTML = `${icon('prev')}<span>Back to ${escapeHtml(r.name)}</span>`; }
  $('save-state').innerHTML = `${escapeHtml($('save-state').dataset.text || 'Saved')}${app.isAssembly ? '<span class="kind-badge">Assembly</span>' : ''}`;
}
app.on('returnTo', renderReturn);
app.on('mode', renderReturn);
$('palette-btn').addEventListener('click', () => openPalette(commands));

const docName = $('doc-name');
docName.addEventListener('change', () => app.renameDoc(docName.value.trim()));
docName.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') docName.blur(); });
app.on('doc', () => { if (document.activeElement !== docName) docName.value = app.doc.name; undoBtn.disabled = !app.undoStack.length; redoBtn.disabled = !app.redoStack.length; });
app.on('saveState', (s) => { $('save-state').dataset.text = s; renderReturn(); });

function setTheme(d) {
  dark = d;
  document.documentElement.dataset.theme = d ? 'dark' : 'light';
  $('theme-btn').innerHTML = icon(d ? 'sun' : 'moon');
  $('theme-btn').setAttribute('aria-label', d ? 'Switch to light theme' : 'Switch to dark theme');
  try { localStorage.setItem(THEME_KEY, d ? 'dark' : 'light'); } catch { /* ignore */ }
  vp.setTheme(d);
  app.refreshSketches();
}
$('theme-btn').addEventListener('click', () => setTheme(!dark));
setTheme(dark);

// ---------------------------------------------------------------- panels
const narrow = () => window.innerWidth <= 820;
function togglePanel(side) {
  if (narrow()) {
    const cls = side === 'left' ? 'show-left' : 'show-right';
    appEl.classList.toggle(cls);
    appEl.classList.remove(side === 'left' ? 'show-right' : 'show-left');
  } else appEl.classList.toggle(side === 'left' ? 'left-collapsed' : 'right-collapsed');
  renderPanelToggles();
}
const leftToggle = h('div.panel-toggle.left'), rightToggle = h('div.panel-toggle.right');
wrap.append(leftToggle, rightToggle);
function renderPanelToggles() {
  const n = narrow();
  clear(leftToggle); clear(rightToggle);
  if (n || appEl.classList.contains('left-collapsed')) leftToggle.append(h('button.icon-btn', { html: icon('panelLeft'), title: 'Show browser', 'aria-label': 'Show browser panel', on: { click: () => togglePanel('left') } }));
  if (n || appEl.classList.contains('right-collapsed')) rightToggle.append(h('button.icon-btn', { html: icon('panelRight'), title: 'Show inspector', 'aria-label': 'Show inspector panel', on: { click: () => togglePanel('right') } }));
}
window.addEventListener('resize', renderPanelToggles);
renderPanelToggles();

// ---------------------------------------------------------------- view controls + section
let sectionState = { axis: 'X', offset: 0 };
let sectionPop = null;
function toggleSection() {
  if (vp.section) { vp.setSection(null); sectionPop?.remove(); sectionPop = null; }
  else {
    const box = vp.sceneBounds();
    if (!box.isEmpty()) { const c = box.getCenter(box.min.clone()); sectionState.offset = +c[sectionState.axis.toLowerCase()].toFixed(2); }
    vp.setSection(sectionState);
    showSectionPop();
  }
  renderViewControls();
  app.emit('suggestion');
}
function showSectionPop() {
  sectionPop?.remove();
  const box = vp.sceneBounds();
  const ax = sectionState.axis.toLowerCase();
  const min = box.isEmpty() ? -100 : Math.floor(box.min[ax] - 1), max = box.isEmpty() ? 100 : Math.ceil(box.max[ax] + 1);
  const slider = h('input', { type: 'range', min, max, step: (max - min) / 400, value: sectionState.offset, 'aria-label': 'Section offset', style: { width: '160px' } });
  const val = h('span', { text: `${sectionState.offset.toFixed(1)} mm`, style: { font: '11.5px var(--mono)', minWidth: '62px', textAlign: 'right' } });
  slider.addEventListener('input', () => { sectionState.offset = +slider.value; val.textContent = `${sectionState.offset.toFixed(1)} mm`; vp.setSection(sectionState); });
  const seg = h('div.seg', {}, ['X', 'Y', 'Z'].map((a) => h(`button${a === sectionState.axis ? '.on' : ''}`, { text: a, on: { click: () => { sectionState.axis = a; const c = box.isEmpty() ? 0 : (box.min[a.toLowerCase()] + box.max[a.toLowerCase()]) / 2; sectionState.offset = +c.toFixed(2); vp.setSection(sectionState); showSectionPop(); } } })));
  sectionPop = h('div.suggest-chip', { style: { bottom: '60px' } }, h('span', { html: icon('section') }), seg, slider, val,
    h('button.icon-btn', { html: icon('x'), title: 'Close section view', on: { click: toggleSection } }));
  wrap.append(sectionPop);
}

const viewControls = $('view-controls');
function vcButton(iconName, title, onClick, on = false) {
  const b = h(`button.icon-btn${on ? '.on' : ''}`, { html: icon(iconName), 'aria-label': title, on: { click: onClick } });
  tooltip(b, { title });
  return b;
}
function renderViewControls() {
  clear(viewControls);
  const modes = { shadedEdges: ['shaded', 'Shaded with edges'], shaded: ['body', 'Shaded'], wire: ['wireframe', 'Wireframe'] };
  const [mi, ml] = modes[vp.displayMode];
  viewControls.append(
    vcButton('home', 'Home view (Home)', () => vp.setView('home')),
    vcButton('fit', 'Fit all (F6)', () => vp.fit()),
    h('div.sep'),
    vcButton(vp.isOrtho ? 'ortho' : 'perspective', vp.isOrtho ? 'Orthographic — click for perspective' : 'Perspective — click for orthographic', ui.toggleOrtho),
    vcButton(mi, `Display: ${ml} (click to change)`, ui.cycleDisplay),
    vcButton('grid', 'Toggle grid', () => { vp.grid.mesh.visible = !vp.grid.mesh.visible; vp.requestRender(); renderViewControls(); }, vp.grid.mesh.visible),
    vcButton('section', 'Section view', toggleSection, !!vp.section),
    h('div.sep'),
    vcButton('params', 'Parameters (Ctrl+P)', ui.openParams),
  );
}
renderViewControls();

// ---------------------------------------------------------------- welcome + suggestion
const welcome = h('div.welcome');
const suggestChip = h('div.suggest-chip.hidden');
wrap.append(welcome, suggestChip);
function renderOverlays() {
  const asmEmpty = app.isAssembly && !app.doc.components.length && !app.cmd;
  const empty = (!app.isAssembly && !app.doc.features.length && !app.cmd && app.mode === 'model') || asmEmpty;
  welcome.classList.toggle('hidden', !empty);
  if (empty && welcome.dataset.kind !== (asmEmpty ? 'asm' : 'part')) { clear(welcome); welcome.dataset.kind = asmEmpty ? 'asm' : 'part'; }
  if (asmEmpty && !welcome.firstChild) {
    welcome.append(
      h('h2', { text: 'Put your parts together' }),
      h('p', { text: 'Insert parts you’ve modelled, then join them with hinges, sliders or rigid joints.' }),
      h('div.actions', {},
        h('button.btn.primary', { html: icon('insert'), on: { click: () => ui.openLibrary('insert') } }, h('span', { text: 'Insert a part' })),
        h('button.btn', { html: icon('sparkle'), on: { click: () => app.loadExampleAssembly() } }, h('span', { text: 'Open example assembly' }))));
  } else if (empty && !welcome.firstChild) {
    welcome.append(
      h('h2', { text: 'What will you design today?' }),
      h('p', { text: 'Start with a sketch, drop in a primitive, or explore the example.' }),
      h('div.actions', {},
        h('button.btn.primary', { html: icon('sketch'), on: { click: () => app.startSketchFlow() } }, h('span', { text: 'Create sketch' })),
        h('button.btn', { html: icon('box'), on: { click: () => app.startCommand('box') } }, h('span', { text: 'Box' })),
        h('button.btn', { html: icon('sparkle'), on: { click: () => app.loadExample() } }, h('span', { text: 'Open example' }))));
  }
  const s = app.suggestion && !app.cmd && app.mode === 'model' && !vp.section;
  suggestChip.classList.toggle('hidden', !s);
  if (s) {
    clear(suggestChip);
    suggestChip.append(h('span', { text: 'Sketch ready.' }),
      h('button.btn.primary', { html: icon('extrude'), style: { height: '30px' }, on: { click: () => app.startCommand('extrude') } }, h('span', { text: 'Extrude' }), h('kbd', { text: 'E' })),
      h('button.btn', { html: icon('revolve'), style: { height: '30px' }, on: { click: () => app.startCommand('revolve') } }, h('span', { text: 'Revolve' })),
      h('button.icon-btn', { html: icon('x'), title: 'Dismiss', 'aria-label': 'Dismiss suggestion', on: { click: () => { app.suggestion = null; renderOverlays(); app.emit('suggestion'); } } }));
  }
  $('sketch-banner').classList.toggle('hidden', app.mode !== 'sketch');
  if (app.mode === 'sketch') {
    const f = app.activeSketch();
    $('sketch-banner').innerHTML = `${icon('sketch')}<span>Editing <b>${escapeHtml(f ? f.name : '')}</b> — press <kbd>Ctrl Enter</kbd> to finish</span>`;
  }
}
for (const evt of ['doc', 'command', 'mode', 'selection', 'suggestion']) app.on(evt, renderOverlays);
renderOverlays();

// ---------------------------------------------------------------- status bar
function setKernelPill(state, ms) {
  const el = $('status-kernel');
  el.className = 'pill';
  if (state === 'ready') { el.classList.add('ok'); el.textContent = ms != null ? `Kernel ready · ${ms} ms` : 'Kernel ready'; }
  else if (state === 'busy') { el.classList.add('busy'); el.textContent = 'Computing…'; }
  else if (state === 'error') { el.textContent = 'Kernel failed'; el.style.color = 'var(--err)'; }
}
app.on('busy', (b) => { if (kernel.isReady) setKernelPill(b ? 'busy' : 'ready', app.result.ms); });
function statusHint() {
  const c = app.cmd;
  if (app.mode === 'sketch') {
    const t = app.sketcher.tool;
    if (t === 'constraint') return 'Click the geometry to constrain · glyphs show existing constraints (right-click one to delete) · <kbd>Esc</kbd> to stop';
    if (t === 'fillet') return 'Click a corner to round it · type a number to change the radius · <kbd>Esc</kbd> to stop';
    if (t === 'trim') return 'Click the piece to remove (shown in red) · <kbd>Esc</kbd> to stop';
    if (t === 'extend') return 'Click near the end of a line to stretch it to the next curve · <kbd>Esc</kbd> to stop';
    if (t === 'offset') return 'Click a curve or shape to copy it parallel · type the distance · <kbd>Shift</kbd> for the other side';
    if (t === 'project') return 'Click model edges to copy them into the sketch · <kbd>Esc</kbd> to stop';
    if (t === 'arc') return 'Click the start, the end, then a point on the arc · <kbd>Esc</kbd> to stop';
    if (t === 'line') return 'Click to place points · <kbd>A</kbd> tangent arcs on/off · type numbers for exact dimensions · <kbd>Esc</kbd> stop';
    if (t === 'dimension') return 'Click a line or circle, or two items, then type the value · right-click a dimension to remove it · <kbd>Esc</kbd> to stop';
    if (t === 'select') return 'Click to select · drag points to reshape (constraints are kept) · <kbd>D</kbd> dimension · <kbd>H</kbd> horiz/vert · <kbd>Del</kbd> deletes';
    return 'Click to place points · type numbers for exact dimensions · <kbd>Tab</kbd> next field · <kbd>Esc</kbd> stop';
  }
  if (c && c.type === 'sketchPlane') return 'Select an origin plane or a flat face to sketch on · <kbd>Esc</kbd> to cancel';
  if (c && c.type === 'measure') return 'Click points on faces or edges to measure · <kbd>Esc</kbd> to finish';
  if (c && c.type === 'joint') return c.pick ? `Click a flat face, circular edge or straight edge on the ${c.pick === 'a' ? 'first' : 'second'} component · <kbd>Esc</kbd> to cancel` : 'Choose the joint type and adjust · <kbd>Enter</kbd> OK · <kbd>Esc</kbd> cancel';
  if (app.isAssembly) return 'Drag a part to move it along its joints · <kbd>J</kbd> joint · <kbd>Shift I</kbd> insert part · <kbd>G</kbd> ground · <kbd>Right-drag</kbd> orbit';
  if (c && c.draft) {
    const pick = { profiles: 'Click sketch profiles to select them', edges: 'Click edges to select them', faces: 'Click faces to select them', bodies: 'Click bodies to select them', body: 'Click a body' }[c.pick];
    return `${pick ? `${pick} · ` : ''}Drag the ↔ handles or type values · <kbd>Enter</kbd> OK · <kbd>Esc</kbd> cancel`;
  }
  return 'Click to select · <kbd>Right-drag</kbd> orbit · <kbd>Middle-drag</kbd> pan · <kbd>Wheel</kbd> zoom · <kbd>S</kbd> search commands';
}
const renderStatus = () => { $('status-hint').innerHTML = statusHint(); };
for (const evt of ['command', 'mode', 'sketchTool', 'draft', 'doc']) app.on(evt, renderStatus);
renderStatus();

// ---------------------------------------------------------------- context menus
function featureMenu(id, x, y) {
  const f = app.doc.features.find((q) => q.id === id);
  if (!f) return;
  const i = app.doc.features.indexOf(f);
  contextMenu(x, y, [
    { label: f.type === 'sketch' ? 'Edit sketch' : 'Edit feature', icon: 'edit', run: () => app.editFeature(id) },
    { label: 'Rename…', icon: 'rename', run: () => promptText('Rename feature', f.name, (n) => app.renameFeature(id, n)) },
    f.type === 'sketch' ? { label: app.sketchVisible(f) ? 'Hide sketch' : 'Show sketch', icon: app.sketchVisible(f) ? 'eyeOff' : 'eye', run: () => app.toggleSketchVisibility(id) } : null,
    { label: f.suppressed ? 'Unsuppress' : 'Suppress', icon: 'suppress', run: () => app.toggleSuppress(id) },
    { label: 'Roll timeline to here', icon: 'rollback', run: () => app.moveMarker(i + 1) },
    '-',
    { label: 'Delete', icon: 'trash', danger: true, run: () => app.deleteFeature(id) },
  ]);
}
function componentMenu(id, x, y) {
  const asm = app.asm, c = asm.comp(id);
  if (!c) return;
  const vis = c.visible !== false;
  contextMenu(x, y, [
    { label: 'Edit part', icon: 'edit', run: () => asm.editPart(id) },
    { label: 'Joint…', icon: 'joint', key: 'J', run: () => asm.startJoint() },
    { label: c.grounded ? 'Unground' : 'Ground', icon: 'ground', key: 'G', run: () => asm.toggleGround([id]) },
    { label: 'Rename…', icon: 'rename', run: () => promptText('Rename component', c.name, (n) => asm.setComponent(id, { name: n }, 'Rename component')) },
    { label: vis ? 'Hide' : 'Show', icon: vis ? 'eyeOff' : 'eye', run: () => asm.setComponent(id, { visible: !vis }, vis ? 'Hide component' : 'Show component') },
    { label: 'Duplicate', icon: 'copy', run: () => asm.insertPart(c.part) },
    '-',
    { label: 'Remove', icon: 'remove', danger: true, key: 'Del', run: () => asm.removeComponents([id]) },
  ]);
}

function jointMenu(id, x, y) {
  const asm = app.asm, j = app.doc.joints.find((q) => q.id === id);
  if (!j) return;
  contextMenu(x, y, [
    { label: 'Edit joint', icon: 'edit', run: () => asm.startJoint(id) },
    { label: 'Rename…', icon: 'rename', run: () => promptText('Rename joint', j.name, (n) => app.commit('Rename joint', (d) => { d.joints.find((q) => q.id === id).name = n; }, { rebuild: false })) },
    { label: j.suppressed ? 'Unsuppress' : 'Suppress', icon: 'suppress', run: () => asm.toggleSuppressJoint(id) },
    '-',
    { label: 'Delete', icon: 'trash', danger: true, run: () => asm.deleteJoint(id) },
  ]);
}

function bodyMenu(id, x, y) {
  const vis = app.bodyVisible(id);
  contextMenu(x, y, [
    { label: 'Rename…', icon: 'rename', run: () => promptText('Rename body', app.bodyName(id), (n) => app.setBodyMeta(id, { name: n }, 'Rename body')) },
    { label: vis ? 'Hide' : 'Show', icon: vis ? 'eyeOff' : 'eye', run: () => app.setBodyMeta(id, { visible: !vis }, vis ? 'Hide body' : 'Show body') },
    { label: 'Isolate', icon: 'isolate', run: () => app.commit('Isolate body', (d) => { for (const b of app.result.bodies) d.bodies[b.id] = { ...(d.bodies[b.id] || {}), visible: b.id === id }; }, { rebuild: false }) },
    { label: 'Show all bodies', icon: 'eye', run: () => app.commit('Show all bodies', (d) => { for (const b of app.result.bodies) d.bodies[b.id] = { ...(d.bodies[b.id] || {}), visible: true }; }, { rebuild: false }) },
    '-',
    { label: 'Move / Copy', icon: 'move', run: () => { app.selectBodies([id]); app.startCommand('move'); } },
    { label: 'Pattern', icon: 'pattern', run: () => { app.selectBodies([id]); app.startCommand('pattern'); } },
    { label: 'Fillet edges', icon: 'fillet', run: () => app.startCommand('fillet') },
    '-',
    { label: 'Remove', icon: 'remove', danger: true, key: 'Del', run: () => app.removeBodies([id]) },
  ]);
}
app.on('context', ({ hit, event }) => {
  if (app.mode === 'sketch') return;
  if (app.isAssembly) {
    const cid = hit && hit.bodyId ? app.asm.compOfBody(hit.bodyId) : null;
    if (cid) { app.selection = new Set([cid]); app.asm.updateHighlights(); app.emit('selection'); return componentMenu(cid, event.clientX, event.clientY); }
    return contextMenu(event.clientX, event.clientY, [
      { label: 'Insert part…', icon: 'insert', key: 'Shift+I', run: () => ui.openLibrary('insert') },
      { label: 'Joint…', icon: 'joint', key: 'J', run: () => app.asm.startJoint() },
      '-',
      { label: 'Home view', icon: 'home', key: 'Home', run: () => vp.setView('home') },
      { label: 'Fit all', icon: 'fit', key: 'F6', run: () => vp.fit() },
    ]);
  }
  if (hit && hit.bodyId) { app.selectBodies([hit.bodyId]); return bodyMenu(hit.bodyId, event.clientX, event.clientY); }
  contextMenu(event.clientX, event.clientY, [
    { label: 'Create sketch', icon: 'sketch', run: () => app.startSketchFlow() },
    { label: 'Search commands', icon: 'search', key: 'S', run: () => openPalette(commands) },
    '-',
    { label: 'Home view', icon: 'home', key: 'Home', run: () => vp.setView('home') },
    { label: 'Fit all', icon: 'fit', key: 'F6', run: () => vp.fit() },
    '-',
    { label: 'Undo', icon: 'undo', key: 'Ctrl+Z', run: () => app.undo() },
    { label: 'Redo', icon: 'redo', key: 'Ctrl+Y', run: () => app.redo() },
  ]);
});

function showShortcuts() {
  const rows = commands.filter((c) => c.key).map((c) => [c.label, c.key]);
  rows.push(['Orbit', 'Right-drag'], ['Pan', 'Middle-drag'], ['Zoom', 'Wheel'], ['Type a dimension while sketching', '0-9 then Tab / Enter']);
  const grid = h('div.shortcuts', { style: { gridTemplateColumns: '1fr auto 1fr auto', columnGap: '18px' } },
    ...rows.flatMap(([l, k]) => [h('span', { text: l }), h('span', {}, h('kbd', { text: k }))]));
  modal({ title: 'Keyboard shortcuts', iconName: 'keyboard', body: grid });
}

// ---------------------------------------------------------------- keyboard
document.addEventListener('keydown', (e) => {
  if (document.querySelector('.scrim')) return;
  const t = e.target;
  const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (ctrl && k === 's') { e.preventDefault(); return app.saveFile(); }
  if (ctrl && k === 'o') { e.preventDefault(); return ui.openLibrary('open'); }
  if (ctrl && k === 'k') { e.preventDefault(); return openPalette(commands); }
  if (ctrl && k === 'p') { e.preventDefault(); return openParams(app); }
  if (typing) {
    if (e.key === 'Escape') t.blur();
    if (e.key === 'Enter' && app.cmd && (app.cmd.draft || app.cmd.type === 'joint') && $('inspector').contains(t) && t.dataset.key !== '__name' && t.dataset.key !== '__jname') { t.blur(); setTimeout(() => app.okCommand(), 30); }
    return;
  }
  if (ctrl && k === 'z' && !e.shiftKey) { e.preventDefault(); return app.undo(); }
  if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); return app.redo(); }
  if (app.mode === 'sketch') {
    if (ctrl && e.key === 'Enter') { e.preventDefault(); return app.finishSketch(); }
    if (app.sketcher.keydown(e)) { e.preventDefault(); return; }
  }
  if (e.key === 'Escape') {
    if (app.cmd) return app.cancelCommand();
    if (app.mode === 'sketch') return app.finishSketch();
    if (app.selection.size) { app.selection.clear(); app.updateHighlights(); app.emit('selection'); }
    return;
  }
  if (e.key === 'Enter' && app.cmd && app.cmd.type === 'joint') { e.preventDefault(); return app.okCommand(); }
  if (e.key === 'Enter' && app.cmd && app.cmd.draft) {
    e.preventDefault();
    if (app.cmd.pick === 'edges' || app.cmd.pick === 'faces') return app.setPickField(app.cmd.pickKey);
    return app.okCommand();
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && app.isAssembly && !app.cmd && app.selectedJoint) return app.asm.deleteJoint(app.selectedJoint);
  if ((e.key === 'Delete' || e.key === 'Backspace') && app.mode === 'model' && !app.cmd && app.selection.size) return app.removeBodies([...app.selection]);
  if (e.key === 'Home') return vp.setView('home');
  if (e.key === 'F6') { e.preventDefault(); return vp.fit(); }
  if (ctrl || e.altKey) return;
  if (e.key === 'O' && e.shiftKey) return ui.toggleOrtho();
  if (e.key === '?') return showShortcuts();
  if (k === 's' || k === '/') { e.preventDefault(); return openPalette(commands); }
  if (app.isAssembly) {
    if (e.key === 'I' && e.shiftKey) return ui.openLibrary('insert');
    if (e.shiftKey) return;
    if (k === 'j') return app.asm.startJoint();
    if (k === 'g' && app.selection.size) return app.asm.toggleGround([...app.selection]);
    if (k === 'i') return app.startMeasure();
    return;
  }
  if (app.mode !== 'model' || e.shiftKey) return;
  const map = { e: 'extrude', v: 'revolve', f: 'fillet', m: 'move', b: 'box' };
  if (map[k]) return app.startCommand(map[k]);
  if (k === 'i') return app.startMeasure();
});

// drag & drop a design file anywhere
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) app.openFile(f);
});

// keep the browser panel's rename helper reachable from menus
ui.startRename = (id) => browser.startRename(id);

// ---------------------------------------------------------------- start
const restored = app.restoreAutosave();
if (!restored) app.load(app.doc);
app.emit('doc');
if (restored && app.doc.features.length) toast(`Restored “${app.doc.name}” from your last session`, 'info', 3000);
// handy for debugging from the browser console
window.fusion720 = { app, vp, kernel, FEATURES, panels: { browser, inspector, timeline } };

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
