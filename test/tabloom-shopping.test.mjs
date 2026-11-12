import test from "node:test";
import assert from "node:assert/strict";
import { analyzeHaul } from "../tabloom/shopping.js";

const names = ["KS PAPER TOWEL 12CT", "ATL SALMON FILLET", "KS COFFEE BEANS 2LB", "BLUEBERRIES 18OZ", "EVOO 2L", "PEANUT BUTTER 2PK", "SPARKLING WATER 24"];
const items = names.map((name, i) => ({ id: "i" + i, name }));
const people = [{ id: "g", name: "Grandma" }, { id: "m", name: "Mom" }];
const owner = r => Object.fromEntries(items.map(i => [i.id, r.assign.find(a => a.itemId === i.id)?.personId || "g"]));

test("haul: towels, salmon, coffee go to Mom; the rest stay with Grandma", () => {
  const r = analyzeHaul({ lines: [{ text: "The paper towels and the salmon are for your mom." }, { text: "The coffee is hers too." }, { text: "Everything else is mine." }], people, items, buyerId: "g" });
  assert.deepEqual(owner(r), { i0: "m", i1: "m", i2: "m", i3: "g", i4: "g", i5: "g", i6: "g" });
  assert.deepEqual(r.unsure, []);
  assert.deepEqual(r.defaulted, []);
});
test("haul: unmentioned items default to the buyer", () => {
  const r = analyzeHaul({ lines: ["Mom gets the coffee."], people, items, buyerId: "g" });
  assert.deepEqual(r.assign.map(a => [a.itemId, a.personId]), [["i2", "m"]]);
  assert.equal(r.defaulted.length, 6);
});
test("haul: a thing that matches nothing is unsure", () => {
  const r = analyzeHaul({ lines: ["The ketchup is for mom."], people, items, buyerId: "g" });
  assert.equal(r.unsure.length, 1); assert.deepEqual(r.unsure[0].itemIds, []);
});
test("haul: an ambiguous thing is unsure with the candidates", () => {
  const two = [...items, { id: "x", name: "KS COFFEE PODS 60CT" }];
  const r = analyzeHaul({ lines: ["The coffee is for mom."], people, items: two, buyerId: "g" });
  assert.deepEqual(r.unsure[0].itemIds.sort(), ["i2", "x"]);
});
