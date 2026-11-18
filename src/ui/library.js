// "My designs" dialog: open any saved part or assembly, or insert parts into the open assembly.
import { h, clear, modal, toast } from './dom.js';
import { icon } from './icons.js';
import { library } from '../model/library.js';

function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

/** mode: 'open' (default) or 'insert' (pick parts for the open assembly) */
export function openLibrary(app, { mode = 'open', onFile } = {}) {
  app.flushSave();
  const inserting = mode === 'insert';
  const search = h('input.select', { placeholder: inserting ? 'Search your parts…' : 'Search your designs…', spellcheck: false, 'aria-label': 'Search designs' });
  const list = h('div.lib-list', { role: 'list' });
  let m;
  const render = () => {
    const q = search.value.trim().toLowerCase();
    const items = library.list().filter((e) => (!inserting || e.kind === 'part') && e.id !== (inserting ? app.doc.id : null) && (!q || e.name.toLowerCase().includes(q)));
    clear(list);
    if (!items.length) {
      list.append(h('div.palette-empty', { text: inserting ? 'No parts yet. Model a part (it saves to My designs automatically), then come back and insert it.' : 'No designs yet.' }));
      return;
    }
    for (const e of items) {
      const current = e.id === app.doc.id;
      const actions = h('div.lib-actions');
      if (inserting) {
        actions.append(h('button.btn.primary', { html: icon('plus'), on: { click: () => { app.asm.insertPart(e.id); toast(`Inserted ${e.name}`, 'ok', 1600); } } }, h('span', { text: 'Insert' })));
      } else {
        actions.append(h('button.btn', { text: current ? 'Open (current)' : 'Open', disabled: current, on: { click: () => { m.close(); app.openDesign(e.id); } } }));
        if (app.isAssembly && e.kind === 'part' && !current) actions.append(h('button.btn', { html: icon('plus'), title: 'Insert into this assembly', on: { click: () => { app.asm.insertPart(e.id); toast(`Inserted ${e.name}`, 'ok', 1600); } } }, h('span', { text: 'Insert' })));
        actions.append(h('button.icon-btn', {
          html: icon('trash'), title: current ? 'You can’t delete the open design' : 'Delete from My designs', disabled: current, 'aria-label': `Delete ${e.name}`,
          on: { click: () => { if (confirm(`Delete "${e.name}" from My designs? This can't be undone (assemblies keep their own copy of it).`)) { library.remove(e.id); render(); } } },
        }));
      }
      list.append(h(`div.lib-row${current ? '.current' : ''}`, { role: 'listitem' },
        h('div.lib-ico', { html: icon(e.kind === 'assembly' ? 'assembly' : 'body') }),
        h('div.lib-main', {}, h('div.lib-name', { text: e.name }),
          h('div.lib-meta', { text: `${e.kind === 'assembly' ? `Assembly · ${e.components} component${e.components === 1 ? '' : 's'}` : `Part · ${e.features} feature${e.features === 1 ? '' : 's'}`} · ${ago(e.savedAt)}` })),
        actions));
    }
  };
  search.addEventListener('input', render);
  search.addEventListener('keydown', (e) => e.stopPropagation());
  const foot = inserting
    ? [h('span.hint', { text: 'Parts stay linked: edit a part later and the assembly picks up the change.' }), h('button.btn.primary', { text: 'Done', on: { click: () => m.close() } })]
    : [h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
      h('button.btn', { html: icon('body'), on: { click: () => { m.close(); app.newDocument(); } } }, h('span', { text: 'New part' })),
      h('button.btn', { html: icon('assembly'), on: { click: () => { m.close(); app.newAssemblyDoc(); } } }, h('span', { text: 'New assembly' }))),
    h('button.btn', { html: icon('open'), on: { click: () => { m.close(); onFile?.(); } } }, h('span', { text: 'Open file…' }))];
  m = modal({ title: inserting ? 'Insert a part' : 'My designs', iconName: inserting ? 'plus' : 'folder', body: h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, search, list), foot });
  render();
  setTimeout(() => search.focus());
}
