// User parameters dialog: named expressions that drive the whole model.
import { h, clear, modal, toast } from './dom.js';
import { icon } from './icons.js';
import { evaluateParams, fmt, isValidName } from '../model/expr.js';

export function openParams(app) {
  let rows = app.doc.params.map((p) => ({ ...p }));
  const tbody = h('tbody');
  const table = h('table.ptable', {}, h('thead', {}, h('tr', {}, h('th', { text: 'Name', style: { width: '26%' } }), h('th', { text: 'Expression', style: { width: '28%' } }), h('th', { text: 'Value' }), h('th', { text: 'Comment' }), h('th'))), tbody);
  const render = () => {
    const scope = evaluateParams(rows.filter((r) => isValidName(r.name)));
    const seen = new Set();
    clear(tbody);
    rows.forEach((r, i) => {
      const dup = seen.has(r.name);
      seen.add(r.name);
      const badName = !isValidName(r.name) || dup;
      const v = scope[r.name];
      const bad = v instanceof Error || v === undefined;
      const name = h(`input.mono${badName ? '.bad' : ''}`, { value: r.name, spellcheck: false, 'aria-label': 'Parameter name', title: badName ? 'Use letters, digits and _ (must be unique and not start with a digit)' : '' });
      const expr = h(`input.mono${bad && !badName ? '.bad' : ''}`, { value: r.expr, spellcheck: false, 'aria-label': 'Expression' });
      const cmt = h('input', { value: r.comment || '', 'aria-label': 'Comment' });
      name.addEventListener('change', () => { r.name = name.value.trim(); render(); });
      expr.addEventListener('change', () => { r.expr = expr.value; render(); });
      cmt.addEventListener('change', () => { r.comment = cmt.value; });
      for (const el of [name, expr, cmt]) el.addEventListener('keydown', (e) => e.stopPropagation());
      tbody.append(h('tr', {},
        h('td', {}, name), h('td', {}, expr),
        h('td.val', { text: badName ? 'invalid name' : bad ? (v ? v.message : '—') : fmt(v, 4), style: bad || badName ? { color: 'var(--err)', fontFamily: 'var(--font)' } : {} }),
        h('td', {}, cmt),
        h('td', {}, h('button.icon-btn', { html: icon('trash'), title: 'Delete parameter', 'aria-label': `Delete ${r.name}`, on: { click: () => { rows.splice(i, 1); render(); } } }))));
    });
    if (!rows.length) tbody.append(h('tr', {}, h('td', { colspan: 5, style: { color: 'var(--faint)', padding: '14px 6px' }, text: 'No parameters yet. Add one, then type its name into any dimension field (e.g. width/2 + 3 mm).' })));
  };
  const add = () => {
    let n = rows.length + 1;
    while (rows.some((r) => r.name === `d${n}`)) n++;
    rows.push({ name: `d${n}`, expr: '10 mm', comment: '' });
    render();
    setTimeout(() => tbody.querySelectorAll('tr:last-child input')[0]?.select());
  };
  const apply = () => {
    const names = rows.map((r) => r.name);
    if (rows.some((r) => !isValidName(r.name)) || new Set(names).size !== names.length) { toast('Fix the highlighted parameter names first', 'err'); return; }
    document.activeElement?.blur?.();
    setTimeout(() => { app.setParams(rows); m.close(); toast('Parameters updated', 'ok', 1800); });
  };
  render();
  const m = modal({
    title: 'Parameters', iconName: 'params',
    body: h('div', {}, h('p', { style: { margin: '0 0 10px', color: 'var(--muted)', fontSize: '12.5px' }, html: 'Units: <code>mm</code>, <code>cm</code>, <code>in</code>, <code>deg</code>. Functions: <code>sin cos tan sqrt min max abs round</code>. Parameters can reference each other.' }), table),
    foot: [h('button.btn', { html: icon('plus'), on: { click: add } }, h('span', { text: 'Add parameter' })),
      h('div', { style: { display: 'flex', gap: '8px' } }, h('button.btn', { text: 'Cancel', on: { click: () => m.close() } }), h('button.btn.primary', { text: 'Apply', on: { click: apply } }))],
  });
}
