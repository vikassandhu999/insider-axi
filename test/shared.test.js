import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseLocator, parseQuery, parseSourceRef, sourceRefMatches, boundValue, parseWait,
} from "../dist/shared.js";

test("locator forms", () => {
  assert.deepEqual(parseLocator("role:button"), { role: "button" });
  assert.deepEqual(parseLocator('text:"Add to cart"'), { text: "Add to cart" });
  assert.deepEqual(parseLocator("ref:e42"), { ref: "e42" });
  assert.deepEqual(parseLocator("point:120,340"), { point: [120, 340] });
  assert.deepEqual(parseLocator("src:Cart.tsx:42"), { src: "Cart.tsx:42" });
  assert.deepEqual(parseLocator("Add to cart"), { text: "Add to cart" }, "bare string is text");
  assert.equal(parseLocator("point:x,y"), null);
  assert.equal(parseLocator(""), null);
});

test("query forms", () => {
  assert.deepEqual(parseQuery("component:Card"), { component: "Card" });
  assert.deepEqual(parseQuery("src:Cart.tsx"), { src: "Cart.tsx" });
  assert.deepEqual(parseQuery("checkout"), { text: "checkout" });
});

test("source ref parsing and precedence", () => {
  assert.deepEqual(parseSourceRef("src/components/Cart.tsx:42:7"),
    { path: "src/components/Cart.tsx", line: 42, col: 7, component: undefined });
  assert.deepEqual(parseSourceRef("Cart.tsx#CartItem"),
    { path: "Cart.tsx", line: undefined, col: undefined, component: "CartItem" });
  // line wins: #Component ignored when a line is present
  assert.equal(parseSourceRef("Cart.tsx:42#CartItem").component, undefined);
  assert.equal(parseSourceRef("Cart.tsx:42#CartItem").line, 42);
});

test("source ref matching: suffix, case-insensitive, line, component", () => {
  const el = { path: "src/components/Cart.tsx", line: 42, component: "CartItem" };
  assert.ok(sourceRefMatches(parseSourceRef("cart.tsx"), el));
  assert.ok(sourceRefMatches(parseSourceRef("components/Cart.tsx"), el));
  assert.ok(sourceRefMatches(parseSourceRef("Cart.tsx:42"), el));
  assert.ok(!sourceRefMatches(parseSourceRef("Cart.tsx:41"), el));
  assert.ok(sourceRefMatches(parseSourceRef("Cart.tsx#CartItem"), el));
  assert.ok(!sourceRefMatches(parseSourceRef("Cart.tsx#Other"), el));
  assert.ok(!sourceRefMatches(parseSourceRef("Other.tsx"), el));
});

test("props bounding and redaction", () => {
  const v = boundValue({
    apiToken: "abc", nested: { deep: { deeper: 1 } }, long: "x".repeat(200),
    fn: () => {}, list: [1, 2, 3],
  });
  assert.equal(v.apiToken, "[redacted]");
  assert.equal(v.fn, "[fn]");
  assert.equal(v.nested.deep, "[object]");
  assert.ok(String(v.long).length < 100);
  assert.deepEqual(v.list, [1, 2, 3]);
});

test("wait parsing", () => {
  assert.deepEqual(parseWait("Loaded"), { text: "Loaded", budgetMs: 2000 });
  assert.deepEqual(parseWait("Loaded:5000"), { text: "Loaded", budgetMs: 5000 });
  assert.equal(parseWait(""), null);
});
