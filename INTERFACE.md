# Insider — interface design

No implementation here. This is the interface: everything a caller must know. Three seams:

```
CLI (adapter: argv parsing, TOON rendering, exit codes, next-step hints)
        │
   Inspector (the deep module — one interface, all behaviour behind it)
        │
   PageChannel (internal seam: real websocket to pages ↔ fake for tests)
```

## External seam — CLI grammar

```
insider <dev-server-url>                          # no subcommand → status (content-first)
insider <url> overview   [--page <id|fragment>]
insider <url> read       <locator...> [--styles s1,s2] [--depth n] [--hidden] [--box] [--classes] [--props] [--a11y] [--context] [--wait "text[:ms]"] [--page p]
insider <url> find       <query> [--limit n] [--page p]
insider <url> snap [--tag name]                   # capture whole live page -> snapshot id
insider <url> snap ls                             # list snapshots (id, tag, url, age)
insider <url> snap rm <id|tag>                    # delete a snapshot
```

`overview`, `read`, and `find` accept `--snap <id|tag>` (tag -> newest match; answers
always report the resolved id) to run against a snapshot instead of
the live page. A capture stores everything (hidden elements, boxes, all non-default
styles, components, src, props, a11y) so any later query is answerable; snapshot refs
never go stale; every snapshot answer carries `snap` + `ageMs`; `--wait` with `--snap`
is an error. Snapshots live in dev-server memory, capped at 20.

Five subcommands. `read` is the single describing operation: a subtree per locator, extras opt-in per flag, surroundings (ancestors, siblings, stacking) via `--context`. `find` disambiguates by query prefix alone — no mode flag.

Locator forms (forgiving): `role:button`, `text:"Add to cart"`, `ref:e42`, `point:120,340`, `src:Cart.tsx:42`. A bare string is treated as text. Query forms for `find`: bare string = visible text, `component:Name`, `src:<source-ref>`.

## Source references

Canonical form, emitted on every element and accepted back verbatim as a locator or query:

```
<project-relative-path>:<line>[:<column>]        e.g.  src/components/Cart.tsx:42:7
```

Accepted shorthand (forgiving input):

* `Cart.tsx` — basename match; any element rendered from that file
* `components/Cart.tsx` — path-suffix match
* `Cart.tsx:42` — file + line
* `Cart.tsx#CartItem` — file narrowed to a component defined in it

Resolution rules: matching is suffix-based and case-insensitive on the path; a ref without a line matches every element the file produced. When both a line and `#Component` are given, the line wins and the component part is ignored — a line already pinpoints. Ambiguous file match (two files share the suffix) is a `Fail` listing the candidate paths — never a silent pick. Line numbers refer to the source on disk as the dev server last compiled it; after an edit, refs from before the edit may miss, which answers "not there", not a guess.

Exit codes: 0 success, 1 error (structured, with hint), 2 unknown flag (valid flags listed). Never an interactive prompt. Output is compact JSON — short keys, absent facts omitted (never null) — pipe-friendly via jq, with a `next` field carrying a concrete next-step command suggestion.

## Core interface — Inspector

```ts
// One deep module. All functions are pure reads: input → result value. No side effects on the page.

interface Inspector {
  status(): Status
  overview(target?: PageTarget): Overview
  read(locators: Locator[], opts?: ReadOpts, target?: PageTarget): Region[]   // one Region per locator, one call
  find(query: Query, opts?: FindOpts, target?: PageTarget): Matches
}

type PageTarget = string                    // page id or URL/title fragment; omitted = most recently active page
type Ref = string                           // stable id; any ref Inspector hands out is accepted back as a target

type Locator =
  | { role: string }
  | { text: string }
  | { ref: Ref }
  | { point: [number, number] }
  | { src: SourceRef }

type SourceRef = string                     // "path:line[:col]" | "path" | "path#Component" — see Source references

type ReadOpts = {
  styles?: string[]                         // resolved styles to include; "*" patterns expand ("font*"); ["all"] = every computed style (no-effect and parent-duplicate values still omitted); omitted = none
  depth?: number                            // subtree depth limit; 0 = the located element alone
  hidden?: boolean                          // include non-visible elements
  box?: boolean                             // include position/size per element (always on region roots)
  classes?: boolean                         // include authored class names
  props?: boolean                           // include component inputs
  a11y?: boolean                            // include accessibility facts
  context?: boolean                         // include surroundings: ancestors, siblings, stacking order
  wait?: { text: string; budgetMs?: number } // readiness condition; internal limits always exceed budgetMs
}

type Query    = { text?: string; component?: string; src?: SourceRef }
type FindOpts = { limit?: number }
```

## Results

One element shape everywhere. Fields are present only when the caller asked or the operation implies them — the type is the union of what any operation can say about an element, not what every response carries.

```ts
type Element = {
  ref: Ref
  kind: string                       // element type: "button", "div", ...
  text?: string                      // own text only, never descendants'
  component?: string                 // real name or absent — never synthetic, never guessed
  src?: SourceRef                    // canonical form or absent
  box?: Box                          // when geometry requested; always on a region root
  styles?: Record<string, string>    // only the styles the caller asked for (spacing is styles: margin, padding, gap)
  classes?: string[]                 // opt-in: authored class names
  props?: Record<string, unknown>    // opt-in: component inputs; bounded size/depth, secret-like names redacted
  a11y?: A11y                        // opt-in
  children?: Element[]               // only inside a Region subtree
  collapsed?: number                 // structural wrappers omitted beneath this node, as a count
}

type Box  = { x: number; y: number; w: number; h: number }
type Size = { w: number; h: number }
type A11y = { role?: string; name?: string; states?: string[] }

type Status      = { pages: PageInfo[]; active?: string }
type PageInfo    = { id: string; url: string; title: string; viewport: Size; lastSeenMs: number }

type Overview    = { regions: Element[]; landmarks: Element[]; components: Element[] }   // component roots, with component + src set

type Region      = {
  root: Element                             // full subtree via children
  size: Size                                // rendered size of the region root
  constraint?: WidthConstraint              // present when an ancestor constrains width
  ready: boolean                            // whether the wait condition was met
  context?: { ancestors: Element[]; siblings: Element[]; stack: Element[] }   // when context requested
}
type WidthConstraint = { width: number; imposedBy: string /* component */; ref: Ref }

type Matches     = { total: number; shown: number; items: Element[] }   // pre-computed aggregate: total
```

Elements outside a `Region.root` subtree carry no `children`. "Inspect one element" is `read ref:e42 --depth 0` plus whichever extras; "inspect many" is many locators in the same call.

## Errors

Errors are values, never throws across the seam:

```ts
type Fail = {
  error: string                             // what went wrong, distinct answers: "not rendered yet" | "wrong page" | "not there" | ...
  hint: string                              // what to do next, as a concrete command
  exists?: string[]                         // when the target is unknown: what does exist
}
```

CLI maps `Fail` → exit 1. Unknown flags never reach Inspector: CLI rejects with exit 2 and the valid flags.

## Depth argument

* Interface: 4 functions, one option bag, one element shape. Implementation hides: page discovery, transport, readiness waiting, component-tree mapping, style resolution, facts-once dedup, wrapper collapsing, redaction.
* Test surface = caller surface: Inspector tested against a fake PageChannel. Two adapters at that seam (real websocket, fake) → a real seam.
* CLI passes the deletion test as an adapter: delete it and all complexity remains in Inspector.

## Open questions

* `wait` is scoped to `read` only (spec says "every read accepts a readiness condition"). Extend to `find`/`overview` if agents hit races there?
