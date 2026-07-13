import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoteStore } from "../dist/notes.js";

test("note lifecycle: create, list, done, rm, persist across reload", () => {
  const file = join(mkdtempSync(join(tmpdir(), "insider-")), "notes.json");
  const store = new NoteStore(file);

  const n = store.create("too tight", [{ src: "src/App.jsx:7", component: "Card", text: "Espresso" }], "/");
  assert.equal(n.id, "n1");
  assert.equal(n.state, "open");

  store.create("align these", [{ src: "a.tsx:1" }, { src: "b.tsx:2" }], "/dash");
  assert.equal(store.list().length, 2);
  assert.equal(store.list("/dash").length, 1);
  assert.equal(store.list("/dash")[0].elements.length, 2, "multi-element note");

  assert.equal(store.done("n1", "gap 8->12").resolution, "gap 8->12");
  assert.equal(store.done("nope"), null);

  // reload from disk: state survives, ids keep counting
  const store2 = new NoteStore(file);
  assert.equal(store2.list().length, 2);
  assert.equal(store2.list()[0].state, "done");
  assert.equal(store2.create("third", [], "/").id, "n3");

  assert.ok(store2.rm("n2"));
  assert.equal(new NoteStore(file).list().length, 2);
  assert.equal(store2.clear(), 2);
});
