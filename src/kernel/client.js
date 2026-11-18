// Promise-based client for the geometry worker. Coalesces rebuild requests so
// only the latest document state is computed while the user drags a value.

export class Kernel {
  constructor({ onProgress, onReady, onFatal } = {}) {
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.pending = new Map();
    this.seq = 0;
    this.isReady = false;
    this.queued = null;
    this.running = false;
    this.worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'progress') return onProgress?.(m.loaded, m.total);
      if (m.type === 'ready') { this.isReady = true; return onReady?.(); }
      if (m.type === 'fatal') return onFatal?.(m.error);
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.ok ? p.resolve(m.result) : p.reject(new Error(m.error));
    };
    this.worker.onerror = (e) => onFatal?.(e.message || 'The geometry worker failed to start');
  }

  call(type, payload) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, payload });
    });
  }

  /** Rebuild (a part, or type 'assembly'); the newest request replaces any queued one. */
  rebuild(payload, type = 'rebuild') {
    return new Promise((resolve, reject) => {
      if (this.queued) this.queued.resolve(null); // superseded
      this.queued = { type, payload, resolve, reject };
      this._pump();
    });
  }

  async _pump() {
    if (this.running || !this.queued) return;
    const job = this.queued;
    this.queued = null;
    this.running = true;
    try { job.resolve(await this.call(job.type, job.payload)); } catch (e) { job.reject(e); }
    this.running = false;
    this._pump();
  }

  export(payload) { return this.call('export', payload); }
  exportAssembly(payload) { return this.call('exportAssembly', payload); }
}
