// Vite plugin: serves the inspector alongside the dev server. Dev only —
// `apply: "serve"` means a production build contains no trace of it.

import { readFileSync } from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, ViteDevServer } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { snapRead, snapFind, snapOverview, type Snapshot } from "./snapquery.js";
import { parseLocator } from "./shared.js";
import { NoteStore, type NoteAnchor } from "./notes.js";

const BASE = "/__insider";
const STALE_MS = 35_000; // must exceed the 25s parked-poll hold, else idle pages flap stale
const MAX_SNAPS = 20;

type Page = { id: string; url: string; title: string; viewport: unknown; lastSeen: number };
type Pending = { resolve: (v: unknown) => void; timer: NodeJS.Timeout };

export default function insider(): Plugin {
  const pages = new Map<string, Page>();
  const queues = new Map<string, { id: string; op: string; params: unknown }[]>();
  const parked = new Map<string, ServerResponse>(); // one held poll per page
  const pending = new Map<string, Pending>();
  const snaps = new Map<string, Snapshot>(); // dev-server session lifetime
  let nextReq = 1;
  let nextSnap = 1;
  let root = "";

  function livePages(): Page[] {
    const now = Date.now();
    for (const [id, p] of pages) if (now - p.lastSeen > STALE_MS) { pages.delete(id); queues.delete(id); }
    return [...pages.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  }

  function resolvePage(target: string | null): Page | { error: string; hint: string; exists?: string[] } {
    const live = livePages();
    if (!live.length) return { error: "0 pages connected", hint: "open the app in a browser, then retry" };
    if (!target) return live[0]; // most recently active
    const t = target.toLowerCase();
    const hit = live.find((p) => p.id === target) ??
      live.find((p) => p.url.toLowerCase().includes(t) || p.title.toLowerCase().includes(t));
    if (hit) return hit;
    return {
      error: "unknown page: " + target,
      hint: "target a page by id or any fragment of its URL or title",
      exists: live.map((p) => p.id + " " + p.url),
    };
  }

  function ask(page: Page, op: string, params: unknown, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve) => {
      const id = "r" + nextReq++;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ error: "page did not answer in " + timeoutMs + "ms", hint: "page may be busy or frozen; reload it and retry" });
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      const req = { id, op, params };
      const held = parked.get(page.id);
      if (held) {
        parked.delete(page.id);
        held.end(JSON.stringify(req));
      } else {
        let q = queues.get(page.id);
        if (!q) queues.set(page.id, (q = []));
        q.push(req);
      }
    });
  }

  // --- sourcemap remap: compiled line:col -> authored line:col ---------------
  // React 19's _debugStack yields positions in the vite-transformed module; the
  // dev server holds that module's sourcemap, so remap before answering.

  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  // decode a sourcemap "mappings" string -> per generated line: sorted [genCol, origLine, origCol]
  function decodeMappings(mappings: string): number[][][] {
    const lines: number[][][] = [];
    let srcIdx = 0, origLine = 0, origCol = 0;
    for (const lineStr of mappings.split(";")) {
      const segs: number[][] = [];
      let genCol = 0;
      for (const segStr of lineStr.split(",")) {
        if (!segStr) continue;
        const nums: number[] = [];
        let value = 0, shift = 0;
        for (const ch of segStr) {
          const d = B64.indexOf(ch);
          value |= (d & 31) << shift;
          if (d & 32) shift += 5;
          else { nums.push(value & 1 ? -(value >>> 1) : value >>> 1); value = 0; shift = 0; }
        }
        genCol += nums[0];
        if (nums.length >= 4) {
          srcIdx += nums[1]; origLine += nums[2]; origCol += nums[3];
          if (srcIdx === 0) segs.push([genCol, origLine, origCol]);
        }
      }
      lines.push(segs);
    }
    return lines;
  }

  const mapCache = new WeakMap<object, number[][][]>();

  function remap(urlPath: string, line: number, col: number, server: ViteDevServer): { line: number; col: number } | null {
    const mod = server.moduleGraph.urlToModuleMap.get(urlPath);
    const map = mod?.transformResult?.map as { mappings?: string } | null | undefined;
    if (!map?.mappings) return null;
    let decoded = mapCache.get(map);
    if (!decoded) { decoded = decodeMappings(map.mappings); mapCache.set(map, decoded); }
    const segs = decoded[line - 1];
    if (!segs?.length) return null;
    let best = segs[0];
    for (const s of segs) { if (s[0] <= col - 1) best = s; else break; }
    return { line: best[1] + 1, col: best[2] + 1 };
  }

  // source paths leave the tool project-relative, never absolute
  function relativizeSrc(v: unknown, server: ViteDevServer): unknown {
    if (Array.isArray(v)) return v.map((x) => relativizeSrc(x, server));
    if (v && typeof v === "object") {
      const o = { ...(v as Record<string, unknown>) };
      if (typeof o.src === "string") {
        const m = o.src.match(/^(.*?)(?::(\d+))?(?::(\d+))?$/)!;
        if (isAbsolute(m[1])) {
          // React <=18 _debugSource: absolute fs path, already authored lines
          const rel = relative(root, m[1]);
          if (rel.startsWith("..")) delete o.src;
          else o.src = rel.replace(/\\/g, "/") + (m[2] ? ":" + m[2] + (m[3] ? ":" + m[3] : "") : "");
        } else if (m[2]) {
          // React 19 stack path: root-relative URL, compiled lines -> remap via module graph
          const r = remap("/" + m[1], Number(m[2]), Number(m[3] ?? 1), server);
          if (r) o.src = m[1] + ":" + r.line + ":" + r.col;
        }
      }
      for (const k of Object.keys(o)) o[k] = relativizeSrc(o[k], server);
      return o;
    }
    return v;
  }

  return {
    name: "insider",
    apply: "serve",

    configureServer(server: ViteDevServer) {
      root = server.config.root;
      const noteStore = new NoteStore(join(root, ".insider", "annotations.json"));

      server.httpServer?.once("listening", () => {
        const addr = server.httpServer?.address();
        const port = typeof addr === "object" && addr ? addr.port : "?";
        setTimeout(() => server.config.logger.info(`  insider: http://localhost:${port}${BASE} (CLI: insider http://localhost:${port} …)`), 50);
      });

      server.middlewares.use(BASE, (req, res) => void route(req, res).catch((e) => {
        send(res, 500, { error: "insider middleware failed: " + String(e), hint: "check the dev server log" });
      }));

      async function route(req: IncomingMessage, res: ServerResponse) {
        const url = new URL(req.url ?? "/", "http://x");
        const path = url.pathname;

        if (path === "/client.js") {
          res.setHeader("content-type", "text/javascript");
          const here = dirname(fileURLToPath(import.meta.url));
          res.end(
            readFileSync(join(here, "client.js"), "utf8").replace(/from "\.\/shared\.js"/g, `from "${BASE}/shared.js"`),
          );
          return;
        }
        if (path === "/shared.js") {
          res.setHeader("content-type", "text/javascript");
          const here = dirname(fileURLToPath(import.meta.url));
          res.end(readFileSync(join(here, "shared.js"), "utf8"));
          return;
        }

        if (path === "/poll" && req.method === "POST") {
          const info = (await body(req)) as Page;
          pages.set(info.id, { ...info, lastSeen: Date.now() });
          const q = queues.get(info.id);
          if (q?.length) return void res.end(JSON.stringify(q.shift()));
          parked.get(info.id)?.end("{}"); // replace an older parked poll
          parked.set(info.id, res);
          setTimeout(() => {
            if (parked.get(info.id) === res) { parked.delete(info.id); res.end("{}"); }
          }, 25_000);
          return;
        }

        if (path === "/res" && req.method === "POST") {
          const { id, page, data } = (await body(req)) as any;
          const p = pages.get(page);
          if (p) p.lastSeen = Date.now();
          const wait = pending.get(id);
          if (wait) { pending.delete(id); clearTimeout(wait.timer); wait.resolve(data); }
          res.end("{}");
          return;
        }

        if (path === "/note" && req.method === "POST") {
          const b = (await body(req)) as { id?: string; text: string; page?: string; elements?: NoteAnchor[] };
          const note = b.id
            ? noteStore.update(b.id, b.text)
            : noteStore.create(b.text, (relativizeSrc(b.elements ?? [], server) as NoteAnchor[]), b.page ?? "/");
          send(res, 200, note ?? { error: "unknown note: " + b.id, hint: "insider <url> notes" });
          return;
        }
        if (path === "/notes") {
          const page = url.searchParams.get("page") ?? undefined;
          const snapId = url.searchParams.get("snap");
          if (snapId) {
            const snap = snaps.get(snapId) ?? [...snaps.values()].filter((s) => s.tag === snapId).sort((a, b) => b.takenAt - a.takenAt)[0];
            if (!snap) return send(res, 200, { error: "unknown snapshot: " + snapId, hint: "insider <url> snap ls" });
            return send(res, 200, { notes: snap.notes ?? [], snap: snap.id, ageMs: Date.now() - snap.takenAt });
          }
          const all = noteStore.list(page);
          if (url.searchParams.has("full")) return send(res, 200, { notes: all }); // client re-anchoring needs raw anchors
          const id = url.searchParams.get("id");
          if (id) {
            const n = all.find((x) => x.id === id);
            if (!n) return send(res, 200, { error: "unknown note: " + id, hint: "insider <url> notes", exists: all.map((x) => x.id) });
            const src = n.elements[0]?.src;
            return send(res, 200, { ...n, next: src ? `insider <url> read src:${src} --box` : "insider <url> notes" });
          }
          const open = all.filter((n) => n.state === "open");
          const shown = url.searchParams.has("all") ? all : open;
          const rows = shown.map((n) => {
            const r: Record<string, unknown> = { id: n.id, text: n.text.length > 80 ? n.text.slice(0, 80) + "…" : n.text };
            if (n.elements.length > 1) r.els = n.elements.length;
            if (n.elements[0]?.src) r.src = n.elements[0].src;
            if (n.elements[0]?.component) r.component = n.elements[0].component;
            if (url.searchParams.has("all")) r.state = n.state;
            r.ageMs = Date.now() - n.createdAt;
            return r;
          });
          send(res, 200, {
            total: all.length, open: open.length, notes: rows,
            next: open.length ? "insider <url> notes " + open[0].id
              : all.length ? "insider <url> notes clear"
              : "annotate in the browser: Alt+A, click an element, type",
          });
          return;
        }
        if (path === "/notes-done") {
          const id = url.searchParams.get("id") ?? "";
          const n = noteStore.done(id, url.searchParams.get("note") ?? undefined);
          send(res, 200, n ? { done: id } : { error: "unknown note: " + id, hint: "insider <url> notes", exists: noteStore.list().map((x) => x.id) });
          return;
        }
        if (path === "/notes-rm") {
          const id = url.searchParams.get("id") ?? "";
          send(res, 200, noteStore.rm(id) ? { removed: id } : { error: "unknown note: " + id, hint: "insider <url> notes", exists: noteStore.list().map((x) => x.id) });
          return;
        }
        if (path === "/notes-clear") {
          send(res, 200, { cleared: noteStore.clear() });
          return;
        }

        if (path === "/snap" && !url.searchParams.has("rm") && !url.searchParams.has("ls")) {
          if (snaps.size >= MAX_SNAPS)
            return send(res, 200, { error: "snapshot limit (" + MAX_SNAPS + ") reached", hint: "insider <url> snap rm <id>" });
          const page = resolvePage(url.searchParams.get("page"));
          if ("error" in page) return send(res, 200, page);
          const data = (await ask(page, "capture", {}, 15_000)) as any;
          if (data.error) return send(res, 200, data);
          const id = "s" + nextSnap++;
          const tag = url.searchParams.get("tag") ?? undefined;
          const snap: Snapshot = {
            id, tag, page: page.id, url: data.url, title: data.title, viewport: data.viewport,
            takenAt: Date.now(), root: relativizeSrc(data.root, server) as Snapshot["root"],
            notes: data.notes ?? [],
          };
          snaps.set(id, snap);
          const count = JSON.stringify(snap.root).length;
          send(res, 200, { snap: id, ...(tag ? { tag } : {}), url: snap.url, title: snap.title, bytes: count, next: "insider <url> overview --snap " + (tag ?? id) });
          return;
        }
        if (path === "/snaps") {
          send(res, 200, {
            snaps: [...snaps.values()].map((s) => ({ snap: s.id, ...(s.tag ? { tag: s.tag } : {}), url: s.url, title: s.title, ageMs: Date.now() - s.takenAt })),
            next: snaps.size ? "insider <url> read <locator> --snap <id|tag>" : "insider <url> snap",
          });
          return;
        }
        if (path === "/snap-rm") {
          const key = url.searchParams.get("id") ?? "";
          const hit = snaps.get(key) ?? [...snaps.values()].filter((s) => s.tag === key).sort((a, b) => b.takenAt - a.takenAt)[0];
          if (!hit)
            return send(res, 200, {
              error: "unknown snapshot: " + key,
              hint: "insider <url> snap ls",
              exists: [...snaps.values()].map((s) => s.id + (s.tag ? " (" + s.tag + ")" : "")),
            });
          snaps.delete(hit.id);
          send(res, 200, { removed: hit.id, ...(hit.tag ? { tag: hit.tag } : {}) });
          return;
        }

        if (path === "/status") {
          const live = livePages();
          send(res, 200, {
            pages: live.map((p) => ({ id: p.id, url: p.url, title: p.title, viewport: p.viewport, lastSeenMs: Date.now() - p.lastSeen })),
            ...(live.length ? { active: live[0].id } : {}),
            next: live.length ? "insider <url> overview" : "open the app in a browser, then: insider <url>",
          });
          return;
        }

        if (path === "/overview" || path === "/read" || path === "/find") {
          const snapId = url.searchParams.get("snap");
          if (snapId) {
            // id first, then tag (newest match wins)
            const snap = snaps.get(snapId) ??
              [...snaps.values()].filter((s) => s.tag === snapId).sort((a, b) => b.takenAt - a.takenAt)[0];
            if (!snap)
              return send(res, 200, {
                error: "unknown snapshot: " + snapId,
                hint: "insider <url> snap ls",
                exists: [...snaps.values()].map((s) => s.id + (s.tag ? " (" + s.tag + ")" : "")),
              });
            if (url.searchParams.has("wait"))
              return send(res, 200, { error: "--wait is meaningless on a snapshot", hint: "drop --wait or query the live page" });
            let out: Record<string, unknown>;
            if (path === "/overview") out = snapOverview(snap) as Record<string, unknown>;
            else if (path === "/read") {
              const locators = url.searchParams.getAll("l").map(parseLocator);
              if (!locators.length || locators.some((l) => !l))
                return send(res, 200, { error: "read needs valid locators", hint: "forms: role:x | text:x | ref:eN | point:x,y | src:path:line" });
              const opts: Record<string, unknown> = {};
              for (const f of ["hidden", "box", "classes", "props", "a11y", "context"])
                if (url.searchParams.has(f)) opts[f] = true;
              if (url.searchParams.has("depth")) opts.depth = Number(url.searchParams.get("depth"));
              if (url.searchParams.has("styles")) opts.styles = url.searchParams.get("styles")!.split(",").map((s) => s.trim()).filter(Boolean);
              out = snapRead(snap, locators as any, opts) as Record<string, unknown>;
            } else {
              const q = url.searchParams.get("q");
              if (!q) return send(res, 200, { error: "find needs a query", hint: "insider <url> find component:Card --snap " + snapId });
              out = snapFind(snap, JSON.parse(q), Number(url.searchParams.get("limit") ?? 10)) as Record<string, unknown>;
            }
            out.snap = snap.id;
            if (snap.tag) out.tag = snap.tag;
            out.ageMs = Date.now() - snap.takenAt; // staleness is always explicit
            send(res, 200, out);
            return;
          }
          const page = resolvePage(url.searchParams.get("page"));
          if ("error" in page) return send(res, 200, page);

          let op = path.slice(1);
          let params: unknown = {};
          let timeout = 5000;

          if (op === "read") {
            const locators = url.searchParams.getAll("l");
            if (!locators.length) return send(res, 200, { error: "read needs at least one locator", hint: "insider <url> read text:\"Add to cart\"" });
            const opts: Record<string, unknown> = {};
            for (const f of ["hidden", "box", "classes", "props", "a11y", "context"])
              if (url.searchParams.has(f)) opts[f] = true;
            if (url.searchParams.has("depth")) opts.depth = Number(url.searchParams.get("depth"));
            if (url.searchParams.has("styles")) opts.styles = url.searchParams.get("styles")!.split(",").map((s) => s.trim()).filter(Boolean);
            const wait = url.searchParams.get("wait");
            if (wait) {
              const w = JSON.parse(wait);
              opts.wait = w;
              timeout = w.budgetMs + 3000; // internal limit always exceeds the caller's wait budget
            }
            params = { locators, opts };
          } else if (op === "find") {
            const q = url.searchParams.get("q");
            if (!q) return send(res, 200, { error: "find needs a query", hint: "insider <url> find component:Card" });
            params = { query: JSON.parse(q), limit: Number(url.searchParams.get("limit") ?? 10) };
          }

          const data = (await ask(page, op, params, timeout)) as Record<string, unknown>;
          const out = relativizeSrc(data, server) as Record<string, unknown>;
          if (!out.error && !out.next) out.next = nextHint(op);
          send(res, 200, out);
          return;
        }

        send(res, 404, { error: "unknown endpoint: " + path, hint: "endpoints: /status /overview /read /find" });
      }
    },

    transformIndexHtml() {
      return [{ tag: "script", attrs: { type: "module", src: BASE + "/client.js" }, injectTo: "head" }];
    },
  };
}

function nextHint(op: string): string {
  if (op === "overview") return "insider <url> read ref:<ref> --styles display,gap,padding";
  if (op === "find") return "insider <url> read ref:<ref> --depth 0 --box";
  return "insider <url> read ref:<ref> --styles <props> | insider <url> find <query>";
}

function send(res: ServerResponse, code: number, data: unknown) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(data));
}

function body(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => {
      try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}
