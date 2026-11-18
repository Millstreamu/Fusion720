// Every user-facing command in one place: toolbar, command palette and shortcuts read from here.
import { FEATURES } from '../model/features.js';
import { SKETCH_TOOLS } from '../viewer/sketcher.js';
import { CONSTRAINTS, CONSTRAINT_TOOLS, HV } from '../model/constraints.js';

export function buildCommands(app, ui) {
  const model = () => app.mode === 'model';
  const sketch = () => app.mode === 'sketch';
  const feat = (type, extra = {}) => ({
    id: type, label: FEATURES[type].label, icon: FEATURES[type].icon, group: FEATURES[type].group === 'create' ? 'Create' : 'Modify',
    key: FEATURES[type].shortcut && type !== 'sketch' ? FEATURES[type].shortcut : undefined,
    run: () => app.startCommand(type), when: () => !app.isAssembly, active: () => app.cmd && app.cmd.type === type, ...extra,
  });
  const cmds = [
    { id: 'sketch', label: 'Sketch', icon: 'sketch', group: 'Create', desc: 'Pick a plane or flat face, then draw 2D profiles', run: () => app.startSketchFlow(), when: () => model() && !app.isAssembly, active: () => app.cmd && app.cmd.type === 'sketchPlane' },
    feat('extrude', { desc: 'Push a closed sketch profile into a solid, or cut with it' }),
    feat('revolve', { desc: 'Spin a profile around an axis' }),
    feat('box', { desc: 'Solid box primitive' }),
    feat('cylinder', { desc: 'Solid cylinder primitive' }),
    feat('sphere', { desc: 'Solid sphere primitive' }),
    feat('torus', { desc: 'Solid ring primitive' }),
    feat('fillet', { desc: 'Round selected edges' }),
    feat('chamfer', { desc: 'Bevel selected edges' }),
    feat('shell', { desc: 'Hollow out a body, opening the selected faces' }),
    feat('combine', { desc: 'Join, cut or intersect bodies' }),
    feat('move', { desc: 'Translate, rotate or copy bodies' }),
    feat('mirror', { desc: 'Mirror bodies across an origin plane' }),
    feat('pattern', { desc: 'Rectangular or circular copies of bodies' }),
    feat('remove', { desc: 'Remove bodies from the design (recorded in the timeline)' }),
    { id: 'measure', label: 'Measure', icon: 'measure', group: 'Inspect', key: 'I', desc: 'Click two points, edges or faces to measure', run: () => app.startMeasure(), when: model, active: () => app.cmd && app.cmd.type === 'measure' },
    { id: 'section', label: 'Section', icon: 'section', group: 'Inspect', desc: 'Cut the view open with a clipping plane', run: () => ui.toggleSection(), when: () => true, active: () => !!app.vp.section },
    { id: 'params', label: 'Parameters', icon: 'params', group: 'Design', key: 'Ctrl+P', desc: 'Named values you can use in any field', run: () => ui.openParams(), when: () => true },

    // sketch mode
    ...Object.entries(SKETCH_TOOLS).map(([id, t]) => ({
      id: `sk-${id}`, label: t.label, icon: t.icon, group: 'Sketch', key: t.key, desc: t.desc,
      run: () => app.sketcher.setTool(id), when: sketch, active: () => sketch() && app.sketcher.tool === id,
    })),
    { id: 'sk-construction', label: 'Construction', icon: 'construction', group: 'Sketch', key: 'X', desc: 'Toggle construction geometry (not used for profiles)', run: () => app.sketcher.toggleConstruction(), when: sketch, active: () => sketch() && app.sketcher.construction },
    { id: 'sk-dims', label: 'Show / hide dimensions', icon: 'dimension', group: 'Sketch', desc: 'Show or hide sketch dimensions', run: () => app.sketcher.toggleDims(), when: sketch, active: () => sketch() && app.sketcher.showDims },
    ...CONSTRAINT_TOOLS.map((t) => {
      const def = t === 'hv' ? HV : CONSTRAINTS[t];
      return {
        id: `cn-${t}`, label: def.label, short: { hv: 'H / V', perpendicular: 'Perpend.', coincident: 'Coincid.' }[t], icon: def.icon, group: 'Constrain', desc: def.desc,
        key: { hv: 'H', tangent: 'T' }[t],
        run: () => app.sketcher.setTool('constraint', t), when: sketch,
        active: () => sketch() && app.sketcher.tool === 'constraint' && app.sketcher.ctype === t,
      };
    }),
    { id: 'cn-fix', label: 'Fix / Unfix', short: 'Fix', icon: 'lock', group: 'Constrain', desc: 'Lock the selected entities in place (shown in green)', run: () => app.sketcher.toggleFix(), when: sketch },
    { id: 'sk-delete', label: 'Delete', icon: 'trash', group: 'Sketch', key: 'Del', desc: 'Delete selected sketch entities', run: () => app.sketcher.deleteSelected(), when: sketch },
    { id: 'finish-sketch', label: 'Finish sketch', icon: 'check', group: 'Sketch', key: 'Ctrl+Enter', desc: 'Leave the sketch and return to 3D modeling', run: () => app.finishSketch(), when: sketch },

    // assembly
    { id: 'asm-insert', label: 'Insert part', short: 'Insert', icon: 'insert', group: 'Assemble', key: 'Shift+I', desc: 'Add a part from My designs as a component', run: () => ui.openLibrary('insert'), when: () => app.isAssembly },
    { id: 'asm-joint', label: 'Joint', icon: 'joint', group: 'Assemble', key: 'J', desc: 'Snap a point on one component to a point on another (rigid, hinge, slider…)', run: () => app.asm.startJoint(), when: () => app.isAssembly, active: () => app.cmd && app.cmd.type === 'joint' },
    { id: 'asm-ground', label: 'Ground / Unground', short: 'Ground', icon: 'ground', group: 'Assemble', key: 'G', desc: 'Fix the selected components in place', run: () => (app.selection.size ? app.asm.toggleGround([...app.selection]) : null), when: () => app.isAssembly },
    { id: 'asm-edit-part', label: 'Edit part', short: 'Edit part', icon: 'edit', group: 'Assemble', desc: 'Open the selected component’s part to change it', run: () => (app.selection.size === 1 ? app.asm.editPart([...app.selection][0]) : null), when: () => app.isAssembly },

    // file
    { id: 'new', label: 'New part', icon: 'body', group: 'File', run: () => app.newDocument(), when: () => true },
    { id: 'new-assembly', label: 'New assembly', icon: 'assembly', group: 'File', run: () => app.newAssemblyDoc(), when: () => true },
    { id: 'my-designs', label: 'My designs…', icon: 'folder', group: 'File', key: 'Ctrl+O', run: () => ui.openLibrary('open'), when: () => true },
    { id: 'open', label: 'Open file…', icon: 'open', group: 'File', run: () => ui.openFilePicker(), when: () => true },
    { id: 'example-assembly', label: 'Open example: hinge assembly', icon: 'assembly', group: 'File', run: () => app.loadExampleAssembly(), when: () => true },
    { id: 'save', label: 'Save design (.f720.json)', icon: 'save', group: 'File', key: 'Ctrl+S', run: () => app.saveFile(), when: () => true },
    { id: 'export-step', label: 'Export STEP', icon: 'download', group: 'File', desc: 'For other CAD tools', run: () => app.exportFile('step'), when: () => true },
    { id: 'export-stl', label: 'Export STL', icon: 'download', group: 'File', desc: 'For 3D printing', run: () => app.exportFile('stl'), when: () => true },
    { id: 'example', label: 'Open example: mounting bracket', icon: 'sparkle', group: 'File', run: () => app.loadExample(), when: () => true },
    { id: 'undo', label: 'Undo', icon: 'undo', group: 'Edit', key: 'Ctrl+Z', run: () => app.undo(), when: () => true },
    { id: 'redo', label: 'Redo', icon: 'redo', group: 'Edit', key: 'Ctrl+Y', run: () => app.redo(), when: () => true },

    // view
    { id: 'view-home', label: 'Home view', icon: 'home', group: 'View', key: 'Home', run: () => app.vp.setView('home'), when: () => true },
    { id: 'view-fit', label: 'Fit to view', icon: 'fit', group: 'View', key: 'F6', run: () => app.vp.fit(), when: () => true },
    ...['top', 'front', 'right', 'back', 'left', 'bottom'].map((v) => ({ id: `view-${v}`, label: `${v[0].toUpperCase()}${v.slice(1)} view`, icon: 'box', group: 'View', run: () => app.vp.setView(v), when: () => true })),
    { id: 'toggle-ortho', label: 'Toggle orthographic / perspective', icon: 'ortho', group: 'View', key: 'Shift+O', run: () => ui.toggleOrtho(), when: () => true },
    { id: 'toggle-display', label: 'Cycle display: shaded / edges / wireframe', icon: 'shaded', group: 'View', run: () => ui.cycleDisplay(), when: () => true },
    { id: 'toggle-theme', label: 'Toggle light / dark theme', icon: 'moon', group: 'View', run: () => ui.toggleTheme(), when: () => true },
    { id: 'toggle-browser', label: 'Toggle browser panel', icon: 'panelLeft', group: 'View', run: () => ui.togglePanel('left'), when: () => true },
    { id: 'toggle-inspector', label: 'Toggle inspector panel', icon: 'panelRight', group: 'View', run: () => ui.togglePanel('right'), when: () => true },
    { id: 'shortcuts', label: 'Keyboard shortcuts', icon: 'keyboard', group: 'Help', key: '?', run: () => ui.showShortcuts(), when: () => true },
  ];
  return cmds;
}

export const MODEL_TOOLBAR = [
  { label: 'Create', items: ['sketch', 'extrude', 'revolve', { menu: 'Primitive', icon: 'box', items: ['box', 'cylinder', 'sphere', 'torus'] }] },
  { label: 'Modify', items: ['fillet', 'chamfer', 'shell', 'combine', 'move', 'mirror', 'pattern'] },
  { label: 'Inspect', items: ['measure', 'section', 'params'] },
];

export const ASSEMBLY_TOOLBAR = [
  { label: 'Assemble', items: ['asm-insert', 'asm-joint', 'asm-ground', 'asm-edit-part'] },
  { label: 'Inspect', items: ['measure', 'section', 'params'] },
];

export const SKETCH_TOOLBAR = [
  { label: 'Draw', items: ['sk-select', 'sk-line', { menu: 'Rect', icon: 'rect', items: ['sk-rect', 'sk-centerRect'] }, 'sk-circle', 'sk-polygon', 'sk-slot'] },
  { label: 'Constrain', items: ['sk-dimension', 'cn-coincident', 'cn-hv', 'cn-parallel', 'cn-perpendicular', 'cn-tangent', 'cn-equal',
    { menu: 'More', icon: 'cConcentric', items: ['cn-concentric', 'cn-midpoint', 'cn-collinear', 'cn-symmetric', 'cn-fix'] }] },
  { label: 'Edit', items: ['sk-construction', 'sk-delete'] },
  { label: '', items: ['finish-sketch'] },
];
