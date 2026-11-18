// "My designs": every design (part or assembly) is stored in this browser's
// localStorage, one key per design plus a small index. Assemblies link to
// parts by their library id.

const INDEX_KEY = 'fusion720.library.index.v1';
const DOC_KEY = (id) => `fusion720.library.doc.${id}`;
const CURRENT_KEY = 'fusion720.library.current.v1';
const LEGACY_AUTOSAVE = 'fusion720.autosave.v1';

const read = (k) => { try { const s = localStorage.getItem(k); return s ? JSON.parse(s) : null; } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };

export const newDocId = () => `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function summary(doc) {
  return {
    id: doc.id, name: doc.name || 'Untitled', kind: doc.kind || 'part', savedAt: doc.savedAt || Date.now(),
    features: (doc.features || []).length, components: (doc.components || []).length,
  };
}

export const library = {
  list() {
    const idx = read(INDEX_KEY) || [];
    return idx.slice().sort((a, b) => b.savedAt - a.savedAt);
  },
  get(id) { return id ? read(DOC_KEY(id)) : null; },
  has(id) { return !!(read(INDEX_KEY) || []).find((e) => e.id === id); },
  /** Save (insert or update). Returns false if storage is full or unavailable. */
  put(doc) {
    if (!doc.id) doc.id = newDocId();
    doc.savedAt = Date.now();
    if (!write(DOC_KEY(doc.id), doc)) return false;
    const idx = (read(INDEX_KEY) || []).filter((e) => e.id !== doc.id);
    idx.push(summary(doc));
    return write(INDEX_KEY, idx);
  },
  remove(id) {
    try { localStorage.removeItem(DOC_KEY(id)); } catch { /* ignore */ }
    write(INDEX_KEY, (read(INDEX_KEY) || []).filter((e) => e.id !== id));
  },
  setCurrent(id) { write(CURRENT_KEY, id); },
  getCurrent() { return read(CURRENT_KEY); },
  /** One-time import of the old single-slot autosave. */
  migrate() {
    const old = read(LEGACY_AUTOSAVE);
    if (!old || old.format !== 'fusion720') return;
    if (!old.id) old.id = newDocId();
    if (!this.has(old.id)) { this.put(old); if (!this.getCurrent()) this.setCurrent(old.id); }
    try { localStorage.removeItem(LEGACY_AUTOSAVE); } catch { /* ignore */ }
  },
};
