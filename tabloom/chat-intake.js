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

// ---- "Clear this up": compare what people said with the receipt items (no model involved) ----
const EMOJI_WORDS = { "🍗": "chicken", "🍝": "pasta", "🐟": "fish", "🍵": "tea", "🫖": "tea", "🍰": "cake", "🎂": "cake", "🍺": "beer", "🍕": "pizza", "🥗": "salad", "🍔": "burger", "🍷": "wine", "🥩": "steak" };
const STOP = new Set(("the and for with from just also too only some pls please thanks thank all everyone everybody each both shared share sharing split splitting half third bit more another same that this these those which what who whom tell paid pay bill nothing nope yes yeah yep okay lol haha had have has got get ordered order orders took take having did does dont didnt ill its not but you your yours mine his her their was were are been will would can could should one two three any anyone dinner lunch food drink drinks birthday tonight").split(" "));
const FILLER = new Set(["plate", "platter", "pot", "bowl", "side", "special", "large", "small", "glass", "dish", "order", "and", "the", "with", "alla", "al", "di", "del", "della", "con"]);
// Kind words people say instead of the dish name, and the receipt words they stand for.
const KINDS = { pasta: ["penne", "spaghetti", "linguine", "rigatoni", "fettuccine", "tagliatelle", "ravioli", "gnocchi", "lasagna", "macaroni", "noodle"], fish: ["bass", "salmon", "cod", "tuna", "trout", "halibut", "snapper"], salad: ["caesar", "greek", "cobb"], sandwich: ["burger", "wrap", "panini", "club"] };
const stem = w => w.length > 4 && w.endsWith("ies") ? w.slice(0, -3) + "y" : w.length > 4 && w.endsWith("es") ? w.slice(0, -2) : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
function edits(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) { let prev = row[0]; row[0] = i; for (let j = 1; j <= b.length; j++) { const tmp = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = tmp; } }
  return row[b.length];
}
function subsequence(a, b) { let k = 0; for (const c of b) if (c === a[k]) k++; return k === a.length; }
/** Does a word from a message mean the same word on the receipt? Plurals, one-letter typos and short forms ("chkn", "bas") count. */
export function wordsMatch(w, t) {
  if (w === t) return true;
  const sw = stem(w), st = stem(t);
  if (sw === st) return true;
  if (w.length >= 5 && t.length >= 5 && edits(w, t) <= (Math.min(w.length, t.length) >= 8 ? 2 : 1)) return true;
  if (sw.length >= 5 && st.length >= 5 && edits(sw, st) <= 1) return true;
  if (w.length >= 3 && w.length <= 5 && t.length > w.length && t.length <= w.length * 2 + 2 && w[0] === t[0] && subsequence(w, t)) return true;
  return false;
}
function tokens(text, extraStop) {
  let s = String(text).normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  s = s.replace(/\p{Extended_Pictographic}/gu, ch => EMOJI_WORDS[ch] ? " " + EMOJI_WORDS[ch] + " " : " ").replace(/['’]s\b/g, "").replace(/['’]/g, "");
  return s.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(w => w.length >= 3 && !/^\d+$/.test(w) && !STOP.has(w) && !(extraStop && extraStop.has(w)));
}
const itemTokens = name => { const all = tokens(name); const t = all.filter(w => !FILLER.has(w)); return t.length ? t : all; };

/** Menu lines like "Pollo alla griglia - grilled chicken plate": the part that names a receipt item makes the other parts aliases for it. */
export function menuAliases(menuText, items) {
  const out = {};
  for (const line of String(menuText || "").split(/\r?\n/)) {
    const segs = line.split(/\s[-–—]\s|[|:()\t]|\s{2,}|\s\$?\d+[.,]\d{2}\b.*$/).map(s => s.trim()).filter(s => s.replace(/[^\p{L}]/gu, "").length >= 3);
    if (segs.length < 2) continue;
    const covered = segs.map(seg => { const w = tokens(seg); return items.filter(it => { const t = itemTokens(it.name); return t.length && t.every(x => w.some(y => wordsMatch(y, x))); }); });
    const hit = covered.findIndex(c => c.length === 1);
    if (hit < 0) continue;
    const item = covered[hit][0];
    segs.forEach((seg, i) => { if (i === hit) return; const t = tokens(seg).filter(w => !FILLER.has(w)); if (t.length) (out[item.id] ||= []).push(t); });
  }
  return out;
}

/**
 * Compare each assigned sender's messages with the receipt items.
 * messages: [{sender,text}]; ownerBySender: normalized sender -> guest id; guests: [{id,name}]; items: [{id,name}].
 * Returns { resolved: [{guestId,itemId,msg}], ambiguous: [{msg,guestId,text,itemIds}], claimed: itemIds mentioned by anyone, silent: guest ids }.
 */
export function analyzeChat({ messages, ownerBySender, guests, items, menuText = "" }) {
  const guestWords = new Set(guests.flatMap(g => tokens(g.name)));
  const aliases = menuAliases(menuText, items);
  const variants = items.map(it => [itemTokens(it.name), ...(aliases[it.id] || [])]);
  const resolved = [], ambiguous = [], claimed = new Set(), spoke = new Set();
  messages.forEach((m, msg) => {
    const words = tokens(m.text, guestWords), guestId = ownerBySender[norm(m.sender)] || "";
    const hits = [];
    items.forEach((it, k) => {
      let best = null;
      for (const toks of variants[k]) {
        const matched = new Set(), covered = new Set();
        toks.forEach((t, ti) => words.forEach((w, wi) => { if (wordsMatch(w, t)) { matched.add(wi); covered.add(ti); } }));
        // two receipt words said as one ("seabass" for "sea bass")
        toks.forEach((t, ti) => { if (ti + 1 < toks.length) words.forEach((w, wi) => { if (w.length >= 6 && wordsMatch(w, t + toks[ti + 1])) { matched.add(wi); covered.add(ti); covered.add(ti + 1); } }); });
        if (covered.size && (!best || covered.size / toks.length > best.ratio)) best = { ratio: covered.size / toks.length, matched, full: covered.size === toks.length };
      }
      if (best) hits.push({ item: it, ...best });
    });
    const exact = hits.filter(h => h.full), exactWords = new Set(exact.flatMap(h => [...h.matched]));
    const partial = hits.filter(h => !h.full && [...h.matched].some(w => !exactWords.has(w)));
    const hasMention = list => { for (const h of list) claimed.add(h.item.id); if (list.length && guestId) spoke.add(guestId); };
    for (const h of exact) { resolved.push({ guestId, itemId: h.item.id, msg }); }
    hasMention(exact);
    // group partial matches that share a message word: more than one item in a group means the message is ambiguous
    const groups = [];
    for (const h of partial) {
      const touching = groups.filter(g => [...h.matched].some(w => g.words.has(w)));
      const merged = { words: new Set(h.matched), hits: [h] };
      for (const g of touching) { g.words.forEach(w => merged.words.add(w)); merged.hits.push(...g.hits); groups.splice(groups.indexOf(g), 1); }
      groups.push(merged);
    }
    for (const g of groups) {
      // "the pasta one": a kind word in the message that fits exactly one of the candidates settles it
      if (g.hits.length > 1) { const kinds = words.filter(w => KINDS[stem(w)]); const fit = g.hits.filter(h => kinds.some(k => itemTokens(h.item.name).some(t => KINDS[stem(k)].includes(stem(t))))); if (fit.length === 1) g.hits = fit; }
      if (g.hits.length === 1) { resolved.push({ guestId, itemId: g.hits[0].item.id, msg }); hasMention(g.hits); }
      else { if (guestId) { ambiguous.push({ msg, guestId, text: m.text, itemIds: g.hits.map(h => h.item.id) }); spoke.add(guestId); } else for (const h of g.hits) claimed.add(h.item.id); }
    }
  });
  const silent = guests.filter(g => !spoke.has(g.id)).map(g => g.id);
  return { resolved, ambiguous, claimed: [...claimed], silent };
}

/** The attributed note plus the payer's answers and (lower priority) a short menu block, kept within the limit. */
export function buildFullNote({ messages, nameBySender, clarifications = [], restaurant = "", menuText = "", limit = 2000 }) {
  const clar = clarifications.join("\n");
  const chat = buildChatNote(messages, nameBySender, Math.max(200, limit - clar.length - 1));
  let note = [chat.note, clar].filter(Boolean).join("\n");
  let menuUsed = false;
  const menu = String(menuText || "").split(/\r?\n/).map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("; ");
  const room = limit - note.length - 1;
  if (menu && room > 80) {
    const head = "Menu context" + (restaurant ? " (" + restaurant.trim().slice(0, 60) + ")" : "") + ": ";
    const body = menu.length > room - head.length ? menu.slice(0, room - head.length - 1) + "…" : menu;
    note += "\n" + head + body; menuUsed = true;
  }
  return { note, used: chat.used, dropped: chat.dropped, menuUsed };
}

/** A plausible restaurant name from pasted receipt text: the first line that is not an item, total or date. */
export function guessRestaurant(receiptText, title = "") {
  for (const raw of String(receiptText || "").split(/\r?\n/).slice(0, 6)) {
    const line = raw.trim();
    if (!line || /\d+[.,]\d{2}\s*$/.test(line) || /\b(total|subtotal|tax|tip|gratuity|server|table|guest|check|order|date|receipt|visa|card)\b/i.test(line) || /^[\d\s\-\/:.,#]+$/.test(line)) continue;
    if (line.length >= 3 && line.length <= 60 && /\p{L}{3}/u.test(line)) return line;
  }
  return "";
}
export { tokens as chatTokens, itemTokens as chatItemTokens };
