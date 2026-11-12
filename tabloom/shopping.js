// Shopping run: one buyer paid for everything; the buyer says whose things are whose. Pure matching lives in
// analyzeHaul (no DOM); the browser wiring at the bottom only runs in a table that was added as a shopping run.
import { wordsMatch, chatTokens, chatItemTokens } from "./chat-intake.js";

const SAY_STOP = new Set(("goes gets get going give giving gave take takes taking wants want belongs belong everything else rest mom mum mother mommy grandma grandpa hers him them she they their theirs his out also please okay yeah").split(" "));
const SELF = /\b(mine|me|my|myself|i|i'm|i'll|i've)\b/;
const OTHER = /\b(your mom|your mum|mom|mum|mother|mommy|her|hers|she|him|his|he|them|their|theirs|they)\b/;
const REST = /\b(everything else|all the rest|the rest|all else|everything other)\b/;
const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const lc = s => String(s).normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

/** people: [{id,name}] items: [{id,name}] lines: [{text}|string]. Buyer defaults to people[0]. */
export function analyzeHaul({ lines, people, items, buyerId }) {
  const buyer = buyerId || people[0]?.id, others = people.filter(p => p.id !== buyer);
  const itemToks = items.map(i => chatItemTokens(i.name));
  const nameRes = people.map(p => ({ id: p.id, re: new RegExp("\\b" + esc(lc(p.name).trim().split(/\s+/)[0]) + "\\b"), toks: lc(p.name).split(/\s+/) }));
  const nameStop = new Set([...SAY_STOP, ...nameRes.flatMap(n => n.toks)]);
  const assigned = new Map(), assign = [], unsure = [];
  let lastNamed = null;
  const put = (itemId, personId, line) => { assigned.set(itemId, personId); const k = assign.findIndex(a => a.itemId === itemId); const e = { itemId, personId, line }; if (k >= 0) assign[k] = e; else assign.push(e); };

  const sentences = [];
  (lines || []).forEach((l, i) => String(l && l.text != null ? l.text : l).split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean).forEach(s => sentences.push({ s, line: i })));

  for (const { s, line } of sentences) {
    const text = lc(s);
    // Who: a name first (earliest in the sentence), then "mine"/"I", then relation words when two people.
    let who = null, pos = Infinity;
    for (const n of nameRes) { const m = n.re.exec(text); if (m && m.index < pos) { pos = m.index; who = n.id; } }
    if (!who) {
      const mine = SELF.exec(text), other = people.length === 2 ? OTHER.exec(text) : null;
      if (mine && (!other || mine.index < other.index)) who = buyer;
      else if (other) who = others[0]?.id || null;
      else if (/\b(hers|his|him|them|her|theirs)\b/.test(text) && lastNamed) who = lastNamed;
    }
    if (who) lastNamed = who;
    const rest = REST.test(text);
    const body = text.replace(REST, " ");
    const found = [], failed = [];
    for (const phrase of body.split(/\s*(?:,|&|;|\band\b)\s*/)) {
      const ts = chatTokens(phrase, nameStop);
      if (!ts.length) continue;
      const score = itemToks.map(it => ts.filter(t => it.some(w => wordsMatch(t, w))).length);
      const top = Math.max(0, ...score), ids = items.filter((_, k) => top > 0 && score[k] === top).map(i => i.id);
      if (ids.length === 1) found.push(ids[0]); else failed.push({ text: phrase.trim(), itemIds: ids });
    }
    for (const f of failed) unsure.push({ line, text: s, itemIds: f.itemIds, phrase: f.text });
    if (who) { for (const id of found) put(id, who, s); if (rest) for (const it of items) if (!assigned.has(it.id)) put(it.id, who, s); }
    else if (found.length) unsure.push({ line, text: s, itemIds: found, phrase: "" });
  }
  const defaulted = items.filter(i => !assigned.has(i.id)).map(i => i.id);
  return { assign, unsure, defaulted };
}

// ---------- browser wiring ----------
const KEY = "tabloom:kind:", PENDING = "tabloom:pending-kind";
const $ = id => document.getElementById(id);
const safe = f => { try { return f(); } catch { return null; } };
export function kindFor(tableId) {
  let k = safe(() => localStorage.getItem(KEY + tableId));
  if (!k) { k = safe(() => sessionStorage.getItem(PENDING)) || ""; if (k) { safe(() => sessionStorage.removeItem(PENDING)); safe(() => localStorage.setItem(KEY + tableId, k)); } }
  return k === "shopping" ? "shopping" : "dinner";
}
const money = c => "$" + (c / 100).toFixed(2);
const h = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function initBrowser() {
  const tableId = new URLSearchParams(location.search).get("table");
  if (!tableId || typeof document === "undefined") return;
  const kind = kindFor(tableId);
  document.body.dataset.kind = kind;
  if (kind !== "shopping") return;
  let rows = [], people = [];

  const guestsHead = [...document.querySelectorAll(".subheading h3")].find(e => /^guests$/i.test(e.textContent.trim())); if (guestsHead) guestsHead.textContent = "People";
  const vs = document.querySelector("#voice-intake > summary"); if (vs) vs.textContent = "Film the haul";
  const vh = document.querySelector("#voice-intake .voice-help"); if (vh) vh.textContent = "Point at things and say who they are for. Anything you do not mention stays yours.";
  const rec = $("voice-record"); if (rec) rec.dataset.shop = "1";

  const card = document.createElement("details");
  card.className = "assistant-card haul-card"; card.id = "haul-card"; card.open = true;
  card.innerHTML = '<summary>Whose is what</summary><p class="haul-help">The first person is the buyer. Say it out loud above, or type what you said.</p>' +
    '<label class="note-field">OR TYPE WHAT YOU SAID<textarea id="haul-text" rows="3" placeholder="The paper towels and the salmon are for your mom. The coffee is hers too. Everything else is mine."></textarea></label>' +
    '<button type="button" id="haul-read" class="outline">READ IT <span>↗</span></button><div id="haul-result" class="haul-result" hidden></div>';
  const anchor = $("voice-intake"); (anchor || $("chat-intake") || $("items")).after(card);

  const readPeople = () => [...document.querySelectorAll("#guests .guest-name")].map(i => ({ id: i.dataset.guest, name: i.value.trim() })).filter(p => p.id && p.name);
  const readItems = () => [...document.querySelectorAll("#items .item")].map(r => ({ id: r.dataset.item, name: r.querySelector(".item-name").value.trim(), cents: Math.round(parseFloat(r.querySelector(".item-cents").value || "0") * 100) || 0 }));

  function run(lines) {
    people = readPeople(); const items = readItems(), out = $("haul-result");
    out.hidden = false;
    if (people.length < 2 || !items.length) { out.innerHTML = '<p class="haul-note">Add the receipt items first (import the receipt above), then read this again.</p>'; rows = []; return; }
    const res = analyzeHaul({ lines, people, items, buyerId: people[0].id });
    const by = new Map(res.assign.map(a => [a.itemId, a])), uns = new Map();
    for (const u of res.unsure) for (const id of u.itemIds) if (!by.has(id) || by.get(id).line !== u.line) uns.set(id, u);
    rows = items.map(it => ({ it, who: by.get(it.id)?.personId || people[0].id, said: by.get(it.id)?.line || "", unsure: uns.get(it.id)?.text || "" }));
    const stray = res.unsure.filter(u => !u.itemIds.length);
    draw(stray);
  }
  function draw(stray = []) {
    const out = $("haul-result"), idx = id => Math.max(0, people.findIndex(p => p.id === id));
    out.innerHTML = '<h3>Whose is what</h3><ul class="haul-list">' + rows.map((r, i) => {
      const shared = r.who === "shared", nm = shared ? "Shared" : people.find(p => p.id === r.who)?.name || "?";
      return '<li class="haul-row' + (r.unsure ? " unsure" : "") + '" data-haul-item="' + i + '"><span class="haul-main"><strong>' + h(r.it.name) + '</strong>' +
        (r.said ? '<small>“' + h(r.said) + '”</small>' : '<small class="dim">not mentioned, so yours</small>') +
        (r.unsure ? '<small class="warn">Not sure about: “' + h(r.unsure) + '”. Tap to choose.</small>' : '') + '</span>' +
        '<span class="haul-price">' + money(r.it.cents) + '</span><button type="button" class="haul-pill" data-haul-pill="' + i + '" data-c="' + (shared ? "s" : idx(r.who) % 6) + '" aria-label="' + h(r.it.name) + ' is for ' + h(nm) + '. Tap to change.">' + h(nm) + '</button></li>';
    }).join("") + '</ul>' + (stray.length ? '<p class="haul-note warn">Could not match: ' + stray.map(s => "“" + h(s.phrase) + "”").join(", ") + '. Tap the pills below to fix it by hand.</p>' : '') +
      '<button type="button" id="haul-apply" class="primary">Looks right</button>';
  }
  $("haul-result").addEventListener("click", e => {
    const pill = e.target.closest("[data-haul-pill]");
    if (pill) { const r = rows[+pill.dataset.haulPill], order = [...people.map(p => p.id), "shared"]; r.who = order[(order.indexOf(r.who) + 1) % order.length]; r.unsure = ""; return draw(); }
    if (e.target.closest("#haul-apply")) apply();
  });
  $("haul-read").addEventListener("click", () => { const t = $("haul-text").value.trim(); if (t) run([{ text: t }]); });

  function setShare(itemId, guestId, on) {
    const find = () => [...document.querySelectorAll("input[data-share]")].find(i => i.dataset.share === itemId && i.value === guestId);
    let box = find();
    if (!box) { [...document.querySelectorAll("[data-edit-owners]")].find(b => b.dataset.editOwners === itemId)?.click(); box = find(); }
    if (!box || box.checked === on) return;
    box.checked = on; box.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function apply() {
    for (const r of rows) {
      const want = r.who === "shared" ? people.map(p => p.id) : [r.who];
      for (const g of want) setShare(r.it.id, g, true);
      for (const p of people) if (!want.includes(p.id)) setShare(r.it.id, p.id, false);
    }
    $("save")?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  // Voice: lines from the listener come from one speaker (the buyer), so no "who said this" chips.
  const vl = $("voice-lines");
  if (vl) {
    let t = null;
    new MutationObserver(() => {
      clearTimeout(t); t = setTimeout(() => {
        const lines = [...vl.querySelectorAll("[data-voice-line] .voice-line-text")].map(p => ({ text: p.textContent }));
        if (lines.length) { $("haul-text").value = lines.map(l => l.text).join(" "); run(lines); }
      }, 150);
    }).observe(vl, { childList: true });
  }
}
if (typeof document !== "undefined") initBrowser();
