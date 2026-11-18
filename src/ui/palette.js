// Command palette (S or Ctrl+K): fuzzy search across every command.
import { h, clear } from './dom.js';
import { icon } from './icons.js';

function score(q, text) {
  if (!q) return { s: 1, marks: [] };
  const t = text.toLowerCase();
  const idx = t.indexOf(q);
  if (idx >= 0) return { s: 100 - idx, marks: [...Array(q.length).keys()].map((i) => idx + i) };
  let ti = 0, s = 0;
  const marks = [];
  for (const ch of q) {
    const j = t.indexOf(ch, ti);
    if (j < 0) return null;
    s += j === ti ? 3 : 1;
    marks.push(j);
    ti = j + 1;
  }
  return { s, marks };
}

export function openPalette(commands) {
  if (document.querySelector('.palette')) return;
  const input = h('input', { placeholder: 'Type a command… (e.g. extrude, fillet, export)', spellcheck: false, 'aria-label': 'Search commands' });
  const list = h('div.palette-list', { role: 'listbox' });
  const box = h('div.palette', {}, h('div.palette-input', { html: icon('search') }, input), list);
  const scrim = h('div.scrim', { on: { pointerdown: (e) => { if (e.target === scrim) close(); } } }, box);
  let items = [], on = 0;
  const close = () => scrim.remove();
  const run = (c) => { close(); setTimeout(() => c.run(), 0); };
  const render = () => {
    const q = input.value.trim().toLowerCase();
    items = commands.filter((c) => c.when()).map((c) => ({ c, r: score(q, c.label) || score(q, `${c.group} ${c.label}`) })).filter((x) => x.r)
      .sort((a, b) => b.r.s - a.r.s).slice(0, 40);
    on = Math.min(on, Math.max(0, items.length - 1));
    clear(list);
    if (!items.length) list.append(h('div.palette-empty', { text: 'No matching commands' }));
    items.forEach(({ c, r }, i) => {
      const label = [...c.label].map((ch, k) => (r.marks.includes(k) ? `<mark>${esc(ch)}</mark>` : esc(ch))).join('');
      const el = h(`div.palette-item${i === on ? '.on' : ''}`, { role: 'option', 'aria-selected': String(i === on), html: icon(c.icon, 'ico') + `<span>${label}</span>` },
        h('span.grp', { text: c.group }), c.key ? h('kbd', { text: c.key }) : null);
      el.addEventListener('click', () => run(c));
      el.addEventListener('mousemove', () => { if (on !== i) { on = i; render(); } });
      list.append(el);
    });
    list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  };
  input.addEventListener('input', () => { on = 0; render(); });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowDown') { e.preventDefault(); on = Math.min(items.length - 1, on + 1); render(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); on = Math.max(0, on - 1); render(); }
    if (e.key === 'Enter' && items[on]) run(items[on].c);
  });
  document.getElementById('overlay-root').append(scrim);
  render();
  input.focus();
}

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
