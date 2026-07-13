// Server-side query engine over a captured snapshot tree. Pure: no vite, no DOM.
// Mirrors the client's live semantics so --snap answers look identical to live ones.

import { parseSourceRef, sourceRefMatches, type Locator, type Query } from "./shared.js";

export type SnapNode = {
  ref: string; kind: string; text?: string; component?: string; src?: string; note?: string;
  box?: { x: number; y: number; w: number; h: number };
  styles?: Record<string, string>; classes?: string[]; props?: unknown;
  a11y?: { role?: string; name?: string; states?: string[] };
  vis?: false; children?: SnapNode[]; collapsed?: number;
};

export type Snapshot = {
  id: string; tag?: string; page: string; url: string; title: string;
  viewport: { w: number; h: number }; takenAt: number; root: SnapNode;
  notes?: unknown[];                  // page's annotations at capture time
};

type Index = { byRef: Map<string, SnapNode>; parent: Map<SnapNode, SnapNode>; all: SnapNode[] };

const indexCache = new WeakMap<SnapNode, Index>();

function indexOf(snap: Snapshot): Index {
  let idx = indexCache.get(snap.root);
  if (idx) return idx;
  idx = { byRef: new Map(), parent: new Map(), all: [] };
  const walk = (n: SnapNode, p?: SnapNode) => {
    idx!.byRef.set(n.ref, n);
    if (p) idx!.parent.set(n, p);
    idx!.all.push(n);
    for (const c of n.children ?? []) walk(c, n);
  };
  walk(snap.root);
  indexCache.set(snap.root, idx);
  return idx;
}

function ancestors(n: SnapNode, idx: Index): SnapNode[] {
  const out: SnapNode[] = [];
  for (let p = idx.parent.get(n); p; p = idx.parent.get(p)) out.push(p);
  return out;
}

function depthOf(n: SnapNode, idx: Index): number {
  return ancestors(n, idx).length;
}

function area(n: SnapNode): number {
  return n.box ? n.box.w * n.box.h : 0;
}

// effective style: captured trees are facts-once deduped, so walk up for inherited values
function effectiveStyle(n: SnapNode, prop: string, idx: Index): string | undefined {
  for (let c: SnapNode | undefined = n; c; c = idx.parent.get(c)) {
    const v = c.styles?.[prop];
    if (v !== undefined) return v;
  }
  return undefined;
}

function expandStyleNames(props: string[], n: SnapNode, idx: Index): string[] {
  const candidates = new Set<string>();
  for (let c: SnapNode | undefined = n; c; c = idx.parent.get(c))
    for (const k of Object.keys(c.styles ?? {})) candidates.add(k);
  if (props.length === 1 && props[0] === "all") return [...candidates];
  return props.flatMap((p) => {
    if (p.includes("*"))
      return [...candidates].filter((k) => new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(k));
    // captures hold longhands only ("padding-top", not "padding") — a shorthand
    // request falls back to its longhands, but only when the exact name is unknown
    if (candidates.has(p)) return [p];
    return [p, ...[...candidates].filter((k) => k.startsWith(p + "-"))];
  });
}

// --- locating ----------------------------------------------------------------

function summarize(n: SnapNode): SnapNode {
  const out: SnapNode = { ref: n.ref, kind: n.kind };
  if (n.text) out.text = n.text.length > 80 ? n.text.slice(0, 80) + "…" : n.text;
  if (n.component) out.component = n.component;
  if (n.src) out.src = n.src;
  if (n.note) out.note = n.note;
  return out;
}

function locate(loc: Locator, snap: Snapshot): SnapNode | { error: string; hint: string } {
  const idx = indexOf(snap);
  if ("ref" in loc) {
    return idx.byRef.get(loc.ref) ?? { error: "not there: " + loc.ref, hint: "not in snapshot " + snap.id + "; run overview --snap " + snap.id };
  }
  if ("point" in loc) {
    const [x, y] = loc.point;
    const hits = idx.all.filter((n) => n.vis !== false && n.box && x >= n.box.x && x <= n.box.x + n.box.w && y >= n.box.y && y <= n.box.y + n.box.h);
    if (!hits.length) return { error: "nothing at " + x + "," + y, hint: "point is outside the captured viewport" };
    return hits.reduce((a, b) => (depthOf(a, idx) >= depthOf(b, idx) ? a : b));
  }
  if ("text" in loc) {
    const q = loc.text.toLowerCase();
    const hits = idx.all.filter((n) => n.text?.toLowerCase().includes(q));
    if (!hits.length) return { error: "not there: text " + JSON.stringify(loc.text), hint: "try find with a shorter fragment" };
    return hits.reduce((a, b) => (area(a) <= area(b) ? a : b));
  }
  if ("role" in loc) {
    const hit = idx.all.find((n) => n.a11y?.role === loc.role.toLowerCase());
    return hit ?? { error: "not there: role " + loc.role, hint: "run overview --snap " + snap.id + " to see landmarks" };
  }
  const ref = parseSourceRef(loc.src);
  if (!ref) return { error: "bad source ref: " + loc.src, hint: "form: path:line[:col] or path#Component" };
  const hits = idx.all.filter((n) => {
    if (!n.src) return false;
    const m = n.src.match(/^(.*?)(?::(\d+))?(?::\d+)?$/);
    return m && sourceRefMatches(ref, { path: m[1], line: m[2] ? Number(m[2]) : undefined, component: n.component });
  });
  if (!hits.length) return { error: "not there: src " + loc.src, hint: "snapshot predates or lacks that source; check snap ls for age" };
  return hits.reduce((a, b) => (depthOf(a, idx) <= depthOf(b, idx) ? a : b));
}

// --- operations ---------------------------------------------------------------

type ReadOpts = {
  styles?: string[]; depth?: number; hidden?: boolean; box?: boolean;
  classes?: boolean; props?: boolean; a11y?: boolean; context?: boolean;
};

function project(n: SnapNode, opts: ReadOpts, depth: number, idx: Index, parent?: SnapNode, isRoot = false): SnapNode | null {
  if (!opts.hidden && n.vis === false && !isRoot) return null;
  const out: SnapNode = { ref: n.ref, kind: n.kind };
  if (n.text) out.text = n.text;
  if (n.component) out.component = n.component;
  if (n.src) out.src = n.src;
  if (n.note) out.note = n.note;
  if (n.vis === false) out.vis = false;
  if ((opts.box || isRoot) && n.box) out.box = n.box;
  if (opts.styles?.length) {
    const styles: Record<string, string> = {};
    for (const p of expandStyleNames(opts.styles, n, idx)) {
      const v = effectiveStyle(n, p, idx);
      if (v === undefined) continue;
      if (!isRoot && parent && effectiveStyle(parent, p, idx) === v) continue; // facts once
      styles[p] = v;
    }
    if (Object.keys(styles).length) out.styles = styles;
  }
  if (opts.classes && n.classes) out.classes = n.classes;
  if (opts.props && n.props !== undefined) out.props = n.props;
  if (opts.a11y && n.a11y) out.a11y = n.a11y;
  if (n.collapsed) out.collapsed = n.collapsed;
  if (depth > 0 && n.children?.length) {
    const kids = n.children.map((c) => project(c, opts, depth - 1, idx, n)).filter(Boolean) as SnapNode[];
    if (kids.length) out.children = kids;
  }
  return out;
}

export function snapRead(snap: Snapshot, locators: Locator[], opts: ReadOpts): unknown {
  const idx = indexOf(snap);
  const regions = locators.map((loc) => {
    const n = locate(loc, snap);
    if ("error" in n) return n;
    const node = n as SnapNode;
    const root = project(node, opts, opts.depth ?? 6, idx, undefined, true)!;
    const region: Record<string, unknown> = { root, ready: true };
    if (node.box) region.size = { w: node.box.w, h: node.box.h };
    if (opts.context) {
      const anc = ancestors(node, idx);
      const parent = idx.parent.get(node);
      const siblings = (parent?.children ?? []).filter((s) => s !== node).map(summarize);
      const cx = node.box ? node.box.x + node.box.w / 2 : 0;
      const cy = node.box ? node.box.y + node.box.h / 2 : 0;
      const stack = idx.all
        .filter((o) => o !== node && o.vis !== false && o.box && cx >= o.box.x && cx <= o.box.x + o.box.w && cy >= o.box.y && cy <= o.box.y + o.box.h)
        .sort((a, b) => depthOf(b, idx) - depthOf(a, idx))
        .map(summarize);
      region.context = { ancestors: anc.map(summarize), siblings, stack };
    }
    return region;
  });
  return { regions };
}

export function snapFind(snap: Snapshot, query: Query, limit: number): unknown {
  const idx = indexOf(snap);
  let hits: SnapNode[] = [];
  if (query.text) {
    const q = query.text.toLowerCase();
    hits = idx.all.filter((n) => n.text?.toLowerCase().includes(q));
  } else if (query.component) {
    hits = idx.all.filter((n) => n.component === query.component);
  } else if (query.src) {
    const ref = parseSourceRef(query.src);
    if (!ref) return { error: "bad source ref: " + query.src, hint: "form: path:line[:col] or path#Component" };
    hits = idx.all.filter((n) => {
      if (!n.src) return false;
      const m = n.src.match(/^(.*?)(?::(\d+))?(?::\d+)?$/);
      return m && sourceRefMatches(ref, { path: m[1], line: m[2] ? Number(m[2]) : undefined, component: n.component });
    });
  }
  return { total: hits.length, shown: Math.min(hits.length, limit), items: hits.slice(0, limit).map(summarize) };
}

export function snapOverview(snap: Snapshot): unknown {
  const idx = indexOf(snap);
  const vp = snap.viewport.w * snap.viewport.h;
  const LANDMARK = new Set(["header", "nav", "main", "aside", "footer"]);
  const landmarks = idx.all.filter((n) => n.vis !== false && (LANDMARK.has(n.kind) || n.a11y?.role)).slice(0, 30).map(summarize);
  const regions = idx.all
    .filter((n) => n.vis !== false && area(n) >= vp * 0.05 && depthOf(n, idx) <= 3 && n !== snap.root)
    .slice(0, 30)
    .map(summarize);
  const seen = new Set<string>();
  const components: SnapNode[] = [];
  for (const n of idx.all) {
    if (n.component && !seen.has(n.component)) {
      seen.add(n.component);
      components.push(summarize(n));
      if (components.length >= 30) break;
    }
  }
  return { regions, landmarks, components };
}
