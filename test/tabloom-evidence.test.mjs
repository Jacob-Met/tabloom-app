import test from "node:test";
import assert from "node:assert/strict";
import { claim, collectFromMessages, fuse, summary } from "../tabloom/evidence.js";
import { parseChat } from "../tabloom/chat-intake.js";

const guests = [{ id: "c", name: "Camille" }, { id: "t", name: "Tomas" }, { id: "n", name: "Noor" }, { id: "i", name: "Idris" }];
const items = [
  { id: "bass", name: "Sea bass", priceCents: 2800 },
  { id: "gchick", name: "Grilled chicken plate", priceCents: 2200 },
  { id: "fchick", name: "Fried chicken sandwich", priceCents: 1600 },
  { id: "tea", name: "Iced tea", priceCents: 400 },
  { id: "wine", name: "House wine", priceCents: 900 },
  { id: "cake", name: "Birthday cake", priceCents: 1200 },
  { id: "mezze", name: "Mezze", priceCents: 1500 },
];
const owner = { camille: "c", tomas: "t", noor: "n", idris: "i" };
const get = (f, id) => f.find(x => x.itemId === id);

test("chat and voice agree: sure", () => {
  const cs = [...collectFromMessages({ messages: parseChat("Camille: I had the sea bass"), ownerBySender: owner, guests, items, source: "chat" }), ...collectFromMessages({ messages: [{ sender: "Camille", text: "the sea bass was mine" }], ownerBySender: owner, guests, items, source: "voice" })];
  const r = get(fuse({ claims: cs, guests, items }), "bass");
  assert.equal(r.state, "sure"); assert.deepEqual(r.payers, ["c"]); assert.ok(r.confidence > 0.9);
});
test("chat says Camille, position says Tomas: likely Camille, both explained", () => {
  const cs = [claim({ personId: "c", itemId: "bass", source: "chat", text: "I had the bass" }), claim({ personId: "t", itemId: "bass", source: "position" })];
  const r = get(fuse({ claims: cs, guests, items }), "bass");
  assert.equal(r.state, "likely"); assert.deepEqual(r.payers, ["c"]);
  assert.deepEqual(r.because.map(b => b.personId).sort(), ["c", "t"]);
});
test("ambiguous 'the chicken' resolves with position evidence", () => {
  const cs = [...collectFromMessages({ messages: [{ sender: "Camille", text: "I had the chicken" }], ownerBySender: owner, guests, items }), claim({ personId: "c", itemId: "gchick", source: "position" })];
  assert.ok(cs.some(c => c.ambiguous));
  const f = fuse({ claims: cs, guests, items });
  assert.equal(get(f, "gchick").state, "likely"); assert.deepEqual(get(f, "gchick").payers, ["c"]);
  assert.equal(get(f, "fchick").payers.length, 0);
  assert.equal(get(f, "fchick").state, "nobody");
});
test("ambiguous with no other evidence asks which item", () => {
  const cs = collectFromMessages({ messages: [{ sender: "Camille", text: "I had the chicken" }], ownerBySender: owner, guests, items });
  const r = get(fuse({ claims: cs, guests, items }), "gchick");
  assert.equal(r.state, "ask"); assert.equal(r.question.type, "which-item");
});
test("payer override wins over everything", () => {
  const cs = [claim({ personId: "c", itemId: "bass", source: "chat" }), claim({ personId: "c", itemId: "bass", source: "voice" }), claim({ personId: "t", itemId: "bass", source: "payer" })];
  const r = get(fuse({ claims: cs, guests, items }), "bass");
  assert.deepEqual(r.payers, ["t"]); assert.equal(r.state, "sure"); assert.equal(r.confidence, 1);
});
test("conflict on a single item asks; shared claim splits it", () => {
  const cs = [claim({ personId: "c", itemId: "bass", source: "chat" }), claim({ personId: "t", itemId: "bass", source: "voice" })];
  const r = get(fuse({ claims: cs, guests, items }), "bass");
  assert.equal(r.question.type, "conflict"); assert.equal(r.state, "ask");
  const s = get(fuse({ claims: [...cs, claim({ personId: "t", itemId: "bass", source: "note", kind: "shared" })], guests, items }), "bass");
  assert.deepEqual(s.payers.sort(), ["c", "t"]); assert.equal(s.question, undefined);
});
test("quantity 2 with two claimers: each had one", () => {
  const cs = [claim({ personId: "c", itemId: "wine", source: "chat" }), claim({ personId: "t", itemId: "wine", source: "chat" })];
  const r = get(fuse({ claims: cs, guests, items, quantities: { wine: 2 } }), "wine");
  assert.deepEqual(r.payers.sort(), ["c", "t"]); assert.equal(r.question, undefined); assert.equal(r.state, "likely");
});
test("quantity 2 with three claimers: who-had question", () => {
  const cs = ["c", "t", "n"].map(personId => claim({ personId, itemId: "wine", source: "chat" }));
  const r = get(fuse({ claims: cs, guests, items, quantities: { wine: 2 } }), "wine");
  assert.equal(r.question.type, "who-had"); assert.equal(r.state, "ask");
});
test("birthday: covered-by moves payment but keeps who had it", () => {
  const cs = [claim({ personId: "n", itemId: "cake", source: "chat", text: "it's my birthday", kind: "covered-by", by: ["i", "t"] })];
  const r = get(fuse({ claims: cs, guests, items }), "cake");
  assert.deepEqual(r.payers.sort(), ["i", "t"]); assert.equal(r.because[0].personId, "n");
});
test("unmentioned drinks are grouped into one question", () => {
  const f = fuse({ claims: [claim({ personId: "c", itemId: "bass", source: "chat" })], guests, items });
  assert.equal(get(f, "tea").state, "nobody");
  const s = summary(f, items);
  const drinks = s.questions.filter(q => q.grouped === "drinks");
  assert.equal(drinks.length, 1); assert.deepEqual(drinks[0].itemIds.sort(), ["tea", "wine"]);
  assert.equal(s.sure + s.likely + s.ask + s.nobody, items.length);
  assert.ok(s.questions.every((q, i, a) => !i || a[i - 1].value >= q.value));
});
test("explicit 'not mine' removes the person", () => {
  const cs = [claim({ personId: "c", itemId: "bass", source: "position" }), claim({ personId: "c", itemId: "bass", source: "chat", text: "the bass isn't mine", kind: "not" }), claim({ personId: "t", itemId: "bass", source: "chat" })];
  const r = get(fuse({ claims: cs, guests, items }), "bass");
  assert.deepEqual(r.payers, ["t"]);
  const m = collectFromMessages({ messages: [{ sender: "Camille", text: "the sea bass wasn't mine" }], ownerBySender: owner, guests, items });
  assert.equal(m[0].kind, "not");
});
