// Feature registry: defaults and inspector field specs for every timeline feature.

const OPERATION = {
  key: 'operation', label: 'Operation', kind: 'segmented',
  options: [['new', 'New body'], ['join', 'Join'], ['cut', 'Cut'], ['intersect', 'Intersect']],
};
const TARGETS = {
  key: 'targets', label: 'Target bodies', kind: 'pick', pick: 'bodies', optional: true,
  hint: 'Leave empty to use every body the new shape touches',
  showIf: (f) => f.operation !== 'new',
};
const POSITION = [
  { key: 'x', label: 'X', kind: 'expr', unit: 'mm', half: true },
  { key: 'y', label: 'Y', kind: 'expr', unit: 'mm', half: true },
  { key: 'z', label: 'Z', kind: 'expr', unit: 'mm', half: true },
];
const AXIS = { key: 'axis', label: 'Axis', kind: 'segmented', options: [['X', 'X'], ['Y', 'Y'], ['Z', 'Z']] };

export const FEATURES = {
  sketch: { label: 'Sketch', icon: 'sketch', group: 'create', shortcut: 'S' },
  extrude: {
    label: 'Extrude', icon: 'extrude', group: 'create', shortcut: 'E', needsSketch: true,
    defaults: () => ({ sketch: null, profiles: [], distance: '10 mm', extent: 'one', distance2: '10 mm', flip: false, operation: 'new', targets: [] }),
    fields: [
      { key: 'profiles', label: 'Profiles', kind: 'pick', pick: 'profiles', hint: 'Click shaded regions in a sketch' },
      { key: 'extent', label: 'Direction', kind: 'segmented', options: [['one', 'One side'], ['symmetric', 'Symmetric'], ['two', 'Two sides']] },
      { key: 'distance', label: 'Distance', kind: 'expr', unit: 'mm', drag: true },
      { key: 'distance2', label: 'Distance 2', kind: 'expr', unit: 'mm', showIf: (f) => f.extent === 'two' },
      { key: 'flip', label: 'Flip direction', kind: 'bool', showIf: (f) => f.extent !== 'symmetric' },
      OPERATION, TARGETS,
    ],
  },
  revolve: {
    label: 'Revolve', icon: 'revolve', group: 'create', shortcut: 'V', needsSketch: true,
    defaults: () => ({ sketch: null, profiles: [], axis: 'y', angle: '360 deg', operation: 'new', targets: [] }),
    fields: [
      { key: 'profiles', label: 'Profiles', kind: 'pick', pick: 'profiles', hint: 'Click shaded regions in a sketch' },
      { key: 'axis', label: 'Axis', kind: 'segmented', options: [['x', 'Sketch X'], ['y', 'Sketch Y']], extraAxisLines: true },
      { key: 'angle', label: 'Angle', kind: 'expr', unit: 'deg', drag: true },
      OPERATION, TARGETS,
    ],
  },
  box: {
    label: 'Box', icon: 'box', group: 'create', shortcut: 'B',
    defaults: () => ({ w: '40 mm', d: '40 mm', h: '20 mm', x: '0', y: '0', z: '0', operation: 'new', targets: [] }),
    fields: [
      { key: 'w', label: 'Length (X)', kind: 'expr', unit: 'mm', drag: true },
      { key: 'd', label: 'Width (Y)', kind: 'expr', unit: 'mm', drag: true },
      { key: 'h', label: 'Height (Z)', kind: 'expr', unit: 'mm', drag: true },
      { kind: 'heading', label: 'Center of base' }, ...POSITION, OPERATION, TARGETS,
    ],
  },
  cylinder: {
    label: 'Cylinder', icon: 'cylinder', group: 'create',
    defaults: () => ({ d: '30 mm', h: '40 mm', axis: 'Z', x: '0', y: '0', z: '0', operation: 'new', targets: [] }),
    fields: [
      { key: 'd', label: 'Diameter', kind: 'expr', unit: 'mm', drag: true },
      { key: 'h', label: 'Height', kind: 'expr', unit: 'mm', drag: true },
      AXIS, { kind: 'heading', label: 'Center of base' }, ...POSITION, OPERATION, TARGETS,
    ],
  },
  sphere: {
    label: 'Sphere', icon: 'sphere', group: 'create',
    defaults: () => ({ d: '40 mm', x: '0', y: '0', z: '0', operation: 'new', targets: [] }),
    fields: [{ key: 'd', label: 'Diameter', kind: 'expr', unit: 'mm', drag: true }, { kind: 'heading', label: 'Center' }, ...POSITION, OPERATION, TARGETS],
  },
  torus: {
    label: 'Torus', icon: 'torus', group: 'create',
    defaults: () => ({ d: '60 mm', t: '12 mm', axis: 'Z', x: '0', y: '0', z: '0', operation: 'new', targets: [] }),
    fields: [
      { key: 'd', label: 'Ring diameter', kind: 'expr', unit: 'mm', drag: true },
      { key: 't', label: 'Tube diameter', kind: 'expr', unit: 'mm', drag: true },
      AXIS, { kind: 'heading', label: 'Center' }, ...POSITION, OPERATION, TARGETS,
    ],
  },
  fillet: {
    label: 'Fillet', icon: 'fillet', group: 'modify', shortcut: 'F',
    defaults: () => ({ edges: [], radius: '2 mm' }),
    fields: [
      { key: 'edges', label: 'Edges', kind: 'pick', pick: 'edges', hint: 'Click edges on a body' },
      { key: 'radius', label: 'Radius', kind: 'expr', unit: 'mm', drag: true },
    ],
  },
  chamfer: {
    label: 'Chamfer', icon: 'chamfer', group: 'modify',
    defaults: () => ({ edges: [], distance: '1 mm' }),
    fields: [
      { key: 'edges', label: 'Edges', kind: 'pick', pick: 'edges', hint: 'Click edges on a body' },
      { key: 'distance', label: 'Distance', kind: 'expr', unit: 'mm', drag: true },
    ],
  },
  shell: {
    label: 'Shell', icon: 'shell', group: 'modify',
    defaults: () => ({ faces: [], thickness: '2 mm' }),
    fields: [
      { key: 'faces', label: 'Faces to remove', kind: 'pick', pick: 'faces', hint: 'Click the faces to open up' },
      { key: 'thickness', label: 'Wall thickness', kind: 'expr', unit: 'mm', drag: true },
    ],
  },
  combine: {
    label: 'Combine', icon: 'combine', group: 'modify',
    defaults: () => ({ target: [], tools: [], operation: 'join', keepTools: false }),
    fields: [
      { key: 'target', label: 'Target body', kind: 'pick', pick: 'body' },
      { key: 'tools', label: 'Tool bodies', kind: 'pick', pick: 'bodies' },
      { key: 'operation', label: 'Operation', kind: 'segmented', options: [['join', 'Join'], ['cut', 'Cut'], ['intersect', 'Intersect']] },
      { key: 'keepTools', label: 'Keep tool bodies', kind: 'bool' },
    ],
  },
  move: {
    label: 'Move / Copy', icon: 'move', group: 'modify', shortcut: 'M',
    defaults: () => ({ bodies: [], dx: '0 mm', dy: '0 mm', dz: '0 mm', axis: 'Z', angle: '0 deg', copy: false }),
    fields: [
      { key: 'bodies', label: 'Bodies', kind: 'pick', pick: 'bodies' },
      { kind: 'heading', label: 'Translate' },
      { key: 'dx', label: 'X', kind: 'expr', unit: 'mm', half: true, drag: true },
      { key: 'dy', label: 'Y', kind: 'expr', unit: 'mm', half: true, drag: true },
      { key: 'dz', label: 'Z', kind: 'expr', unit: 'mm', half: true, drag: true },
      { kind: 'heading', label: 'Rotate about origin' }, AXIS,
      { key: 'angle', label: 'Angle', kind: 'expr', unit: 'deg', drag: true },
      { key: 'copy', label: 'Create a copy', kind: 'bool' },
    ],
  },
  mirror: {
    label: 'Mirror', icon: 'mirror', group: 'modify',
    defaults: () => ({ bodies: [], plane: 'YZ', join: true }),
    fields: [
      { key: 'bodies', label: 'Bodies', kind: 'pick', pick: 'bodies' },
      { key: 'plane', label: 'Mirror plane', kind: 'segmented', options: [['YZ', 'YZ'], ['XZ', 'XZ'], ['XY', 'XY']] },
      { key: 'join', label: 'Join with original', kind: 'bool' },
    ],
  },
  pattern: {
    label: 'Pattern', icon: 'pattern', group: 'modify',
    defaults: () => ({ bodies: [], kind: 'circular', count: '6', angle: '360 deg', axis: 'Z', countX: '3', spacingX: '20 mm', countY: '1', spacingY: '20 mm', join: true }),
    fields: [
      { key: 'bodies', label: 'Bodies', kind: 'pick', pick: 'bodies' },
      { key: 'kind', label: 'Type', kind: 'segmented', options: [['circular', 'Circular'], ['rect', 'Rectangular']] },
      { ...AXIS, showIf: (f) => f.kind === 'circular' },
      { key: 'count', label: 'Quantity', kind: 'expr', showIf: (f) => f.kind === 'circular', drag: true, step: 1 },
      { key: 'angle', label: 'Total angle', kind: 'expr', unit: 'deg', showIf: (f) => f.kind === 'circular' },
      { key: 'countX', label: 'Quantity X', kind: 'expr', half: true, showIf: (f) => f.kind === 'rect', drag: true, step: 1 },
      { key: 'spacingX', label: 'Spacing X', kind: 'expr', unit: 'mm', half: true, showIf: (f) => f.kind === 'rect' },
      { key: 'countY', label: 'Quantity Y', kind: 'expr', half: true, showIf: (f) => f.kind === 'rect', drag: true, step: 1 },
      { key: 'spacingY', label: 'Spacing Y', kind: 'expr', unit: 'mm', half: true, showIf: (f) => f.kind === 'rect' },
      { key: 'join', label: 'Join instances', kind: 'bool' },
    ],
  },
  remove: {
    label: 'Remove', icon: 'remove', group: 'modify',
    defaults: () => ({ bodies: [] }),
    fields: [{ key: 'bodies', label: 'Bodies', kind: 'pick', pick: 'bodies' }],
  },
};

export function newId(prefix = 'f') {
  return prefix + Math.random().toString(36).slice(2, 9);
}

export function nextName(doc, type) {
  const base = FEATURES[type].label.replace(/[^A-Za-z]/g, '');
  let n = 1;
  const names = new Set(doc.features.map((f) => f.name));
  while (names.has(base + n)) n++;
  return base + n;
}

export function newDoc() {
  return { format: 'fusion720', version: 1, name: 'Untitled', units: 'mm', params: [], features: [], marker: null, bodies: {} };
}

/** Features active for the current timeline marker. */
export function activeFeatures(doc) {
  const end = doc.marker == null ? doc.features.length : doc.marker;
  return doc.features.slice(0, end);
}
