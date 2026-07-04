// Browser side. Injected by the plugin in dev only. Read-only: observes the DOM,
// never mutates it. Talks to the plugin over long-polling (no HMR/ws coupling).

import {
  parseSourceRef,
  sourceRefMatches,
  boundValue,
  type Locator,
  type Query,
} from "./shared.js";

type El = Record<string, unknown>;

const BASE = "/__insider";
const pageId = Math.random().toString(36).slice(2, 10);

// --- stable refs -----------------------------------------------------------

const refByEl = new WeakMap<Element, string>();
const elByRef = new Map<string, WeakRef<Element>>();
let nextRef = 1;

function refOf(el: Element): string {
  let r = refByEl.get(el);
  if (!r) {
    r = "e" + nextRef++;
    refByEl.set(el, r);
    elByRef.set(r, new WeakRef(el));
  }
  return r;
}

function byRef(ref: string): Element | null {
  const el = elByRef.get(ref)?.deref();
  return el && el.isConnected ? el : null;
}

// --- react fiber mapping ---------------------------------------------------

function fiberOf(el: Element): any {
  for (const k of Object.keys(el)) if (k.startsWith("__reactFiber$")) return (el as any)[k];
  return null;
}

function isRealName(n: unknown): n is string {
  return typeof n === "string" && /^[A-Z]/.test(n) && n.length > 1;
}

// JSX callsite of the fiber's element. React <=18: _debugSource (exact source
// line). React 19: parse _debugStack, the dev-only Error capturing the creation
// stack — path is reliable; line/col are the vite-transformed module's, usually
// but not always identical to the source. Neither present -> absent, never guessed.
function srcFromFiber(f: any): string | undefined {
  const dbg = f?._debugSource ?? f?.memoizedProps?.__source;
  if (dbg?.fileName)
    return dbg.fileName + (dbg.lineNumber ? ":" + dbg.lineNumber + (dbg.columnNumber ? ":" + dbg.columnNumber : "") : "");
  const stack: string | undefined = f?._debugStack?.stack;
  if (!stack) return undefined;
  for (const line of stack.split("\n").slice(1)) {
    const m = line.match(/(\S+?):(\d+):(\d+)\)?\s*$/);
    if (!m) continue;
    let file = m[1].replace(/^\(/, "");
    if (/node_modules|\/deps\/|react-dom|chunk-/.test(file)) continue;
    try { file = new URL(file).pathname; } catch { /* not a URL, keep as-is */ }
    file = file.split("?")[0];
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    return file.replace(/^\//, "") + ":" + m[2] + ":" + m[3];
  }
  return undefined;
}

// nearest real component up the fiber chain + its source location
function componentInfo(el: Element): { component?: string; src?: string; props?: unknown } {
  let f = fiberOf(el);
  const src = srcFromFiber(f); // host fiber only: the callsite that created THIS element
  while (f) {
    const t = f.type;
    const name = typeof t === "function" ? t.displayName || t.name : typeof t === "object" && t ? t.displayName : undefined;
    if (isRealName(name)) {
      return { component: name, src, props: f.memoizedProps };
    }
    f = f.return;
  }
  return { src };
}

// --- geometry & visibility -------------------------------------------------

function box(el: Element) {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
}

function isVisible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const s = getComputedStyle(el);
  return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
}

// --- text ------------------------------------------------------------------

function ownText(el: Element): string {
  let t = "";
  for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) t += n.textContent;
  return t.replace(/\s+/g, " ").trim();
}

// --- styles ----------------------------------------------------------------

// ponytail: crude no-effect list; grows as noise shows up in practice
const NO_EFFECT = new Set(["none", "normal", "auto", "rgba(0, 0, 0, 0)", "0s", "0px"]);

function pickStyles(el: Element, props: string[], parent?: Element): Record<string, string> | undefined {
  const cs = getComputedStyle(el);
  const ps = parent ? getComputedStyle(parent) : null;
  const allNames = Array.from(cs);
  const names = props.length === 1 && props[0] === "all"
    ? allNames
    : props.flatMap((p) =>
        p.includes("*")
          ? allNames.filter((n) => new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(n))
          : [p],
      );
  const out: Record<string, string> = {};
  for (const p of names) {
    const v = cs.getPropertyValue(p);
    if (!v || NO_EFFECT.has(v)) continue;
    if (ps && ps.getPropertyValue(p) === v) continue; // facts once: root states the baseline
    out[p] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

// --- a11y ------------------------------------------------------------------

function a11y(el: Element) {
  const role = el.getAttribute("role") || implicitRole(el);
  const name =
    el.getAttribute("aria-label") ||
    (el as HTMLElement).title ||
    (el as HTMLImageElement).alt ||
    undefined;
  const states: string[] = [];
  if ((el as HTMLButtonElement).disabled) states.push("disabled");
  for (const a of ["aria-expanded", "aria-checked", "aria-selected", "aria-hidden"])
    if (el.hasAttribute(a)) states.push(a.slice(5) + "=" + el.getAttribute(a));
  const out: Record<string, unknown> = {};
  if (role) out.role = role;
  if (name) out.name = name;
  if (states.length) out.states = states;
  return Object.keys(out).length ? out : undefined;
}

function implicitRole(el: Element): string | undefined {
  const map: Record<string, string> = {
    a: "link", button: "button", nav: "navigation", main: "main", header: "banner",
    footer: "contentinfo", aside: "complementary", form: "form", img: "img",
    input: "textbox", select: "combobox", textarea: "textbox", h1: "heading",
    h2: "heading", h3: "heading", table: "table", ul: "list", ol: "list", li: "listitem",
  };
  return map[el.tagName.toLowerCase()];
}

// --- serialization ---------------------------------------------------------

type ReadOpts = {
  styles?: string[]; depth?: number; hidden?: boolean; box?: boolean;
  classes?: boolean; props?: boolean; a11y?: boolean; context?: boolean;
  wait?: { text: string; budgetMs: number };
};

function summarize(el: Element): El {
  const out: El = { ref: refOf(el), kind: el.tagName.toLowerCase() };
  const t = ownText(el);
  if (t) out.text = t.length > 80 ? t.slice(0, 80) + "…" : t;
  const ci = componentInfo(el);
  if (ci.component) out.component = ci.component;
  if (ci.src) out.src = ci.src;
  return out;
}

function serialize(el: Element, opts: ReadOpts, depth: number, parent?: Element, isRoot = false): El | null {
  const visible = isVisible(el);
  if (!opts.hidden && !visible && !isRoot) return null;

  const out: El = { ref: refOf(el), kind: el.tagName.toLowerCase() };
  if (!visible && !isRoot) out.vis = false;
  const t = ownText(el);
  if (t) {
    out.text = t.length > 160 ? t.slice(0, 160) + "…" : t;
    if (t.length > 160) out.textLen = t.length;
  }
  const ci = componentInfo(el);
  if (ci.component) out.component = ci.component;
  if (ci.src) out.src = ci.src;
  if (opts.box || isRoot) out.box = box(el);
  if (opts.styles?.length) {
    const s = pickStyles(el, opts.styles, isRoot ? undefined : parent);
    if (s) out.styles = s;
  }
  if (opts.classes && el.className && typeof el.className === "string")
    out.classes = el.className.split(/\s+/).filter(Boolean);
  if (opts.props && ci.component && ci.props) out.props = boundValue(ci.props);
  if (opts.a11y) {
    const a = a11y(el);
    if (a) out.a11y = a;
  }

  if (depth <= 0) return out;

  const kids: El[] = [];
  let collapsed = 0;
  for (let child of el.children) {
    // collapse structural wrappers: no own text, no component, single element
    // child, same box (±1px) — reported only as a count
    while (
      !ownText(child) && !componentInfo(child).component && child.children.length === 1 &&
      sameBox(child, child.children[0])
    ) {
      collapsed++;
      child = child.children[0];
    }
    const c = serialize(child, opts, depth - 1, el);
    if (c) kids.push(c);
  }
  if (kids.length) out.children = kids;
  if (collapsed) out.collapsed = collapsed;
  return out;
}

function sameBox(a: Element, b: Element): boolean {
  const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
  return Math.abs(ra.x - rb.x) <= 1 && Math.abs(ra.y - rb.y) <= 1 &&
    Math.abs(ra.width - rb.width) <= 1 && Math.abs(ra.height - rb.height) <= 1;
}

// --- locating --------------------------------------------------------------

function all(): Element[] {
  return Array.from(document.body.querySelectorAll("*"));
}

function elSource(el: Element): { path: string; line?: number; component?: string } | null {
  const ci = componentInfo(el);
  if (!ci.src) return null;
  const m = ci.src.match(/^(.*?)(?::(\d+))?(?::\d+)?$/);
  if (!m) return null;
  return { path: m[1], line: m[2] ? Number(m[2]) : undefined, component: ci.component };
}

function locate(loc: Locator): Element | { error: string; hint: string } {
  if ("ref" in loc) {
    const el = byRef(loc.ref);
    return el ?? { error: "not there: " + loc.ref, hint: "ref may be stale after an edit; re-run find or overview" };
  }
  if ("point" in loc) {
    const el = document.elementFromPoint(loc.point[0], loc.point[1]);
    return el ?? { error: "nothing at " + loc.point.join(","), hint: "point is outside the viewport" };
  }
  if ("text" in loc) {
    const q = loc.text.toLowerCase();
    const hits = all().filter((e) => ownText(e).toLowerCase().includes(q));
    if (!hits.length) return { error: "not there: text " + JSON.stringify(loc.text), hint: "try find with a shorter fragment" };
    return hits.reduce((a, b) => (area(a) <= area(b) ? a : b)); // smallest = most specific
  }
  if ("role" in loc) {
    const q = loc.role.toLowerCase();
    const hit = all().find((e) => (e.getAttribute("role") || implicitRole(e)) === q);
    return hit ?? { error: "not there: role " + loc.role, hint: "run overview to see landmarks" };
  }
  const ref = parseSourceRef(loc.src);
  if (!ref) return { error: "bad source ref: " + loc.src, hint: "form: path:line[:col] or path#Component" };
  const hits = all().filter((e) => {
    const s = elSource(e);
    return s && sourceRefMatches(ref, s);
  });
  if (!hits.length) return { error: "not there: src " + loc.src, hint: "line numbers refer to the last compiled source; re-check after edits" };
  return hits.reduce((a, b) => (depthOf(a) <= depthOf(b) ? a : b)); // shallowest = region root
}

function area(el: Element): number {
  const r = el.getBoundingClientRect();
  return r.width * r.height;
}

function depthOf(el: Element): number {
  let d = 0;
  for (let p = el.parentElement; p; p = p.parentElement) d++;
  return d;
}

// --- operations ------------------------------------------------------------

async function opRead(params: { locators: string[]; opts: ReadOpts }): Promise<unknown> {
  let ready = true;
  if (params.opts.wait) {
    ready = await waitFor(params.opts.wait.text, params.opts.wait.budgetMs);
  }
  const regions = [];
  for (const raw of params.locators) {
    const loc = rawToLocator(raw);
    if ("error" in loc) { regions.push(loc); continue; }
    const el = locate(loc);
    if (!(el instanceof Element)) { regions.push(el); continue; }
    const depth = params.opts.depth ?? 6; // ponytail: default depth 6, raise if real pages truncate too eagerly
    const root = serialize(el, params.opts, depth, undefined, true)!;
    const region: El = { root, size: { w: (root.box as any).w, h: (root.box as any).h }, ready };
    const con = widthConstraint(el);
    if (con) region.constraint = con;
    if (params.opts.context) region.context = contextOf(el);
    regions.push(region);
  }
  return { regions };
}

function rawToLocator(raw: string): Locator | { error: string; hint: string } {
  const loc = parseLocatorClient(raw);
  return loc ?? { error: "bad locator: " + raw, hint: "forms: role:x | text:x | ref:eN | point:x,y | src:path:line" };
}

// re-export shape without importing the parser twice
import { parseLocator as parseLocatorClient } from "./shared.js";

function widthConstraint(el: Element): El | null {
  const w = el.getBoundingClientRect().width;
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (cs.maxWidth !== "none" || cs.display === "grid" || cs.display === "flex") {
      const pw = p.getBoundingClientRect().width;
      if (pw <= w + 1) {
        const ci = componentInfo(p);
        return { width: Math.round(pw), imposedBy: ci.component ?? p.tagName.toLowerCase(), ref: refOf(p) };
      }
    }
  }
  return null;
}

function contextOf(el: Element): El {
  const ancestors = [];
  for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement)
    ancestors.push(summarize(p));
  const siblings = el.parentElement
    ? Array.from(el.parentElement.children).filter((s) => s !== el).map(summarize)
    : [];
  const r = el.getBoundingClientRect();
  const stack = document
    .elementsFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    .filter((s) => s !== el)
    .map(summarize);
  return { ancestors, siblings, stack };
}

async function waitFor(text: string, budgetMs: number): Promise<boolean> {
  const end = Date.now() + budgetMs;
  const q = text.toLowerCase();
  while (Date.now() < end) {
    if ((document.body.innerText || "").toLowerCase().includes(q)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return (document.body.innerText || "").toLowerCase().includes(q);
}

function opFind(params: { query: Query; limit: number }): unknown {
  const { query, limit } = params;
  let hits: Element[] = [];
  if (query.text) {
    const q = query.text.toLowerCase();
    hits = all().filter((e) => ownText(e).toLowerCase().includes(q));
  } else if (query.component) {
    hits = all().filter((e) => componentInfo(e).component === query.component);
  } else if (query.src) {
    const ref = parseSourceRef(query.src);
    if (!ref) return { error: "bad source ref: " + query.src, hint: "form: path:line[:col] or path#Component" };
    hits = all().filter((e) => {
      const s = elSource(e);
      return s && sourceRefMatches(ref, s);
    });
  }
  return { total: hits.length, shown: Math.min(hits.length, limit), items: hits.slice(0, limit).map(summarize) };
}

function opOverview(): unknown {
  const landmarks = Array.from(
    document.querySelectorAll("header,nav,main,aside,footer,[role]"),
  ).filter(isVisible).map(summarize);

  const vp = window.innerWidth * window.innerHeight;
  const regions: El[] = [];
  const scan = (el: Element, depth: number) => {
    for (const c of el.children) {
      if (!isVisible(c)) continue;
      if (area(c) >= vp * 0.05) regions.push(summarize(c));
      if (depth > 0 && regions.length < 30) scan(c, depth - 1);
    }
  };
  scan(document.body, 2);

  const seen = new Set<string>();
  const components: El[] = [];
  for (const e of all()) {
    const ci = componentInfo(e);
    if (ci.component && !seen.has(ci.component)) {
      seen.add(ci.component);
      components.push(summarize(e));
      if (components.length >= 30) break;
    }
  }
  return { regions, landmarks, components };
}

// --- transport: long-poll --------------------------------------------------

// whole-page capture: everything queryable later, in one walk
function opCapture(): unknown {
  const root = serialize(
    document.body,
    { styles: ["all"], box: true, classes: true, props: true, a11y: true, hidden: true },
    999,
    undefined,
    true,
  )!;
  return { root, url: location.href, title: document.title, viewport: { w: window.innerWidth, h: window.innerHeight } };
}

async function handle(op: string, params: any): Promise<unknown> {
  switch (op) {
    case "read": return opRead(params);
    case "find": return opFind(params);
    case "overview": return opOverview();
    case "capture": return opCapture();
    default: return { error: "unknown op: " + op, hint: "ops: read, find, overview, capture" };
  }
}

function pageInfo() {
  return {
    id: pageId,
    url: location.href,
    title: document.title,
    viewport: { w: window.innerWidth, h: window.innerHeight },
  };
}

async function loop() {
  // ponytail: plain long-poll loop; one in-flight poll per page, retry with backoff on failure
  for (;;) {
    try {
      const res = await fetch(BASE + "/poll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(pageInfo()),
      });
      if (!res.ok) throw new Error(String(res.status));
      const req = await res.json();
      if (!req || !req.id) continue; // poll timeout tick, re-poll
      let out: unknown;
      try {
        out = await handle(req.op, req.params);
      } catch (e) {
        out = { error: "page failed to answer: " + String(e), hint: "element may have unmounted mid-read; retry" };
      }
      await fetch(BASE + "/res", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: req.id, page: pageId, data: out }),
      });
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

loop();
