// A small parametric example: a mounting bracket driven by user parameters.
export function exampleDoc() {
  return {
    format: 'fusion720',
    version: 1,
    name: 'Mounting bracket',
    units: 'mm',
    params: [
      { name: 'plate_w', expr: '90 mm', comment: 'Plate length' },
      { name: 'plate_d', expr: '56 mm', comment: 'Plate width' },
      { name: 'plate_t', expr: '8 mm', comment: 'Plate thickness' },
      { name: 'hole_d', expr: '6.5 mm', comment: 'Mounting hole diameter (M6 clearance)' },
      { name: 'inset', expr: '9 mm', comment: 'Hole distance from edges' },
      { name: 'boss_d', expr: '30 mm', comment: 'Boss diameter' },
      { name: 'boss_h', expr: '22 mm', comment: 'Boss height above plate' },
      { name: 'bore_d', expr: '14 mm', comment: 'Bore through the boss' },
    ],
    features: [
      {
        id: 'sk_base', type: 'sketch', name: 'Base sketch', plane: { type: 'std', name: 'XY', offset: '0' },
        entities: [
          { id: 'plate', type: 'rect', x: '-plate_w/2', y: '-plate_d/2', w: 'plate_w', h: 'plate_d' },
          { id: 'h1', type: 'circle', cx: '-plate_w/2 + inset', cy: '-plate_d/2 + inset', d: 'hole_d' },
          { id: 'h2', type: 'circle', cx: 'plate_w/2 - inset', cy: '-plate_d/2 + inset', d: 'hole_d' },
          { id: 'h3', type: 'circle', cx: 'plate_w/2 - inset', cy: 'plate_d/2 - inset', d: 'hole_d' },
          { id: 'h4', type: 'circle', cx: '-plate_w/2 + inset', cy: 'plate_d/2 - inset', d: 'hole_d' },
        ],
      },
      { id: 'ex_plate', type: 'extrude', name: 'Plate', sketch: 'sk_base', profiles: ['plate'], distance: 'plate_t', extent: 'one', distance2: '10 mm', flip: false, operation: 'new', targets: [] },
      {
        id: 'fl_corners', type: 'fillet', name: 'Corner fillets', radius: '7 mm',
        edges: [
          { body: 'b:ex_plate', p: [45, 28, 4], np: [1, 1, 0.5], adj: 'PLANE+PLANE', dir: [0, 0, 1], type: 'LINE', len: 8 },
          { body: 'b:ex_plate', p: [-45, 28, 4], np: [0, 1, 0.5], adj: 'PLANE+PLANE', dir: [0, 0, 1], type: 'LINE', len: 8 },
          { body: 'b:ex_plate', p: [-45, -28, 4], np: [0, 0, 0.5], adj: 'PLANE+PLANE', dir: [0, 0, 1], type: 'LINE', len: 8 },
          { body: 'b:ex_plate', p: [45, -28, 4], np: [1, 0, 0.5], adj: 'PLANE+PLANE', dir: [0, 0, 1], type: 'LINE', len: 8 },
        ],
      },
      {
        id: 'sk_boss', type: 'sketch', name: 'Boss sketch', plane: { type: 'std', name: 'XY', offset: 'plate_t' },
        entities: [{ id: 'boss', type: 'circle', cx: '0', cy: '0', d: 'boss_d' }],
      },
      { id: 'ex_boss', type: 'extrude', name: 'Boss', sketch: 'sk_boss', profiles: ['boss'], distance: 'boss_h', extent: 'one', distance2: '10 mm', flip: false, operation: 'join', targets: [] },
      { id: 'cy_bore', type: 'cylinder', name: 'Bore', d: 'bore_d', h: 'plate_t + boss_h + 2', axis: 'Z', x: '0', y: '0', z: '-1', operation: 'cut', targets: [] },
      {
        id: 'ch_top', type: 'chamfer', name: 'Bore chamfer', distance: '1.2 mm',
        edges: [{ body: 'b:ex_plate', p: [-7, 0, 30], np: [0.4222, 0.5, 1], adj: 'CYLINDRE+PLANE', dir: null, type: 'CIRCLE', len: 43.98 }],
      },
    ],
    marker: null,
    bodies: { 'b:ex_plate': { name: 'Bracket' } },
  };
}
