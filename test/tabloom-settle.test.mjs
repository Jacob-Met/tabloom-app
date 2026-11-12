import test from "node:test";
import assert from "node:assert/strict";
import { settle } from "../tabloom/crew.js";

test("nets opposite debts and reduces to fewest payments", () => {
  const r = settle([{ from: "a", to: "b", cents: 1000 }, { from: "b", to: "a", cents: 400 }, { from: "c", to: "b", cents: 500 }]);
  assert.deepEqual(r, [{ from: "a", to: "b", cents: 600 }, { from: "c", to: "b", cents: 500 }]);
});
test("chains collapse", () => {
  assert.deepEqual(settle([{ from: "a", to: "b", cents: 500 }, { from: "b", to: "c", cents: 500 }]), [{ from: "a", to: "c", cents: 500 }]);
});
test("conserves money, ignores junk and self debts", () => {
  const debts = [{ from: "a", to: "b", cents: 700 }, { from: "c", to: "d", cents: 300 }, { from: "b", to: "c", cents: 100 }, { from: "x", to: "x", cents: 50 }, { from: "a", to: "d", cents: 0 }];
  const r = settle(debts), net = {};
  for (const p of r) { net[p.from] = (net[p.from] || 0) - p.cents; net[p.to] = (net[p.to] || 0) + p.cents; }
  assert.deepEqual(net, { a: -700, b: 600, c: -200, d: 300 });
  assert.equal(r.reduce((s, p) => s + p.cents, 0), 900);
  assert.ok(r.length <= 3);
  assert.deepEqual(settle([]), []);
});
