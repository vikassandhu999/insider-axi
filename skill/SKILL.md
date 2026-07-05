---
name: insider
description: Read the ground truth of a rendered UI (resolved styles, geometry, component + source mapping) as compact JSON via the insider CLI. Use when styling, debugging layout, porting UI between codebases, or verifying a UI change in a Vite app running in dev — instead of guessing values from screenshots or source.
user-invocable: true
---

# insider

Agent ergonomic interface for reading a rendered UI. Read-only: it never clicks,
types, or mutates the page. Dev only. The first parameter is always the dev
server URL. Requires the `insider()` plugin in the app's vite config.

## When to use

Use insider whenever a task needs exact rendered values — spacing, sizes, colors,
typography — or a mapping from something visible to the component and source line
behind it, or a before/after verification of a UI edit.

Skip it when the source alone answers the question, or when you need to *drive*
the page (clicking, typing) — driving belongs to a browser tool or the user.

## Workflow

1. Resolve the base URL: user gave one → use it; app is in this project → read the
   dev-server log ("Local: http://localhost:NNNN"), else `server.port` in
   vite.config, else `--port` in the dev script, else try 5173; otherwise ask.
   Verify with `insider <url>` — it must answer JSON.
2. If status shows 0 pages: open the page yourself (`open <url>` / `xdg-open <url>`);
   if that fails, ask the user to open it in their browser.
3. If the page needs interaction to reach a state (login, modal): a route URL →
   open it directly; else ask the user to click through; else, with the user's
   explicit approval, drive it with an available browser tool. Never guess facts
   about a state you couldn't reach.
4. Once the page is right, `snap --tag <state>` to freeze it, then query with
   `--snap <tag>` — snapshot refs never go stale.
5. `overview` gives entry-point refs; `read` is the main op. Pass any `ref` or
   `src` from an answer straight back as a target.
6. After editing code, re-read the same locator live to verify the change landed.
   Refs die on reload — re-locate by `src:`/`find`, or query the snapshot.

## Commands

```
commands[7]:
  <url>                                      status: connected pages, active page
  <url> overview [--page p] [--snap s]       regions, landmarks, components
  <url> read <locator...> [flags]            subtree per locator (the main op)
  <url> find <query> [--limit n] [--snap s]  search elements
  <url> snap [--tag name]                    capture whole live page as a snapshot
  <url> snap ls                              list snapshots (id, tag, url, age)
  <url> snap rm <id|tag>                     delete a snapshot

locators:  role:button | text:"Add to cart" | ref:e42 | point:120,340 |
           src:Cart.tsx:42 | bare string = text
queries:   bare string = visible text | component:Name | src:path[:line][#Component]
read flags: --styles margin,padding | --styles "font*" | --styles all | --depth n |
           --box | --classes | --props | --a11y | --context | --hidden |
           --wait "text[:ms]" | --page p | --snap <id|tag>
```

Every subcommand supports `--help`.

## Tips

* Output is compact JSON: absent key = fact absent or not asked for, never null.
  Pipe through `jq` to filter: `... read role:main --styles gap | jq '.regions[0].root.styles'`.
* Child styles show only diffs from the parent (root states the baseline);
  `collapsed: n` = n structural wrappers omitted; `vis: false` = hidden element.
* Prefer named style lists or patterns (`"font*,border*"`) over `--styles all` —
  all is ~5KB per element.
* Snapshot answers carry `snap` + `ageMs`: facts from capture time, not now.
  Re-read live before acting if the page has changed since.
* Source paths are reliable on React 18 and 19; line numbers can drift a few
  lines on React 19 setups without sourcemaps.
* Errors are `{error, hint}` with exit code 1 — the hint is the next command to run.
  Every success answer has a `next` field suggesting a follow-up.
