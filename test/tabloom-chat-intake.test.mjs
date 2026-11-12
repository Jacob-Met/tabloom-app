import test from "node:test";
import assert from "node:assert/strict";
import { parseChat, matchSenders, senderList, buildChatNote, buildGroupMessage, buildGuestMessage } from "../tabloom/chat-intake.js";

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
