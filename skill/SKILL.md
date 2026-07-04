---
name: insider
description: Read the ground truth of a rendered UI (resolved styles, geometry, component + source mapping) as compact JSON via the insider CLI. Use when styling, debugging layout, or verifying a UI change in a Vite app running in dev — instead of guessing values from screenshots or source.
---

# Insider — UI inspection for agents

Read-only. Never clicks, types, or mutates the page. Dev only. The first
parameter is always the dev server URL.

## When to use

* You need exact rendered values: spacing, sizes, colors, typography.
* You need to map something visible to the component and source file behind it.
* You need to verify a UI edit landed (read before, edit, read after, compare).

## Commands

```
insider http://localhost:5173                    # status: connected pages
insider <url> overview [--page p]                # regions, landmarks, components
insider <url> read <locator...> [flags]          # subtree per locator (the main op)
insider <url> find <query> [--limit n]           # search elements
```

Locators: `role:button` | `text:"Add to cart"` | `ref:e42` | `point:120,340` |
`src:Cart.tsx:42` | bare string = text.
Find queries: bare string = visible text | `component:Name` | `src:path[:line][#Component]`.

Read flags: `--styles margin,padding,gap` (only these are returned; `*` patterns
work: `--styles "font*,border*"`; `--styles all` = every computed style when you
don't know what to ask for — prefer named lists or patterns once you do, all is
expensive),
`--depth n` (0 = the element alone), `--box` (geometry), `--classes`,
`--props` (component inputs), `--a11y`, `--context` (ancestors/siblings/stack),
`--hidden`, `--wait "text[:ms]"` (readiness), `--page p`.

## Snapshots

```
insider <url> snap --tag before-fix       # capture whole page -> {"snap":"s1","tag":"before-fix",...}
insider <url> snap ls | snap rm before-fix
insider <url> read ref:e6 --styles padding --snap before-fix   # query the frozen state (id or tag)
```

Use a snapshot when you need a stable "before" (capture, edit code, compare
against a fresh live read) or when refs must survive reloads. Snapshot answers
carry `snap` + `ageMs` — the facts are from capture time, not now. Never act on
an old snapshot when the live page has since changed; re-read live to verify.

## Workflow

1. `insider <url>` — confirm a page is connected.
2. `insider <url> overview` — get entry-point refs.
3. `insider <url> read ref:e7 --styles display,gap,padding --box` — exact facts.
4. Any `ref` or `src` in an answer can be passed straight back as a target.
5. After editing code, re-run the same read to verify the change.

## Reading answers

Compact JSON; absent key = fact absent or not asked for, never null. Children
only appear on `read`. `collapsed: n` = n structural wrappers omitted. Styles on
a child are only where they differ from the parent (root states the baseline).
Every answer has a `next` field suggesting a follow-up command. Errors are
`{error, hint}` with exit code 1 — the hint says what to do next.

Pipe through `jq` to filter: `insider <url> read role:main --styles gap | jq '.regions[0].root.children[].styles'`.
