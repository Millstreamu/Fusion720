// Safe expression evaluator for parametric values.
// Supports + - * / ^, parentheses, unit suffixes (mm cm m in ft deg rad),
// user parameters, constants (pi) and a few math functions (angles in degrees).

const UNITS = { mm: 1, cm: 10, m: 1000, in: 25.4, inch: 25.4, ft: 304.8, deg: 1, rad: 180 / Math.PI };
const CONSTS = { pi: Math.PI, PI: Math.PI, e: Math.E };
const D2R = Math.PI / 180;
const FUNCS = {
  sin: (a) => Math.sin(a * D2R), cos: (a) => Math.cos(a * D2R), tan: (a) => Math.tan(a * D2R),
  asin: (x) => Math.asin(x) / D2R, acos: (x) => Math.acos(x) / D2R, atan: (x) => Math.atan(x) / D2R,
  atan2: (y, x) => Math.atan2(y, x) / D2R,
  sqrt: Math.sqrt, abs: Math.abs, min: Math.min, max: Math.max, round: Math.round,
  floor: Math.floor, ceil: Math.ceil, pow: Math.pow, hypot: Math.hypot,
};

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n') { i++; continue; }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new Error(`Bad number near "${src.slice(i, i + 6)}"`);
      out.push({ t: 'num', v: parseFloat(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      out.push({ t: 'id', v: m[0] });
      i += m[0].length;
      continue;
    }
    if ('+-*/^(),'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    throw new Error(`Unexpected "${c}"`);
  }
  return out;
}

class Parser {
  constructor(tokens, resolve) { this.k = tokens; this.i = 0; this.resolve = resolve; }
  peek() { return this.k[this.i]; }
  next() { return this.k[this.i++]; }
  isOp(v) { const t = this.peek(); return t && t.t === 'op' && t.v === v; }
  expect(v) { if (!this.isOp(v)) throw new Error(`Expected "${v}"`); this.i++; }
  parse() {
    const v = this.expr();
    if (this.i < this.k.length) throw new Error(`Unexpected "${this.peek().v}"`);
    return v;
  }
  expr() {
    let v = this.term();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.next().v;
      const r = this.term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  term() {
    let v = this.power();
    for (;;) {
      if (this.isOp('*') || this.isOp('/')) {
        const op = this.next().v;
        const r = this.power();
        if (op === '/' && r === 0) throw new Error('Division by zero');
        v = op === '*' ? v * r : v / r;
      } else if (this.peek() && (this.peek().t === 'num' || this.isOp('('))) {
        v = v * this.power(); // implicit multiplication: 2(3)
      } else break;
    }
    return v;
  }
  power() {
    const b = this.unary();
    if (this.isOp('^')) { this.next(); return Math.pow(b, this.power()); }
    return b;
  }
  unary() {
    if (this.isOp('-')) { this.next(); return -this.unary(); }
    if (this.isOp('+')) { this.next(); return this.unary(); }
    return this.primary();
  }
  primary() {
    const t = this.next();
    if (!t) throw new Error('Unexpected end');
    if (t.t === 'num') {
      const u = this.peek();
      if (u && u.t === 'id' && UNITS[u.v] !== undefined) { this.next(); return t.v * UNITS[u.v]; }
      return t.v;
    }
    if (t.t === 'op' && t.v === '(') { const v = this.expr(); this.expect(')'); return v; }
    if (t.t === 'id') {
      if (this.isOp('(')) {
        const f = FUNCS[t.v];
        if (!f) throw new Error(`Unknown function "${t.v}"`);
        this.next();
        const args = [];
        if (!this.isOp(')')) {
          args.push(this.expr());
          while (this.isOp(',')) { this.next(); args.push(this.expr()); }
        }
        this.expect(')');
        return f(...args);
      }
      if (CONSTS[t.v] !== undefined) return CONSTS[t.v];
      if (UNITS[t.v] !== undefined && t.v !== 'e') return UNITS[t.v];
      return this.resolve(t.v);
    }
    throw new Error(`Unexpected "${t.v}"`);
  }
}

/** Evaluate an expression string (or number) against a scope of named values. Throws on error. */
export function evaluate(src, scope = {}) {
  if (typeof src === 'number') return src;
  if (src === undefined || src === null || String(src).trim() === '') throw new Error('Empty value');
  const parser = new Parser(tokenize(String(src)), (name) => {
    if (Object.prototype.hasOwnProperty.call(scope, name)) {
      const v = scope[name];
      if (v instanceof Error) throw v;
      return v;
    }
    throw new Error(`Unknown parameter "${name}"`);
  });
  const v = parser.parse();
  if (!Number.isFinite(v)) throw new Error('Result is not a finite number');
  return v;
}

export function tryEvaluate(src, scope) {
  try { return { value: evaluate(src, scope), error: null }; } catch (e) { return { value: NaN, error: e.message }; }
}

export const isValidName = (n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !FUNCS[n] && CONSTS[n] === undefined && UNITS[n] === undefined;

/** Evaluate all user parameters in order-independent fashion (with cycle detection). */
export function evaluateParams(params) {
  const byName = new Map(params.map((p) => [p.name, p]));
  const scope = {};
  const state = new Map();
  const visit = (name) => {
    if (state.get(name) === 'done') return scope[name];
    if (state.get(name) === 'busy') throw new Error(`Circular reference involving "${name}"`);
    state.set(name, 'busy');
    const p = byName.get(name);
    const sub = new Proxy({}, {
      has: (_, k) => byName.has(k),
      get: (_, k) => visit(k),
    });
    let v;
    try {
      const parser = new Parser(tokenize(String(p.expr)), (n) => { if (!byName.has(n)) throw new Error(`Unknown parameter "${n}"`); return sub[n]; });
      v = parser.parse();
      if (!Number.isFinite(v)) throw new Error('Not a finite number');
    } catch (e) {
      v = e instanceof Error ? e : new Error(String(e));
    }
    scope[name] = v;
    state.set(name, 'done');
    if (v instanceof Error) throw v;
    return v;
  };
  for (const p of params) { try { visit(p.name); } catch { /* recorded in scope */ } }
  return scope;
}

/** Format a number for display (trim trailing zeros). */
export function fmt(v, digits = 3) {
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) < Math.pow(10, -digits) / 2) v = 0; // avoid "-0"
  const s = v.toFixed(digits);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}
