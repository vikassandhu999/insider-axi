# insider-axi

UI inspector for coding agents. A Vite plugin + CLI that gives an agent the
ground truth of a rendered UI — resolved styles, exact geometry, component and
source mapping — as compact JSON, cheap enough to call inside an edit loop.

No screenshots, no guessing. The agent reads what the rendering engine actually
decided, and every element points back to the component and source line that
produced it.

```
insider http://localhost:5173 read src:Card.tsx:7 --styles padding,gap --box
```

```json
{"regions":[{"root":{"ref":"e6","kind":"div","component":"Card","src":"src/Card.tsx:7:5",
"box":{"x":240,"y":136,"w":720,"h":52},"styles":{"padding-top":"16px","gap":"12px"}},
"size":{"w":720,"h":52},"ready":true}]}
```

## Why

* **Exact values.** Sub-pixel spacing, computed colors, resolved typography —
  values a screenshot cannot carry and authored source hides behind tokens and
  themes.
* **Pixels to code in one hop.** Every element names the React component that
  rendered it and the source file and line, so a visual finding is directly
  actionable as an edit.
* **Port UI between codebases.** Read a region from one app (a Lovable/v0/Bolt
  prototype, a different design system) and reproduce it exactly in another —
  only the rendered truth crosses over, not the prototype's code.
* **Verify edits.** Read, edit, re-read: assert the gap is now 12, don't eyeball it.

## Install

```bash
npm i -D insider-axi
```

```js
// vite.config.js
import insider from "insider-axi";

export default {
  plugins: [insider() /* , react(), ... */],
};
```

Dev only: `apply: "serve"` means production builds contain no trace of it.
Zero runtime dependencies. Read-only — it never clicks, types, or mutates the page.

## Use

Start the dev server, open the app in any browser, then:

```bash
insider http://localhost:5173                    # status: connected pages
insider http://localhost:5173 overview           # regions, landmarks, components
insider http://localhost:5173 read <locator...>  # subtree per locator (the main op)
insider http://localhost:5173 find <query>       # search elements
insider http://localhost:5173 snap [--tag name]  # freeze the whole page; query with --snap
```

Locators: `role:button` · `text:"Add to cart"` · `ref:e42` · `point:120,340` ·
`src:Cart.tsx:42` · bare string = text.

Read flags: `--styles padding,gap` / `--styles "font*"` / `--styles all`,
`--depth n`, `--box`, `--classes`, `--props` (component inputs, secrets redacted),
`--a11y`, `--context`, `--hidden`, `--wait "text[:ms]"`, `--page p`, `--snap <id|tag>`.

Output is compact JSON, pipe-friendly via `jq`. Every answer carries a `next`
hint; every error is `{error, hint}` with a clean exit code. Snapshots make
before/after comparison trivial and their refs never go stale.

Works with React 18 and 19 (component + source mapping); on any other setup the
mapping is simply absent — never guessed — and everything else still works.

## For agents

The package ships an agent skill at `skill/SKILL.md` — when to reach for the
CLI, command shapes, and how to read answers. Point your agent harness at it.

## License

MIT
