import test from "node:test";
import assert from "node:assert/strict";
import { analyzeChat, menuAliases, buildFullNote, guessRestaurant, wordsMatch, parseChat, matchSenders, senderList, buildChatNote, buildGroupMessage, buildGuestMessage } from "../tabloom/chat-intake.js";

test("plain Name: message lines", () => {
  const m = parseChat("Camille: I had the sea bass\nTomas: me too\nand the tea\nNoor: it's my birthday");
  assert.deepEqual(m, [{ sender: "Camille", text: "I had the sea bass" }, { sender: "Tomas", text: "me too and the tea" }, { sender: "Noor", text: "it's my birthday" }]);
});
test("WhatsApp export: timestamps, system lines, media and edits are ignored", () => {
  const m = parseChat([
    "[11/12/26, 8:00 PM] Messages and calls are end-to-end encrypted.",
    "[11/12/26, 8:14 PM] Camille: I had the sea bass",
    "[11/12/26, 8:15 PM] Tomas: <Media omitted>",
    "11/12/26, 8:16 PM - Noor added Priya",
    "11/12/26, 8:17 PM - Tomas: Tea: 8 for everyone (edited)",
    "second line of Tomas",
    "[11/12/26, 8:18:05 PM] Idris: image omitted",
    "[2026-11-12 20:19] Idris: split the tea between everyone except Noor",
  ].join("\n"));
  assert.deepEqual(m, [{ sender: "Camille", text: "I had the sea bass" }, { sender: "Tomas", text: "Tea: 8 for everyone (edited) second line of Tomas".replace(" (edited)", "") }, { sender: "Idris", text: "split the tea between everyone except Noor" }]);
});
test("iMessage / Android copy: name on its own line, timestamps and reactions dropped", () => {
  const m = parseChat("Thursday, Nov 12\n\nCamille\nI had the sea bass\nand shared the mezze\nDelivered\n\nTomas\n8:14 PM\nLoved “I had the sea bass”\nsame as Camille\n\nTomas reacted 👍 to “same as Camille”\n\nNoor\n👍\n\nIdris\nit's Noor's birthday, she pays nothing\nRead 8:20 PM");
  assert.deepEqual(m, [{ sender: "Camille", text: "I had the sea bass and shared the mezze" }, { sender: "Tomas", text: "same as Camille" }, { sender: "Idris", text: "it's Noor's birthday, she pays nothing" }]);
});
test("junk and empty input", () => {
  assert.deepEqual(parseChat(""), []);
  assert.deepEqual(parseChat("12:30\n\n👍👍"), []);
});
test("sender matching is case-insensitive, first-name based, and never guesses", () => {
  const guests = [{ id: "g1", name: "Camille" }, { id: "g2", name: "Tomas Reyes" }, { id: "g3", name: "Sam A" }, { id: "g4", name: "Sam B" }];
  const r = matchSenders(["camille", "Tomas", "SAM", "Priya", "Camille Okoye"], guests);
  assert.equal(r.matched.camille, "g1"); assert.equal(r.matched.tomas, "g2"); assert.equal(r.matched["camille okoye"], "g1");
  assert.deepEqual(r.unmatched, ["SAM", "Priya"]);
  assert.deepEqual(senderList(parseChat("Ann: hi there\nann: yo")), [{ sender: "Ann", count: 2 }]);
});
test("attributed note names the table guest, skips ignored senders, fits the limit", () => {
  const msgs = parseChat("camille: I had the sea bass\nStranger: hello there\nTomas: x " + "tea ".repeat(100));
  const r = buildChatNote(msgs, { camille: "Camille", tomas: "Tomas" });
  assert.match(r.note, /^Camille said: I had the sea bass\nTomas said: /);
  assert.ok(!r.note.includes("Stranger"));
  const big = buildChatNote(Array.from({ length: 200 }, (_, i) => ({ sender: "A", text: "message number " + i + " about dinner" })), { a: "Ann" }, 2000);
  assert.ok(big.note.length <= 2000 && big.dropped > 0);
});
test("messages to paste back", () => {
  const rows = [{ name: "Camille", cents: 3292, url: "https://pay/c" }, { name: "Noor", cents: 0 }, { name: "Tomas", cents: 3000 }];
  const text = buildGroupMessage({ title: "Dinner", rows, receiptCents: 6292 });
  assert.equal(text.split("\n").length, 5);
  assert.match(text, /Camille: \$32\.92 https:\/\/pay\/c/); assert.match(text, /Noor: nothing to pay/); assert.match(text, /Tomas: \$30\.00 \(request coming\)/);
  assert.match(text, /Check: \$62\.92 split = \$62\.92 receipt total/);
  assert.match(buildGuestMessage({ title: "Dinner", row: rows[0] }), /\$32\.92\. Pay here: https:\/\/pay\/c/);
});

// ---- Clear this up: matching chat mentions to receipt items ----
const items = [["i1", "Grilled chicken plate"], ["i2", "Chicken penne"], ["i3", "Grilled sea bass"], ["i4", "Lamb tagine"], ["i5", "Mezze platter"], ["i6", "Mint tea pot"]].map(([id, name]) => ({ id, name }));
const guests = ["Noor", "Idris", "Camille", "Tomas", "Priya"].map(name => ({ id: name.toLowerCase(), name }));
const owners = Object.fromEntries(guests.map(g => [g.name.toLowerCase(), g.id]));
const run = (lines, menuText = "") => analyzeChat({ messages: lines.map(l => { const [sender, ...r] = l.split(": "); return { sender, text: r.join(": ") }; }), ownerBySender: owners, guests, items, menuText });
test("wordsMatch tolerates plurals, typos and short forms", () => {
  assert.ok(wordsMatch("chkn", "chicken") && wordsMatch("tagene", "tagine") && wordsMatch("bas", "bass") && wordsMatch("mezzes", "mezze"));
  assert.ok(!wordsMatch("lamb", "lime") && !wordsMatch("tea", "penne"));
});
test("'the chicken' matches two dishes: ambiguous", () => {
  const r = run(["Tomas: i had the chicken"]);
  assert.equal(r.ambiguous.length, 1);
  assert.deepEqual(r.ambiguous[0].itemIds.sort(), ["i1", "i2"]);
  assert.equal(r.ambiguous[0].guestId, "tomas");
  assert.deepEqual(r.resolved, []);
});
test("a full dish name settles it: no card, and the other chicken dish is not dragged in", () => {
  for (const [text, id] of [["chicken penne for me", "i2"], ["the grilled chicken", "i1"], ["chkn penne pls", "i2"], ["grilled chicken plate", "i1"]]) {
    const r = run(["Camille: " + text]);
    assert.deepEqual(r.ambiguous, [], text);
    assert.deepEqual(r.resolved.map(x => x.itemId), [id], text);
  }
});
test("one match is just that person's item, typos and emoji included", () => {
  const r = run(["Idris: sea bas 🐟 for me", "Noor: lamb tagene pls 🙏"]);
  assert.deepEqual(r.resolved.map(x => [x.guestId, x.itemId]), [["idris", "i3"], ["noor", "i4"]]);
  assert.deepEqual(r.ambiguous, []);
});
test("several dishes in one message, one of them ambiguous", () => {
  const r = run(["Camille: the lamb and the chicken"]);
  assert.deepEqual(r.resolved.map(x => x.itemId), ["i4"]);
  assert.equal(r.ambiguous.length, 1);
});
test("unclaimed items and silent guests", () => {
  const r = run(["Idris: sea bass", "Camille: chicken penne and the mezze", "Tomas: the chicken", "Noor: <thanks all>"]);
  // i1 is only a candidate of the open "the chicken" card, so the view keeps it off the unclaimed list until that is answered
  assert.deepEqual(items.filter(i => !r.claimed.includes(i.id)).map(i => i.id), ["i1", "i4", "i6"]);
  assert.deepEqual(r.silent.sort(), ["noor", "priya"]);
});
test("menu aliases let 'the pollo' find the grilled chicken plate", () => {
  const menu = "Pollo alla griglia - grilled chicken plate\nPenne al pollo - chicken penne";
  assert.deepEqual(Object.keys(menuAliases(menu, items)).sort(), ["i1", "i2"]);
  assert.deepEqual(run(["Tomas: the pollo"], menu).ambiguous.length, 1);
  const r = run(["Tomas: the griglia"], menu);
  assert.deepEqual(r.resolved.map(x => x.itemId), ["i1"]);
  assert.deepEqual(r.ambiguous, []);
});
test("note keeps chat and the payer's answers first, then a trimmed menu block", () => {
  const messages = [{ sender: "Tomas", text: "the chicken" }];
  const out = buildFullNote({ messages, nameBySender: { tomas: "Tomas" }, clarifications: ["Clarified by the payer: Tomas had the Grilled chicken plate."], restaurant: "Cedar", menuText: "Pollo - grilled chicken\n" + "x".repeat(3000), limit: 400 });
  assert.ok(out.note.startsWith("Tomas said: the chicken\nClarified by the payer: Tomas had the Grilled chicken plate.\nMenu context (Cedar): Pollo"));
  assert.ok(out.note.length <= 400 && out.menuUsed);
  assert.equal(buildFullNote({ messages, nameBySender: { tomas: "Tomas" }, menuText: "" }).menuUsed, false);
});
test("restaurant guess takes the first line that is not an item or total", () => {
  assert.equal(guessRestaurant("Cedar & Olive Kitchen\nLamb tagine 26.00\nTotal 26.00"), "Cedar & Olive Kitchen");
  assert.equal(guessRestaurant("Lamb tagine 26.00\nTax 2.00"), "");
});
