// Pure logic shared by CLI, plugin, and browser client. No DOM, no node APIs.

export type Locator =
  | { role: string }
  | { text: string }
  | { ref: string }
  | { point: [number, number] }
  | { src: string };

export type Query = { text?: string; component?: string; src?: string };

// "role:button" | "text:Add to cart" | "ref:e42" | "point:120,340" | "src:Cart.tsx:42" | bare = text
export function parseLocator(raw: string): Locator | null {
  const m = raw.match(/^(role|text|ref|point|src):([\s\S]+)$/);
  if (!m) return raw.trim() ? { text: raw.trim() } : null;
  const [, kind, rest] = m;
  if (kind === "point") {
    const p = rest.split(",").map((n) => Number(n.trim()));
    if (p.length !== 2 || p.some(Number.isNaN)) return null;
    return { point: [p[0], p[1]] };
  }
  const v = rest.trim().replace(/^"(.*)"$/, "$1");
  if (!v) return null;
  return { [kind]: v } as Locator;
}

export function parseQuery(raw: string): Query | null {
  const m = raw.match(/^(component|src):([\s\S]+)$/);
  if (m) return { [m[1]]: m[2].trim() } as Query;
  return raw.trim() ? { text: raw.trim() } : null;
}

// Canonical: "path:line[:col]". Shorthand: "path", "path:line", "path#Component".
export type SourceRef = { path: string; line?: number; col?: number; component?: string };

export function parseSourceRef(raw: string): SourceRef | null {
  let rest = raw.trim();
  if (!rest) return null;
  let component: string | undefined;
  const hash = rest.indexOf("#");
  if (hash >= 0) {
    component = rest.slice(hash + 1) || undefined;
    rest = rest.slice(0, hash);
  }
  const m = rest.match(/^(.*?)(?::(\d+))?(?::(\d+))?$/);
  if (!m || !m[1]) return null;
  const line = m[2] ? Number(m[2]) : undefined;
  // line wins over #Component — a line already pinpoints
  if (line !== undefined) component = undefined;
  return { path: m[1], line, col: m[3] ? Number(m[3]) : undefined, component };
}

// Suffix-based, case-insensitive path match.
export function pathMatches(refPath: string, filePath: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
  const a = norm(filePath);
  const b = norm(refPath);
  return a === b || a.endsWith("/" + b) || a.endsWith(b) && a.charAt(a.length - b.length - 1) === "/";
}

export function sourceRefMatches(
  ref: SourceRef,
  el: { path: string; line?: number; component?: string },
): boolean {
  if (!pathMatches(ref.path, el.path)) return false;
  if (ref.line !== undefined) return el.line === ref.line;
  if (ref.component !== undefined) return el.component === ref.component;
  return true;
}

export function formatSourceRef(path: string, line?: number, col?: number): string {
  return path + (line !== undefined ? ":" + line + (col !== undefined ? ":" + col : "") : "");
}

const SECRET = /secret|token|password|passwd|apikey|api_key|auth|credential|private/i;

// Bound component inputs: depth, key count, string length; redact secret-like names.
export function boundValue(v: unknown, depth = 2, key = ""): unknown {
  if (SECRET.test(key)) return "[redacted]";
  if (v === null || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") return v.length > 80 ? v.slice(0, 80) + "…(" + v.length + ")" : v;
  if (typeof v === "function") return "[fn]";
  if (Array.isArray(v)) {
    if (depth <= 0) return "[array:" + v.length + "]";
    return v.slice(0, 10).map((x) => boundValue(x, depth - 1));
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (o.$$typeof) return "[element]";
    if (depth <= 0) return "[object]";
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).slice(0, 20)) out[k] = boundValue(o[k], depth - 1, k);
    return out;
  }
  return String(v);
}

// "text[:budgetMs]" — last colon segment numeric = budget
export function parseWait(raw: string): { text: string; budgetMs: number } | null {
  const m = raw.match(/^([\s\S]+?)(?::(\d+))?$/);
  if (!m || !m[1].trim()) return null;
  return { text: m[1].trim(), budgetMs: m[2] ? Number(m[2]) : 2000 };
}
