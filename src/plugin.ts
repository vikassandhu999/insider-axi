// Vite plugin: serves the inspector alongside the dev server. Dev only —
// `apply: "serve"` means a production build contains no trace of it.

import { readFileSync } from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, ViteDevServer } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";

const BASE = "/__insider";
const STALE_MS = 15_000;

type Page = { id: string; url: string; title: string; viewport: unknown; lastSeen: number };
type Pending = { resolve: (v: unknown) => void; timer: NodeJS.Timeout };

export default function insider(): Plugin {
  const pages = new Map<string, Page>();
  const queues = new Map<string, { id: string; op: string; params: unknown }[]>();
  const parked = new Map<string, ServerResponse>(); // one held poll per page
  const pending = new Map<string, Pending>();
  let nextReq = 1;
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

  // source paths leave the tool project-relative, never absolute
  function relativizeSrc(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(relativizeSrc);
    if (v && typeof v === "object") {
      const o = { ...(v as Record<string, unknown>) };
      if (typeof o.src === "string") {
        const m = o.src.match(/^(.*?)((?::\d+){0,2})$/)!;
        if (isAbsolute(m[1])) {
          const rel = relative(root, m[1]);
          if (rel.startsWith("..")) delete o.src;
          else o.src = rel.replace(/\\/g, "/") + m[2];
        }
      }
      for (const k of Object.keys(o)) o[k] = relativizeSrc(o[k]);
      return o;
    }
    return v;
  }

  return {
    name: "insider",
    apply: "serve",

    configureServer(server: ViteDevServer) {
      root = server.config.root;

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
          const out = relativizeSrc(data) as Record<string, unknown>;
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
