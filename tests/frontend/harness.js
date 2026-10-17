"use strict";
// harness.js — DOM mínimo sin dependencias para correr los módulos de
// docs/js bajo node:test con vm. El árbol se construye parseando el
// <body> de scripts/template.html — la fuente real de docs/index.html —
// así los tests ejecutan el markup y el JS de producción, no copias.
const fs = require("fs"), path = require("path"), vm = require("node:vm");
const ROOT = path.join(__dirname, "..", "..");
const srcOf = f =>
  fs.readFileSync(path.join(ROOT, "docs", "js", f), "utf8");
const MODS = ["state.js", "siman.js", "sync.js", "render.js", "app.js"];

const VOID = new Set(("area base br col embed hr img input link meta "
  + "source track wbr").split(" "));
const RAWTEXT = new Set(["script", "style", "textarea", "title"]);
const camel = s => s.replace(/-(\w)/g, (_, c) => c.toUpperCase());

function parseAttrs(s) {
  const o = {}, re =
    /([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(s))) o[m[1]] = m[2] ?? m[3] ?? m[4] ?? "";
  return o;
}

function walk(el, fn) { for (const c of el.children) { fn(c); walk(c, fn); } }

// selector: combinador descendiente + compuesto simple
// (tag, #id, .cls, [attr], [attr="v"]) — cubre lo que usan los módulos
const PART = /([#.][\w-]+|\[[^\]]*\]|[\w-]+|\*)/g;
function matchPart(el, part) {
  const toks = part.match(PART) || [];
  if (!toks.length) return false;
  for (const t of toks) {
    if (t === "*") continue;
    if (t[0] === ".") { if (!el.classSet.has(t.slice(1))) return false; continue; }
    if (t[0] === "#") { if (el.id !== t.slice(1)) return false; continue; }
    if (t[0] === "[") {
      const m = /^\[([\w-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\]]*)))?\]$/
        .exec(t);
      if (!m || !(m[1] in el.attrs)) return false;
      const want = m[3] ?? m[4] ?? m[5];
      if (want !== undefined && el.attrs[m[1]] !== want) return false;
      continue;
    }
    if (el.tag !== t.toLowerCase()) return false;
  }
  return true;
}
function matchesSel(el, sel) {
  const parts = sel.trim().split(/\s+/);
  if (!matchPart(el, parts[parts.length - 1])) return false;
  let cur = el.parent;
  for (let i = parts.length - 2; i >= 0; i--) {
    while (cur && !matchPart(cur, parts[i])) cur = cur.parent;
    if (!cur) return false;
    cur = cur.parent;
  }
  return true;
}

function parseInto(root, html, doc) {
  const stack = [root], top = () => stack[stack.length - 1];
  let i = 0; const n = html.length;
  while (i < n) {
    if (html[i] !== "<") {
      let j = html.indexOf("<", i); if (j < 0) j = n;
      top()._text += html.slice(i, j); i = j; continue;
    }
    if (html.startsWith("<!--", i)) {
      const j = html.indexOf("-->", i + 4);
      i = j < 0 ? n : j + 3; continue;
    }
    const m = /^<(\/?)([a-zA-Z][\w-]*)([^>]*)>/.exec(html.slice(i));
    if (!m) { top()._text += "<"; i++; continue; }
    const [, slash, tag, rest] = m;
    i += m[0].length;
    if (slash) {
      for (let k = stack.length - 1; k > 0; k--)
        if (stack[k].tag === tag) { stack.length = k; break; }
      continue;
    }
    const selfClose = /\/\s*$/.test(rest);
    const el = new El(tag, parseAttrs(rest.replace(/\/\s*$/, "")), doc);
    el.parent = top(); top().children.push(el);
    if (selfClose || VOID.has(el.tag)) continue;
    if (RAWTEXT.has(el.tag)) {
      const j = html.toLowerCase().indexOf("</" + el.tag, i);
      if (j < 0) { el._text = html.slice(i); i = n; }
      else { el._text = html.slice(i, j); i = j; }
      continue; // el </tag> llega suelto y se ignora (sin stack entry)
    }
    stack.push(el);
  }
}

class El {
  constructor(tag, at = {}, doc = null) {
    this.tag = tag.toLowerCase();
    this.tagName = tag.toUpperCase();
    this.attrs = at;
    this.children = [];
    this.parent = null;
    this.doc = doc;
    this._text = "";
    this._html = "";
    this.classSet = new Set((at.class || "").split(/\s+/).filter(Boolean));
    this.dataset = {};
    for (const k in at)
      if (k.startsWith("data-")) this.dataset[camel(k.slice(5))] = at[k];
    this.style = {};
    if (at.style)
      for (const d of at.style.split(";")) {
        const i = d.indexOf(":");
        if (i > 0)
          this.style[camel(d.slice(0, i).trim())] = d.slice(i + 1).trim();
      }
    this.id = at.id || "";
    this.open = "open" in at;               // <details>/<dialog>
    this.value = at.value ?? "";
    this.checked = "checked" in at;
    this.disabled = "disabled" in at;
    this.href = at.href || "";
    this.src = at.src || "";
    this.title = at.title || "";
    this.offsetWidth = 0;
    this._listeners = {};
  }
  get classList() {
    const s = this.classSet;
    return {
      add: (...c) => c.forEach(x => s.add(x)),
      remove: (...c) => c.forEach(x => s.delete(x)),
      toggle: (c, f) => {
        (f === undefined ? !s.has(c) : f) ? s.add(c) : s.delete(c);
        return s.has(c);
      },
      contains: c => s.has(c),
    };
  }
  get className() { return [...this.classSet].join(" "); }
  set className(v) {
    this.classSet = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  setAttribute(k, v) {
    v = String(v);
    this.attrs[k] = v;
    if (k === "class")
      this.classSet = new Set(v.split(/\s+/).filter(Boolean));
    else if (k.startsWith("data-")) this.dataset[camel(k.slice(5))] = v;
    else if (k === "id") this.id = v;
  }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  hasAttribute(k) { return k in this.attrs; }
  removeAttribute(k) { delete this.attrs[k]; }
  set innerHTML(html) {
    this._html = String(html);
    this.children = []; this._text = "";
    parseInto(this, this._html, this.doc);
  }
  get innerHTML() { return this._html; }
  get textContent() {
    return this._text + this.children.map(c => c.textContent).join("");
  }
  set textContent(v) { this.children = []; this._text = String(v); }
  addEventListener(t, f) { (this._listeners[t] ||= []).push(f); }
  removeEventListener(t, f) {
    const a = this._listeners[t];
    if (a) { const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); }
  }
  // dispara listeners del propio nodo (sin bubbling — los tests arman el
  // target que quieren, igual que en el browser la delegacion la hace el
  // handler con e.target.closest)
  _fire(type, ev = {}) {
    ev.type = type;
    if (!("target" in ev)) ev.target = this;
    ev.preventDefault ||= () => {};
    ev.stopPropagation ||= () => {};
    for (const f of (this._listeners[type] || []).slice()) f.call(this, ev);
  }
  click() {
    if (this.onclick)
      this.onclick.call(this,
        { target: this, preventDefault() {}, stopPropagation() {} });
  }
  focus() { if (this.doc) this.doc.activeElement = this; }
  remove() {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i >= 0) this.parent.children.splice(i, 1);
    this.parent = null;
  }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  insertAdjacentHTML(pos, html) {
    const tmp = new El("div", {}, this.doc);
    parseInto(tmp, String(html), this.doc);
    const nodes = tmp.children;
    const put = (arr, at) =>
      nodes.forEach((n, k) => { n.parent = arr === this ? this : this.parent;
        (arr === this ? this.children : this.parent.children)
          .splice(at + k, 0, n); });
    if (pos === "beforeend") nodes.forEach(n => this.appendChild(n));
    else if (pos === "afterbegin") put(this, 0);
    else if (pos === "afterend" && this.parent)
      put(this.parent, this.parent.children.indexOf(this) + 1);
    else if (pos === "beforebegin" && this.parent)
      put(this.parent, this.parent.children.indexOf(this));
  }
  matches(sel) { return matchesSel(this, sel); }
  closest(sel) {
    let e = this;
    while (e) { if (matchesSel(e, sel)) return e; e = e.parent; }
    return null;
  }
  querySelectorAll(sel) {
    const out = [];
    walk(this, e => { if (e !== this && matchesSel(e, sel)) out.push(e); });
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  showModal() { this.open = true; }
  show() { this.open = true; }
  close() { this.open = false; this._fire("close"); }
  getBoundingClientRect() {
    return { top: 0, left: 0, right: 100, bottom: 100,
             width: 100, height: 100 };
  }
}

class Doc {
  constructor() {
    this.root = new El("#document", {}, this);
    this._listeners = {};
    this.activeElement = null;
    this.hidden = false;
    this.documentElement = this.root;
    this.head = new El("head", {}, this);
    this.body = new El("body", {}, this);
    this.head.parent = this.body.parent = this.root;
    this.root.children = [this.head, this.body];
  }
  addEventListener(t, f) { (this._listeners[t] ||= []).push(f); }
  removeEventListener() {}
  _fire(type, ev = {}) {
    ev.type = type;
    ev.preventDefault ||= () => {};
    ev.stopPropagation ||= () => {};
    for (const f of (this._listeners[type] || []).slice()) f.call(this, ev);
  }
  getElementById(id) {
    let out = null;
    walk(this.root, e => { if (!out && e.id === id) out = e; });
    return out;
  }
  querySelectorAll(sel) {
    const out = [];
    walk(this.root, e => { if (matchesSel(e, sel)) out.push(e); });
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  createElement(t) { return new El(t, {}, this); }
}

function buildDom() {
  const html = fs.readFileSync(path.join(ROOT, "scripts", "template.html"),
    "utf8");
  const doc = new Doc();
  const body = /<body>([\s\S]*)<\/body>/.exec(html)[1];
  parseInto(doc.body, body, doc);
  return doc;
}

// payload minimo pero realista (misma forma que scripts/build_site.py)
const DEMO_D = {
  generated: "2026-09-29", built: "b-test", n_products: 1,
  products: { "111": { title: "Prod Uno", brand: "Marca",
                       category: "Cat", slug: "prod-uno" } },
  series: { "111": [["2026-09-27", 2500, 1, 0],
                    ["2026-09-28", 2400, 1, 2],
                    ["2026-09-29", 2300, 1, 3]] },
  agg: { "111": { min: 2300, max: 2500, med: 2400, pct_min: 0,
                  vs_med: -4, n_ch: 2, last_ch: "2026-09-29",
                  d_out: 0, n_out: 0 } },
  events: [{ type: "bajo", sku: "111", date: "2026-09-29",
             from: 2500, to: 2300, pct: -8, title: "Prod Uno" }],
  ofertas: [], clubs: {}, clubh: {},
  siman: { items: [], events: [], watches: [] },
  mis: [], demo: false,
};

// shape de window.Appwrite: solo lo que sync.js construye/consulta;
// listRows lo sustituye cada test con su mock
const APPWRITE_STUB = {
  Client: class { setEndpoint() { return this; } setProject() { return this; } },
  Account: class {},
  TablesDB: class {},
  Query: {
    limit: n => ({ q: "limit", n }),
    orderAsc: f => ({ q: "asc", f }),
    cursorAfter: c => ({ q: "after", c }),
  },
  ID: { unique: () => "u1" },
  Permission: { read: u => `read ${u}`, update: u => `update ${u}`,
                delete: u => `delete ${u}` },
  Role: { user: u => `user ${u}` },
};

// makeCtx: DOM + globals de browser stubeados. Nada de fetch real:
// cualquier intento de red queda registrado en __netCalls y rechaza.
function makeCtx(opts = {}) {
  const doc = buildDom();
  const mem = new Map(Object.entries(opts.stored || {}));
  // viewport real: min-width y max-width son excluyentes — el stub
  // anterior respondia `mobile` para ambos y (min-width:900px) y
  // (max-width:700px) matcheaban a la vez en mobile
  const vw = opts.width || (opts.mobile ? 390 : 1280);
  const localStorage = {
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: k => { mem.delete(k); },
    _mem: mem,
  };
  const netCalls = [], intervals = { n: 0 };
  const ctx = {
    console,
    document: doc,
    localStorage,
    navigator: { userAgent: "node-test" },
    location: {
      search: opts.search || "",
      origin: "http://localhost",
      pathname: "/",
      href: "http://localhost/",
      reload() {},
    },
    history: { replaceState() {} },
    matchMedia: q => {
      const mm = /\((min|max)-width:\s*(\d+)px\)/.exec(q || "");
      const matches = mm
        ? (mm[1] === "min" ? vw >= +mm[2] : vw <= +mm[2])
        : false;
      return { matches, addEventListener() {} };
    },
    requestAnimationFrame: () => 0,
    setInterval: () => { intervals.n++; return intervals.n; },
    clearInterval() {},
    setTimeout: () => 0,   // nunca corre: debounce/retries quedan mudos
    clearTimeout() {},
    confirm: () => true,
    prompt: () => null,
    URLSearchParams,
    URL,
    fetch: u => {
      netCalls.push(String(u));
      return Promise.reject(new Error("sin red en tests"));
    },
    D: opts.data || DEMO_D,
    __netCalls: netCalls,
    __intervals: intervals,
    __doc: doc,
  };
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  // window[id] para elementos con id (named-property access del browser;
  // app.js usa el global suelto `upd`)
  ctx.upd = doc.getElementById("upd");
  if (opts.echarts) ctx.echarts = opts.echarts === true
    ? { inits: 0, init() { this.inits++;
          return { setOption() {}, resize() {}, on() {}, off() {} }; } }
    : opts.echarts;
  if (opts.appwrite) ctx.Appwrite = opts.appwrite;
  vm.createContext(ctx);
  return ctx;
}

// evalúa los módulos en el orden del loader de index.html
function boot(ctx, files = MODS) {
  for (const f of files)
    vm.runInContext(srcOf(f), ctx, { filename: "docs/js/" + f });
}

module.exports = { makeCtx, boot, srcOf, MODS, DEMO_D, APPWRITE_STUB, vm };
