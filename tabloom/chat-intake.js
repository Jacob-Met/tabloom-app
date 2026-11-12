// Group-chat intake: turn pasted chat text into [{sender, text}], match senders to guests,
// build the attributed note the split model reads, and build the messages to paste back.
const INVISIBLE = /[‎‏‪-‮⁦-⁩﻿]/g;
const WA_HEADER = /^\[?(?:\d{1,4}[\/.\-]\d{1,2}[\/.\-]\d{1,4}),?\s+\d{1,2}[:.]\d{2}(?:[:.]\d{2})?\s*(?:[ap]\.?m\.?)?\]?\s*(?:[-–—]\s*)?(.*)$/i;
const NAME_MSG = /^(~?\s?[\p{L}][\p{L}\p{M}'’.\-]*(?: [\p{L}][\p{L}\p{M}'’.\-]*){0,3}):(?:\s+(.*)|$)/u;
const NAME_ALONE = /^~?\s?\p{Lu}[\p{L}\p{M}'’.\-]*(?: \p{L}[\p{L}\p{M}'’.\-]*){0,2}$/u;
const TIME_ONLY = /^(?:(?:today|yesterday|mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s*)?(?:[a-z]{3,9}\.? \d{1,2},?\s*(?:\d{4},?\s*)?)?(?:\d{1,2}[:.]\d{2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?)?$/i;
const DATE_ONLY = /^(?:(?:today|yesterday|mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s*)?(?:\d{1,4}[\/.\-]\d{1,2}[\/.\-]\d{1,4}|[a-z]{3,9}\.? \d{1,2}(?:,? \d{4})?)$/i;
const NOISE = [
  /^(?:<)?(?:media|image|video|audio|sticker|gif|document|contact card|voice message|photo|attachment)s?\s+(?:omitted|attached)(?:>)?$/i,
  /^(?:<)?(?:image|video|audio|sticker|gif|document|photo)\s+omitted(?:>)?$/i,
  /^\[?(?:image|photo|video|sticker|gif|attachment|audio)\]?$/i,
  /^(?:this message was deleted|you deleted this message|<?this message was edited>?|null|waiting for this message.*)$/i,
  /^(?:delivered|read|seen|sent|not delivered|edited|today|yesterday)(?:\s+.*)?$/i,
  /^messages and calls are end-to-end encrypted.*/i,
  /^(?:.+ )?(?:reacted .+ to|liked|loved|disliked|laughed at|emphasized|questioned) ["“”'‘].*/i,
  /^(?:.+ )?(?:added|removed|left|joined|changed (?:the|this)|created (?:the )?group|was added|pinned a message|is now an admin|changed their phone number).*$/i,
  /^(?:\p{Extended_Pictographic}|\s|[‍️\d])+$/u,
  /^\d+ (?:replies|reactions?)$/i,
];
const isNoise = line => !line || TIME_ONLY.test(line) || DATE_ONLY.test(line) || NOISE.some(re => re.test(line));
const clean = text => text.replace(/\s*(?:\(edited\)|<this message was edited>)\s*$/i, "").replace(/\s+/g, " ").trim();
const cleanSender = name => name.replace(/^~\s*/, "").trim();

/** Parse pasted chat text into [{sender, text}]. Timestamps, reactions, omitted media and system lines are dropped. */
export function parseChat(raw) {
  const lines = String(raw ?? "").replace(INVISIBLE, "").replace(/[  ]/g, " ").split(/\r?\n/).map(l => l.trim());
  const whatsapp = lines.some(line => { const m = WA_HEADER.exec(line); return m && NAME_MSG.test(m[1]); });
  const out = [];
  let current = null, blockMode = false, afterBlank = true;
  const start = (sender, text, block) => { current = { sender: cleanSender(sender), parts: text ? [text] : [] }; out.push(current); blockMode = block; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) { afterBlank = true; continue; }
    if (whatsapp) {
      const header = WA_HEADER.exec(line);
      if (header) {
        const m = NAME_MSG.exec(header[1].trim());
        if (m) { if (!isNoise(clean(m[2] || "")) || !m[2]) start(m[1], m[2] ? clean(m[2]) : "", false); else current = null; }
        else current = null; // system line: "Messages and calls are end-to-end encrypted", "X added Y"
        continue;
      }
      if (current && !isNoise(line)) current.parts.push(clean(line));
      continue;
    }
    if (isNoise(line)) continue;
    const named = NAME_MSG.exec(line);
    if (named && (!blockMode || afterBlank)) { afterBlank = false; start(named[1], named[2] ? clean(named[2]) : "", false); continue; }
    // A name on its own line opens a block (iMessage / Android copy): the lines under it are that person's message.
    if (afterBlank && NAME_ALONE.test(line)) {
      let k = i + 1; while (k < lines.length && lines[k] && isNoise(lines[k])) k++;
      const hasBody = k < lines.length && lines[k] && !NAME_MSG.test(lines[k]);
      if (hasBody || k > i + 1) { afterBlank = false; start(line, "", true); continue; } // a name followed only by a reaction or time still opens its block
    }
    afterBlank = false;
    if (current) current.parts.push(clean(line));
  }
  return out.map(m => ({ sender: m.sender, text: clean(m.parts.join(" ")) })).filter(m => m.sender && /[\p{L}\p{N}]/u.test(m.text));
}

const norm = text => String(text).normalize("NFKD").replace(/\p{M}/gu, "").trim().toLowerCase().replace(/\s+/g, " ");
export function senderList(messages) {
  const seen = new Map();
  for (const m of messages) { const key = norm(m.sender); const entry = seen.get(key) || { sender: m.sender, count: 0 }; entry.count++; seen.set(key, entry); }
  return [...seen.values()];
}
/** Match senders to table guests: whole name first, then first name; ambiguous or unknown senders stay unmatched. */
export function matchSenders(senders, guests) {
  const matched = {}, unmatched = [];
  for (const sender of senders) {
    const s = norm(sender);
    let hits = guests.filter(g => norm(g.name) === s);
    if (hits.length !== 1) {
      const first = s.split(" ")[0];
      hits = guests.filter(g => norm(g.name).split(" ")[0] === first);
    }
    if (hits.length === 1) matched[s] = hits[0].id; else unmatched.push(sender);
  }
  return { matched, unmatched };
}

/** The note the existing split path reads: one attributed line per message, kept within the 2,000 character limit. */
export function buildChatNote(messages, guestNameBySender, limit = 2000) {
  let rows = messages.map(m => ({ who: guestNameBySender[norm(m.sender)], text: m.text.length > 300 ? m.text.slice(0, 297) + "…" : m.text }))
    .filter(r => r.who).map(r => ({ ...r, line: r.who + " said: " + r.text }));
  let dropped = 0;
  const size = () => rows.reduce((n, r) => n + r.line.length + 1, 0);
  while (size() > limit && rows.length) {
    // Drop the least informative message first: no digits or long words, then the shortest.
    let idx = 0, best = Infinity;
    rows.forEach((r, i) => { const score = r.text.length + (/\d/.test(r.text) ? 40 : 0); if (score < best) { best = score; idx = i; } });
    rows.splice(idx, 1); dropped++;
  }
  return { note: rows.map(r => r.line).join("\n"), used: rows.length, dropped };
}

const money = cents => "$" + (cents / 100).toFixed(2);
/** One line per guest for the group chat; `rows` are {name, cents, url?}. */
export function guestLine(row) {
  if (row.cents === 0) return row.name + ": nothing to pay";
  return row.name + ": " + money(row.cents) + (row.url ? " " + row.url : " (request coming)");
}
export function buildGroupMessage({ title, rows, receiptCents }) {
  const sum = rows.reduce((n, r) => n + r.cents, 0);
  const check = sum === receiptCents ? "Check: " + money(sum) + " split = " + money(receiptCents) + " receipt total" : "Check: shares add up to " + money(sum) + " but the receipt total is " + money(receiptCents);
  return [(title ? title + " — " : "") + "what everyone owes", ...rows.map(guestLine), check].join("\n");
}
export function buildGuestMessage({ title, row }) {
  return row.cents === 0 ? row.name + ", you owe nothing for " + (title || "dinner") + "." : row.name + ", your share of " + (title || "dinner") + " is " + money(row.cents) + (row.url ? ". Pay here: " + row.url : ".");
}
