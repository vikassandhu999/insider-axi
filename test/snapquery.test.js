import { test } from "node:test";
import assert from "node:assert/strict";
import { snapRead, snapFind, snapOverview } from "../dist/snapquery.js";

const snap = {
  id: "s1", page: "p1", url: "http://x/", title: "T", viewport: { w: 1000, h: 800 }, takenAt: 0,
  root: {
    ref: "e1", kind: "body", box: { x: 0, y: 0, w: 1000, h: 800 },
    styles: { display: "block", color: "rgb(0, 0, 0)", "font-size": "16px" },
    children: [
      {
        ref: "e2", kind: "main", box: { x: 0, y: 0, w: 1000, h: 700 },
        styles: { display: "flex", gap: "12px" },
        a11y: { role: "main" },
        children: [
          {
            ref: "e3", kind: "div", component: "Card", src: "src/App.jsx:7:5",
            box: { x: 10, y: 10, w: 300, h: 100 }, styles: { padding: "16px" },
            props: { name: "Espresso" },
            children: [
              { ref: "e4", kind: "span", text: "Espresso", box: { x: 20, y: 20, w: 100, h: 20 }, styles: { color: "rgb(10, 125, 51)" } },
            ],
          },
          { ref: "e5", kind: "div", vis: false, box: { x: 0, y: 0, w: 0, h: 0 }, text: "hidden thing" },
        ],
      },
    ],
  },
};

test("snap read by ref: inherited style resolved, parent dup omitted", () => {
  const r = snapRead(snap, [{ ref: "e4" }], { styles: ["color", "font-size", "display"], depth: 0 });
  const root = r.regions[0].root;
  assert.equal(root.styles.color, "rgb(10, 125, 51)");        // own value
  assert.equal(root.styles["font-size"], "16px");             // inherited from e1 via walk-up
  assert.equal(root.styles.display, "flex");                  // nearest ancestor with a value (e2)
});

test("snap read: hidden excluded by default, included with hidden", () => {
  const without = snapRead(snap, [{ ref: "e2" }], { depth: 2 });
  const kids = without.regions[0].root.children.map((c) => c.ref);
  assert.ok(!kids.includes("e5"));
  const withHidden = snapRead(snap, [{ ref: "e2" }], { depth: 2, hidden: true });
  const kids2 = withHidden.regions[0].root.children.map((c) => c.ref);
  assert.ok(kids2.includes("e5"));
});

test("snap locate: text, role, src, point, stale ref", () => {
  assert.equal(snapRead(snap, [{ text: "Espresso" }], { depth: 0 }).regions[0].root.ref, "e4");
  assert.equal(snapRead(snap, [{ role: "main" }], { depth: 0 }).regions[0].root.ref, "e2");
  assert.equal(snapRead(snap, [{ src: "App.jsx:7" }], { depth: 0 }).regions[0].root.ref, "e3");
  assert.equal(snapRead(snap, [{ point: [25, 25] }], { depth: 0 }).regions[0].root.ref, "e4");
  assert.ok(snapRead(snap, [{ ref: "e99" }], {}).regions[0].error);
});

test("snap find: component and total", () => {
  const r = snapFind(snap, { component: "Card" }, 10);
  assert.equal(r.total, 1);
  assert.equal(r.items[0].src, "src/App.jsx:7:5");
});

test("snap overview: regions, landmarks, components", () => {
  const o = snapOverview(snap);
  assert.ok(o.regions.some((r) => r.ref === "e2"));
  assert.ok(o.landmarks.some((l) => l.ref === "e2"));
  assert.equal(o.components[0].component, "Card");
});

test("snap read context: ancestors and stack", () => {
  const r = snapRead(snap, [{ ref: "e4" }], { depth: 0, context: true });
  const ctx = r.regions[0].context;
  assert.deepEqual(ctx.ancestors.map((a) => a.ref), ["e3", "e2", "e1"]);
  assert.ok(ctx.stack.some((s) => s.ref === "e3"));
});
