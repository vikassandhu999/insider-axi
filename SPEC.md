# Insider — UI inspector for agents

Gives a coding agent the ground truth of a rendered UI as structured text, cheap enough to call inside an edit loop. Ground truth means resolved values (what the rendering engine decided), never estimates from pixels. "Agent" means any client: AI harness, script, or human in a shell.

## Lifecycle

* Available the moment the dev server runs; no extra process, install, or app-code change.
* Absent from production builds entirely.
* A page is inspectable while open in a browser; reloads and server restarts self-heal without intervention.
* The tool announces itself on startup; invoking the CLI with only the dev-server URL (no subcommand) shows live status (connected pages), not help text.

## Protocol: AXI (https://axi.md)

* Agents interact through a CLI with subcommands, one per operation (status, overview, read, find, snap, notes).
* The dev server's URL is always the first parameter: `insider <dev-server-url> <subcommand> [flags]` — that is what the CLI connects to.
* Output is compact JSON: short keys, absent facts omitted (never null), minimal default fields per item.
* Responses include pre-computed aggregates (counts, totals) so no follow-up call is needed to summarize.
* Empty results are stated definitively ("0 pages connected"), never blank output.
* Errors are structured, on stdout, with exit codes: 0 success, 1 error, 2 unknown flag; never an interactive prompt.
* Every answer suggests concrete next-step commands; every subcommand has consistent `--help`.
* The tool ships with an agent skill: instructions teaching an agent when to reach for the CLI, the command shapes, and how to read its output — so no agent learns it by trial and error.
* Output is pipe-friendly for agent-side filtering with standard JSON tooling (jq).

## Primary operation: read a region

* Given one or more regions of the live page (found by role, visible text, element reference, screen point, or source reference), one call returns each region's subtree.
* Opt-in per call: geometry, authored class names, component inputs, accessibility facts, and surroundings (ancestors, siblings, stacking order at a point).
* Each element carries: its type, its own text (never descendants'), the component that rendered it (real names only, never synthetic), the source location relative to the project, and the resolved styles the caller asked for.
* The region root also states its rendered size and, when width is constrained by an ancestor, that constraint and which component imposes it.
* Answers reflect the live page at the moment of asking — never a cached view, unless the caller explicitly targets a snapshot.

## Supporting operations

* Status: which pages are connected (URL, title, viewport, last seen) and which is active.
* Overview: a page's major regions, landmarks, and components, as entry points for region reads.
* Find: elements by visible text, component name, or source reference; results are complete enough to act on without follow-up; counts bounded and adjustable.

## Snapshots

* The agent can capture a page's whole state in one call, optionally tagging it with a name, and gets a snapshot id back; snapshots can be listed and deleted (by id or tag), and live for the dev-server session (bounded in number).
* A capture holds everything later questions may need — all elements including hidden ones, geometry, resolved styles, component and source mapping, inputs, accessibility facts — so the same read/find/overview questions run unchanged against a snapshot id.
* Refs inside a snapshot never go stale; the snapshot is immutable.
* Staleness is always explicit: every snapshot answer names the snapshot and its age. Readiness conditions are rejected on snapshots — there is nothing to wait for.
* The live page remains the default target; snapshots are only consulted when explicitly named.

## Annotations

* A user can pin free-text feedback to elements directly on the rendered page (a keyboard-toggled annotate mode: click one element, or shift-click several, and type). One note can cover multiple elements.
* Every note carries each element's identity — component, source location, geometry, text — so feedback arrives pre-resolved to code, and it appears on the elements themselves in read/find answers.
* The agent can list notes, mark them done (optionally saying how), and remove them; resolution is visible on the page (pins turn green) so the user watches feedback get addressed.
* Notes survive reloads (re-anchored by source, then text, then component; failures marked orphaned, never dropped silently) and dev-server restarts (persisted in the project under `.insider/`).
* Snapshots embed the page's notes at capture time.
* The annotation overlay is injected by the tool, isolated from the app (shadow DOM, outside the body), excluded from every answer, and changes nothing about the app itself.

## Response economy

* Facts once: no value repeated between element and reference, no inherited style repeated on a matching child (the root states the baseline), no default/no-effect values emitted.
* Structural wrappers with no size, text, or identity are collapsed and reported as a count.
* Minimal by default; the caller opts into more (styles, hidden content, depth), never out of noise.
* Long content is truncated with a size hint stating what was cut and how to get the rest.

## Identity

* Every described element carries a stable identity, and any identity handed out is accepted back as a target. The agent never invents its own way of pointing at something the tool already named.

## Honesty and errors

* Every read accepts a readiness condition (expected text plus wait budget) and reports whether it was met; internal limits always exceed the caller's budget so waiting cannot itself fail.
* "Not rendered yet", "wrong page", and "not there" are distinct answers; unknown facts are reported as unknown, never guessed. Missing component/source mapping is absent, never wrong.
* Every failure is an answer that says what to do next; unknown targets list what exists; an unresponsive page yields a bounded timeout, not a hang.
* Forgiving targets: common shorthand forms accepted; a call fails only when genuinely unanswerable. Unknown flags fail loudly (exit 2) with the valid ones listed, never silently ignored.
* No question crashes the page or the dev server.

## Safety and scope

* Read-only: never clicks, types, navigates, scrolls, or mutates the app. Its presence changes nothing about how the app behaves, renders, or performs; the only visible additions are the tool's own annotation pins and badge, which live outside the app's DOM and appear in no answer.
* Component inputs are bounded in size and depth; secret-like names redacted; no absolute paths ever.
* It answers with numbers and structure; aesthetics judgments and transient interaction states are out of scope.

## Success criterion

An agent reproducing a visible region in another codebase needs one or two read calls, gets exact resolved values (including ones invisible to a screenshot), and pays less per read than interpreting one screenshot.
