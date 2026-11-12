import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureBill, validateDraft } from "../src/tabloom.js";
import { guestReviewPacket } from "../src/tabloom-guest-review.js";
import { previewGuestReviews } from "../src/tabloom-guest-batch.js";

function supper() {
  const bill = fixtureBill();
  bill.title = "Night train supper";
  bill.guests.forEach((guest, index) => { guest.name = ["Rosa", "Nikhil", "Leni"][index]; });
  bill.items.forEach((item, index) => { item.cents = [1983, 1207, 541][index]; });
  bill.taxCents = 261; bill.tipCents = 509;
  return bill;
}
function response(bill: ReturnType<typeof supper>, guest: string, selected: string[]) {
  const packet = guestReviewPacket(bill, "supper", guest);
  return { ...packet, kind: "tabloom-guest-response",
    items: packet.items.map(item => ({ id: item.id, selected: selected.includes(item.id) })) };
}

test("the observed two-diner course keeps both contributions and exact shared charges", () => {
  const bill = supper(), before = structuredClone(bill);
  const rosa = response(bill, "mira", ["udon", "dumplings", "water"]);
  const nikhil = response(bill, "joss", ["udon", "water"]);
  const preview = previewGuestReviews(bill, "supper", [rosa, nikhil]);
  assert.deepEqual(preview.bill.items.map(item => item.sharedBy), [
    ["mira", "joss"], ["mira", "petra"], ["mira", "joss", "petra"],
  ]);
  assert.equal(preview.calculated!.totalCents, 4501);
  // Independent integer-cent reference: item splits 1775/1173/783,
  // tax 124/82/55, tip 242/160/107, including stable tie rounding.
  assert.deepEqual(preview.calculated!.dues.map(due =>
    [due.itemsCents, due.taxCents, due.tipCents, due.totalCents]),
    [[1775, 124, 242, 2141], [1173, 82, 160, 1415], [783, 55, 107, 945]]);
  assert.deepEqual(previewGuestReviews(bill, "supper", [nikhil, rosa]), preview);
  assert.deepEqual(bill, before);
});

test("a guest can hand off a sole-owned item to another guest in the same review", () => {
  const bill = supper();
  const preview = previewGuestReviews(bill, "supper", [
    response(bill, "mira", ["water"]),
    response(bill, "joss", ["udon", "dumplings", "water"]),
  ]);
  assert.deepEqual(preview.bill.items[0].sharedBy, ["joss"]);
  assert.deepEqual(preview.unresolved, []);
  assert.equal(preview.calculated!.totalCents, 4501);
});

test("several opt-outs leave an item unassigned instead of billing an uninvolved diner", () => {
  const bill = supper();
  const preview = previewGuestReviews(bill, "supper", [
    response(bill, "joss", ["water"]), response(bill, "petra", ["water"]),
  ]);
  assert.deepEqual(preview.bill.items[1].sharedBy, []);
  assert.deepEqual(preview.unresolved, [{ id: "dumplings", name: bill.items[1].name }]);
  assert.equal(preview.calculated, null);
  assert.throws(() => validateDraft(preview.bill, bill.revision + 1, {}), /at least one guest/);
});

test("unchanged choices still identify the people whose responses were reviewed", () => {
  const bill = supper();
  const preview = previewGuestReviews(bill, "supper", [
    response(bill, "mira", ["udon", "water"]),
    response(bill, "joss", ["dumplings", "water"]),
  ]);
  assert.deepEqual(preview.changes, []);
  assert.deepEqual(preview.reviews.map(review => review.guest), ["Rosa", "Nikhil"]);
  assert.deepEqual(preview.bill, bill);
});

test("one stale response refuses the whole selection without partially applying the other", () => {
  const bill = supper(), before = structuredClone(bill);
  const first = response(bill, "mira", ["udon", "dumplings", "water"]);
  const stale = response(bill, "joss", ["udon", "water"]); stale.revision++;
  assert.throws(() => previewGuestReviews(bill, "supper", [first, stale]), /older or different/);
  assert.deepEqual(bill, before);
});

test("two different statements from the same diner are not silently combined", () => {
  const bill = supper();
  assert.throws(() => previewGuestReviews(bill, "supper", [
    response(bill, "mira", ["udon", "water"]),
    response(bill, "mira", ["udon", "dumplings", "water"]),
  ]), /only one response from Rosa/);
});
