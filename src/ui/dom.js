// Tiny DOM helpers + shared overlay widgets (tooltips, toasts, menus, modals).
import { icon } from './icons.js';

/** h('div.cls#id', {attrs, on:{click}}, ...children) */
export function h(sel, props = {}, ...children) {
  const m = sel.match(/^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i);
  const el = document.createElement((m && m[1]) || 'div');
  if (m && m[2]) for (const part of m[2].match(/[.#][\w-]+/g)) {
    if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1);
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'class') el.className += ' ' + v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const iconEl = (name, cls) => { const t = document.createElement('template'); t.innerHTML = icon(name, cls); return t.content.firstChild; };

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

// ---------------------------------------------------------------- tooltips
let tipEl = null, tipTimer = 0;
export function tooltip(el, { title, desc, key }) {
  el.addEventListener('mouseenter', () => {
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => {
      hideTip();
      tipEl = h('div.tip', { html: `<b>${title}</b>${key ? `<kbd>${key}</kbd>` : ''}${desc ? `<div class="tip-desc">${desc}</div>` : ''}` });
      document.body.append(tipEl);
      const r = el.getBoundingClientRect();
      const t = tipEl.getBoundingClientRect();
      let x = r.left + r.width / 2 - t.width / 2;
      x = Math.max(8, Math.min(window.innerWidth - t.width - 8, x));
      let y = r.bottom + 8;
      if (y + t.height > window.innerHeight - 8) y = r.top - t.height - 8;
      tipEl.style.left = `${x}px`; tipEl.style.top = `${y}px`;
    }, 380);
  });
  el.addEventListener('mouseleave', () => { clearTimeout(tipTimer); hideTip(); });
  el.addEventListener('mousedown', () => { clearTimeout(tipTimer); hideTip(); });
}
export function hideTip() { if (tipEl) { tipEl.remove(); tipEl = null; } }

// ---------------------------------------------------------------- toasts
export function toast(msg, kind = 'info', ms = 3800) {
  const ico = { ok: 'ok', err: 'error', info: 'info', warn: 'warn' }[kind] || 'info';
  const el = h(`div.toast.${kind}`, { html: icon(ico) }, h('div', { text: msg }));
  document.getElementById('toasts').append(el);
  setTimeout(() => { el.style.transition = 'opacity .25s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 260); }, ms);
}

// ---------------------------------------------------------------- context menu
let menuEl = null;
export function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
export function contextMenu(x, y, items) {
  closeMenu();
  menuEl = h('div.menu', { role: 'menu' });
  for (const it of items) {
    if (it === '-') { menuEl.append(h('div.menu-sep')); continue; }
    if (!it) continue;
    const b = h(`button.menu-item${it.danger ? '.danger' : ''}`, { html: icon(it.icon || 'caret'), disabled: it.disabled },
      h('span', { text: it.label }), it.key ? h('kbd', { text: it.key }) : null);
    b.addEventListener('click', () => { closeMenu(); it.run(); });
    menuEl.append(b);
  }
  document.body.append(menuEl);
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
  menuEl.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
  setTimeout(() => {
    const off = (e) => { if (menuEl && !menuEl.contains(e.target)) { closeMenu(); document.removeEventListener('pointerdown', off, true); } };
    document.addEventListener('pointerdown', off, true);
  });
}

// ---------------------------------------------------------------- modal
export function modal({ title, iconName, body, foot, onClose }) {
  const close = () => { scrim.remove(); document.removeEventListener('keydown', esc, true); onClose?.(); };
  const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const xBtn = h('button.icon-btn', { html: icon('x'), title: 'Close', on: { click: close } });
  const box = h('div.modal', { role: 'dialog', 'aria-label': title },
    h('div.modal-head', { html: iconName ? icon(iconName) : '' }, h('h2', { text: title }), xBtn),
    h('div.modal-body', {}, body),
    foot ? h('div.modal-foot', {}, foot) : null);
  const scrim = h('div.scrim', { on: { pointerdown: (e) => { if (e.target === scrim) close(); } } }, box);
  document.getElementById('overlay-root').append(scrim);
  document.addEventListener('keydown', esc, true);
  return { close, box };
}

export function promptText(title, value, onOk) {
  const input = h('input.select', { value, spellcheck: false, 'aria-label': title });
  const ok = () => { const v = input.value.trim(); m.close(); if (v) onOk(v); };
  input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') ok(); if (e.key === 'Escape') m.close(); });
  const m = modal({
    title, iconName: 'rename', body: input,
    foot: [h('span'), h('div', { style: { display: 'flex', gap: '8px' } }, h('button.btn', { text: 'Cancel', on: { click: () => m.close() } }), h('button.btn.primary', { text: 'OK', on: { click: ok } }))],
  });
  m.box.style.width = 'min(420px, calc(100% - 32px))';
  setTimeout(() => { input.focus(); input.select(); });
}

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
