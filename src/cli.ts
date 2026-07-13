#!/usr/bin/env node
// insider <dev-server-url> [subcommand] [args] — AXI CLI over the plugin's endpoints.
// Exit codes: 0 success, 1 error, 2 unknown flag. Compact JSON out. No prompts.

import { parseQuery, parseWait } from "./shared.js";

type FlagSpec = Record<string, "value" | "bool">;

const COMMANDS: Record<string, { flags: FlagSpec; help: string }> = {
  status: { flags: {}, help: "insider <url>\n  Live status: connected pages, active page." },
  overview: {
    flags: { page: "value", snap: "value" },
    help: "insider <url> overview [--page <id|fragment>] [--snap <id>]\n  Major regions, landmarks, components — entry points for read.",
  },
  snap: {
    flags: { page: "value", tag: "value" },
    help: [
      "insider <url> snap [--tag name] [--page p]   capture the whole live page as a snapshot",
      "insider <url> snap ls                        list snapshots (id, tag, url, age)",
      "insider <url> snap rm <id|tag>               delete a snapshot",
      "  Query any snapshot with --snap <id|tag> on overview/read/find (tag -> newest match).",
      "  Snapshot refs never go stale; answers carry snap + ageMs. Snapshots live for the dev-server session.",
    ].join("\n"),
  },
  notes: {
    flags: { page: "value", snap: "value", note: "value", all: "bool" },
    help: [
      "insider <url> notes [--all] [--page p] [--snap s]   list open annotations (--all includes done)",
      "insider <url> notes <id>                            one note, full detail (all elements + anchors)",
      "insider <url> notes done <id> [--note \"how it was resolved\"]",
      "insider <url> notes rm <id> | notes clear",
      "  Users annotate in the browser (Alt+A, click element, type). Each note carries the",
      "  element's component, source line, and box. Annotated elements show note: in read/find.",
    ].join("\n"),
  },
  read: {
    flags: {
      styles: "value", depth: "value", wait: "value", page: "value", snap: "value",
      hidden: "bool", box: "bool", classes: "bool", props: "bool", a11y: "bool", context: "bool",
    },
    help: [
      "insider <url> read <locator...> [--styles s1,s2] [--depth n] [--hidden] [--box]",
      "       [--classes] [--props] [--a11y] [--context] [--wait \"text[:ms]\"] [--page p]",
      "  Locators: role:button | text:\"Add to cart\" | ref:e42 | point:120,340 | src:Cart.tsx:42",
      "  A bare string is treated as text. One region per locator.",
      "  --styles all = every computed style; patterns ok: --styles \"font*,margin*\" (no-effect values and parent duplicates always omitted)",
    ].join("\n"),
  },
  find: {
    flags: { limit: "value", page: "value", snap: "value" },
    help: [
      "insider <url> find <query> [--limit n] [--page p]",
      "  Query: bare string = visible text | component:Name | src:path[:line][#Component]",
    ].join("\n"),
  },
};

function fail(msg: string, hint: string, code: 1 | 2): never {
  process.stdout.write(JSON.stringify({ error: msg, hint }) + "\n");
  process.exit(code);
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(Object.values(COMMANDS).map((c) => c.help).join("\n\n") + "\n");
    return;
  }

  const url = argv[0].replace(/\/$/, "");
  if (!/^https?:\/\//.test(url)) fail("first parameter must be the dev server URL", "insider http://localhost:5173 [subcommand]", 1);

  const cmd = argv[1] ?? "status";
  const spec = COMMANDS[cmd];
  if (!spec) fail("unknown subcommand: " + cmd, "subcommands: status (default), overview, read, find", 1);

  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(spec.help + "\n");
    return;
  }

  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const kind = spec.flags[name];
      if (!kind) fail("unknown flag: --" + name, "valid flags for " + cmd + ": " + (Object.keys(spec.flags).map((f) => "--" + f).join(" ") || "(none)"), 2);
      if (kind === "value") {
        const v = argv[++i];
        if (v === undefined) fail("--" + name + " needs a value", spec.help, 1);
        flags[name] = v;
      } else flags[name] = true;
    } else positional.push(a);
  }

  const params = new URLSearchParams();
  let endpoint = cmd;

  if (cmd === "status") endpoint = "status";
  if (flags.page) params.set("page", String(flags.page));
  if (flags.snap) params.set("snap", String(flags.snap));

  if (cmd === "notes") {
    if (positional[0] === "done") {
      if (!positional[1]) fail("notes done needs an id", "insider <url> notes done n1", 1);
      endpoint = "notes-done";
      params.set("id", positional[1]);
      if (flags.note) params.set("note", String(flags.note));
    } else if (positional[0] === "rm") {
      if (!positional[1]) fail("notes rm needs an id", "insider <url> notes rm n1", 1);
      endpoint = "notes-rm";
      params.set("id", positional[1]);
    } else if (positional[0] === "clear") {
      endpoint = "notes-clear";
    } else if (positional[0]) {
      params.set("id", positional[0]); // notes <id> = detail
    }
    if (flags.all) params.set("all", "1");
  }

  if (cmd === "snap") {
    if (flags.tag) params.set("tag", String(flags.tag));
    if (positional[0] === "ls") endpoint = "snaps";
    else if (positional[0] === "rm") {
      if (!positional[1]) fail("snap rm needs an id", "insider <url> snap rm s1", 1);
      endpoint = "snap-rm";
      params.set("id", positional[1]);
    } else if (positional.length) {
      fail("unknown snap action: " + positional[0], "actions: (none) = capture, ls, rm <id>", 1);
    }
  }

  if (cmd === "read") {
    if (!positional.length) fail("read needs at least one locator", spec.help, 1);
    for (const l of positional) params.append("l", l);
    for (const b of ["hidden", "box", "classes", "props", "a11y", "context"]) if (flags[b]) params.set(b, "1");
    if (flags.styles) params.set("styles", String(flags.styles));
    if (flags.depth) {
      if (Number.isNaN(Number(flags.depth))) fail("--depth needs a number", spec.help, 1);
      params.set("depth", String(flags.depth));
    }
    if (flags.wait) {
      const w = parseWait(String(flags.wait));
      if (!w) fail("bad --wait value", '--wait "text[:budgetMs]"', 1);
      params.set("wait", JSON.stringify(w));
    }
  }

  if (cmd === "find") {
    if (positional.length !== 1) fail("find needs exactly one query", spec.help, 1);
    const q = parseQuery(positional[0]);
    if (!q) fail("bad query: " + positional[0], spec.help, 1);
    params.set("q", JSON.stringify(q));
    if (flags.limit) params.set("limit", String(flags.limit));
  }

  const target = url + "/__insider/" + endpoint + (params.size ? "?" + params : "");
  let res: Response;
  try {
    res = await fetch(target);
  } catch {
    fail("dev server not reachable: " + url, "is `vite` running with the insider plugin? start it, open the app, retry", 1);
  }
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    fail("dev server answered but not with insider JSON", "is the insider plugin in vite.config? add it and restart", 1);
  }
  process.stdout.write(JSON.stringify(data) + "\n");
  const allMissed = Array.isArray(data?.regions) && data.regions.length > 0 && data.regions.every((r: any) => r.error);
  process.exit(data && (data.error || allMissed) ? 1 : 0);
}

main();
