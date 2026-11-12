// Group-chat intake UI: paste the chat, match senders to guests, hand an attributed note to the existing split review,
// and copy the per-guest PayPal requests back out for the chat.
import { parseChat, senderList, matchSenders, buildFullNote, analyzeChat, guessRestaurant, buildGroupMessage, buildGuestMessage } from "./chat-intake.js";
const norm = text => String(text).normalize("NFKD").replace(/\p{M}/gu, "").trim().toLowerCase().replace(/\s+/g, " ");
const esc = value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const $ = id => document.getElementById(id);
const slug = text => norm(text).replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "x";
const join = names => names.length < 2 ? names.join("") : names.slice(0, -1).join(", ") + " and " + names.at(-1);

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const area = document.createElement("textarea");
  area.value = text; area.setAttribute("readonly", ""); area.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  document.body.append(area); area.select();
  let ok = false; try { ok = document.execCommand("copy"); } catch {}
  area.remove(); return ok;
}

export function initChatIntake({ getDraft, addGuests, setNote, startSuggest }) {
  let messages = [], assign = {}, answers = {}, restaurantTyped = false; // assign: normalized sender -> guest id, or "" to ignore; answers: clarify card key -> choice(s)
  const status = text => { $("chat-status").textContent = text; };

  function render() {
    const draft = getDraft(), box = $("chat-result");
    if (!messages.length) { box.hidden = true; box.replaceChildren(); return; }
    const senders = senderList(messages);
    const guests = draft.guests;
    const noGuests = !guests.length;
    const unmatched = senders.filter(s => !assign[norm(s.sender)]);
    const rows = senders.map(s => {
      const key = norm(s.sender), chosen = assign[key] || "";
      const options = '<option value="">Not at the table (ignore)</option>' + guests.map(g => '<option value="' + esc(g.id) + '"' + (g.id === chosen ? " selected" : "") + ">" + esc(g.name) + "</option>").join("");
      return '<li class="chat-sender' + (chosen ? "" : " unmatched") + '"><span class="chat-sender-name"><strong>' + esc(s.sender) + "</strong><small>" + s.count + (s.count === 1 ? " message" : " messages") + '</small></span><label><span class="sr-only">Who is ' + esc(s.sender) + "?</span><select data-chat-sender=\"" + esc(key) + '">' + options + "</select></label></li>";
    }).join("");
    const used = messages.filter(m => assign[norm(m.sender)]).length;
    box.hidden = false;
    box.innerHTML = '<h3 id="chat-summary">' + messages.length + " messages from " + senders.length + (senders.length === 1 ? " person" : " people") + "</h3>" +
      (noGuests ? '<p class="chat-hint">This table has no guests yet.</p><button type="button" id="chat-create-guests" class="outline">CREATE GUESTS FROM THE CHAT</button>' : "") +
      '<ul class="chat-senders" id="chat-senders">' + rows + "</ul>" +
      (unmatched.length && !noGuests ? '<p class="chat-hint" id="chat-unmatched">Not matched yet: ' + unmatched.map(s => esc(s.sender)).join(", ") + ". Pick the guest they are, or leave them out.</p>" : "") +
      '<div id="chat-clarify" class="chat-clarify"></div>' +
      '<details class="chat-preview"><summary>What the model will read (' + used + ' messages)</summary><pre id="chat-note-preview">' + esc(fullNote().note) + '</pre></details>' +
      '<button type="button" id="chat-suggest" class="primary"' + (used ? "" : " disabled") + '>SUGGEST SPLITS FROM THE CHAT <span>↗</span></button>';
    renderClarify();
  }
  // ---- Clear this up ----
  const guestName = id => getDraft().guests.find(g => g.id === id)?.name || "";
  function analysis() {
    const draft = getDraft(), owner = {};
    for (const [key, id] of Object.entries(assign)) if (id) owner[key] = id;
    return analyzeChat({ messages, ownerBySender: owner, guests: draft.guests, items: draft.items, menuText: $("chat-menu").value });
  }
  // Cards for the current chat: [{ key, kind, ... }] plus the explicit lines for every answered card.
  function cards() {
    const draft = getDraft(), items = draft.items, a = analysis();
    const itemSlugs = new Map(), used = new Set();
    items.forEach(it => { let s = slug(it.name); while (used.has(s)) s += "-2"; used.add(s); itemSlugs.set(it.id, s); });
    const name = id => items.find(i => i.id === id)?.name || "";
    const out = [], lines = [], claimed = new Set(a.claimed), open = new Set();
    for (const amb of a.ambiguous) {
      const key = "ambiguous:m" + amb.msg, ans = answers[key], who = guestName(amb.guestId);
      const choices = amb.itemIds.map(id => ({ value: itemSlugs.get(id), label: name(id), id }));
      choices.push({ value: "both", label: amb.itemIds.length > 2 ? "All of them" : "Both" }, { value: "unsure", label: "Not sure, ask them" });
      out.push({ key, kind: "ambiguous", title: who + " said “" + amb.text + "”. Which one?", choices, answer: ans ? [ans] : [] });
      if (!ans) amb.itemIds.forEach(id => open.add(id));
      else if (ans === "unsure") { amb.itemIds.forEach(id => open.add(id)); lines.push("Clarified by the payer: not sure which of " + join(amb.itemIds.map(name)) + " " + who + " had; leave it for the payer to choose."); }
      else if (ans === "both") { amb.itemIds.forEach(id => claimed.add(id)); lines.push("Clarified by the payer: " + who + " had " + (amb.itemIds.length > 2 ? "all of " : "both ") + join(amb.itemIds.map(name)) + "."); }
      else { const id = amb.itemIds.find(id => itemSlugs.get(id) === ans); if (id) { claimed.add(id); lines.push("Clarified by the payer: " + who + " had the " + name(id) + "."); } }
    }
    const DRINK = /\b(beer|ale|lager|wine|prosecco|champagne|cocktail|margarita|mojito|spritz|tea|coffee|latte|espresso|soda|cola|coke|water|juice|lemonade|drink|sake|whisky|whiskey|gin|rum|vodka|smoothie)\b/i;
    const loose = items.filter(it => !(claimed.has(it.id) || open.has(it.id) || !messages.length));
    const drinks = loose.filter(it => DRINK.test(it.name)), groupDrinks = drinks.length >= 2;
    const guestChoices = () => getDraft().guests.map(g => ({ value: slug(g.name), label: g.name, id: g.id }));
    const lineFor = (it, ans) => {
      const choices = guestChoices(), chosen = choices.filter(c => ans.includes(c.value));
      if (ans.includes("everyone")) return "Clarified by the payer: the " + it.name + " was split between everyone.";
      if (chosen.length === 1) return "Clarified by the payer: the " + it.name + " was " + chosen[0].label + "’s.";
      if (chosen.length) return "Clarified by the payer: the " + it.name + " was shared by " + join(chosen.map(c => c.label)) + ".";
      return "";
    };
    for (const it of loose) {
      if (groupDrinks && drinks.includes(it)) continue;
      const key = "unclaimed:" + itemSlugs.get(it.id), ans = answers[key] || [];
      const choices = guestChoices(); choices.push({ value: "everyone", label: "Split between everyone" });
      out.push({ key, kind: "unclaimed", multi: true, title: "Nobody claimed: " + it.name + ". Who had it?", choices, answer: ans });
      const line = lineFor(it, ans); if (line) lines.push(line);
    }
    if (groupDrinks) {
      const rows = drinks.map(it => { const key = "unclaimed:" + itemSlugs.get(it.id), ans = answers[key] || []; const choices = guestChoices(); choices.push({ value: "everyone", label: "Split between everyone" }); const line = lineFor(it, ans); if (line) lines.push(line); return { key, title: it.name, choices, answer: ans }; });
      out.push({ key: "drinks:nobody-mentioned", kind: "drinks", title: "Drinks nobody mentioned", rows, answer: rows.flatMap(r => r.answer) });
    }
    for (const id of a.silent) out.push({ key: "silent:" + slug(guestName(id)), kind: "silent", title: guestName(id) + " has not said what they had", hint: "Ask them in the chat, or tick their dishes in the review. This does not hold anything up." });
    return { cards: out, lines };
  }
  function fullNote() {
    return buildFullNote({ messages, nameBySender: nameMap(), clarifications: cards().lines, restaurant: $("chat-restaurant").value, menuText: $("chat-menu").value });
  }
  function renderClarify() {
    const box = $("chat-clarify"); if (!box) return;
    const { cards: list } = cards();
    const todo = list.filter(c => c.kind !== "silent" && (c.kind === "drinks" ? c.rows.some(r => !r.answer.length) : !c.answer.length)).length;
    if (!list.length) { box.hidden = true; box.replaceChildren(); return; }
    box.hidden = false;
    box.innerHTML = '<h3>Clear this up</h3><p class="chat-hint">' + (todo ? "A few things the chat left open. Tap an answer, or skip a card and sort it out in the review." : "All cleared up. These answers go to the split as extra lines.") + "</p>" +
      list.map(c => {
        if (c.kind === "silent") return '<section class="clarify-card silent" data-clarify="' + esc(c.key) + '"><p class="clarify-title">' + esc(c.title) + "</p><p class=\"chat-hint\">" + esc(c.hint) + "</p></section>";
        if (c.kind === "drinks") return '<section class="clarify-card' + (c.rows.every(r => r.answer.length) ? " answered" : "") + '" data-clarify="' + esc(c.key) + '"><p class="clarify-title">' + esc(c.title) + '</p><p class="chat-hint">Drinks rarely get mentioned. Tap who had each one, or sort them out in the review.</p>' + c.rows.map(r => '<div class="clarify-drink" data-clarify-row="' + esc(r.key) + '"><p class="clarify-drink-name">' + esc(r.title) + '</p><div class="clarify-chips" role="group" aria-label="Who had ' + esc(r.title) + '">' + r.choices.map(ch => '<button type="button" class="clarify-chip" data-clarify-choice="' + esc(r.key.slice(10) + ":" + ch.value) + '" aria-pressed="' + r.answer.includes(ch.value) + '">' + esc(ch.label) + "</button>").join("") + "</div></div>").join("") + "</section>";
        return '<section class="clarify-card' + (c.answer.length ? " answered" : "") + '" data-clarify="' + esc(c.key) + '"><p class="clarify-title">' + esc(c.title) + '</p><div class="clarify-chips" role="group" aria-label="' + esc(c.title) + '">' +
          c.choices.map(ch => '<button type="button" class="clarify-chip" data-clarify-choice="' + esc(ch.value) + '" aria-pressed="' + (c.answer.includes(ch.value)) + '">' + esc(ch.label) + "</button>").join("") + "</div></section>";
      }).join("");
    const pre = $("chat-note-preview"); if (pre) pre.textContent = fullNote().note;
  }
  function restaurantGuess() {
    if (restaurantTyped) return;
    const found = guessRestaurant($("receipt-text")?.value || "") || ($("bill-title")?.value || "").trim();
    if (found) $("chat-restaurant").value = found;
  }
  function nameMap() {
    const out = {}, guests = getDraft().guests;
    for (const [key, id] of Object.entries(assign)) { const g = guests.find(g => g.id === id); if (g) out[key] = g.name; }
    return out;
  }
  function read() {
    messages = parseChat($("chat-text").value); answers = {};
    restaurantGuess();
    if (!messages.length) { status("No messages found. Paste lines like “Camille: I had the sea bass”."); render(); return; }
    const senders = senderList(messages).map(s => s.sender);
    const { matched } = matchSenders(senders, getDraft().guests);
    assign = matched;
    status("");
    render();
  }
  $("chat-read").addEventListener("click", read);
  $("chat-restaurant").addEventListener("input", () => { restaurantTyped = true; if (messages.length) renderClarify(); });
  $("chat-menu").addEventListener("input", () => { if (messages.length) renderClarify(); });
  $("chat-result").addEventListener("change", event => {
    const select = event.target.closest("[data-chat-sender]"); if (!select) return;
    assign[select.dataset.chatSender] = select.value; render();
    $("chat-senders").querySelector('[data-chat-sender="' + CSS.escape(select.dataset.chatSender) + '"]')?.focus();
  });
  $("chat-result").addEventListener("click", event => {
    const chip = event.target.closest("[data-clarify-choice]");
    if (chip) {
      const card = chip.closest("[data-clarify]"), key = card.dataset.clarify, value = chip.dataset.clarifyChoice;
      if (key.startsWith("drinks:")) {
        const i = value.indexOf(":"), rkey = "unclaimed:" + value.slice(0, i), v = value.slice(i + 1);
        let now = answers[rkey] || [];
        now = v === "everyone" ? (now.includes("everyone") ? [] : ["everyone"]) : now.filter(x => x !== "everyone");
        if (v !== "everyone") now = now.includes(v) ? now.filter(x => x !== v) : [...now, v];
        answers[rkey] = now;
      } else if (key.startsWith("unclaimed:")) {
        let now = answers[key] || [];
        now = value === "everyone" ? (now.includes("everyone") ? [] : ["everyone"]) : now.filter(v => v !== "everyone");
        if (value !== "everyone") now = now.includes(value) ? now.filter(v => v !== value) : [...now, value];
        answers[key] = now;
      } else answers[key] = answers[key] === value ? "" : value;
      renderClarify();
      $("chat-clarify").querySelector('[data-clarify="' + CSS.escape(key) + '"] [data-clarify-choice="' + CSS.escape(value) + '"]')?.focus({ preventScroll: true });
      return;
    }
    if (event.target.closest("#chat-create-guests")) {
      const names = senderList(messages).map(s => s.sender.split(" ").slice(0, 2).join(" ")).slice(0, 12);
      addGuests(names); const { matched } = matchSenders(senderList(messages).map(s => s.sender), getDraft().guests); assign = matched; render(); return;
    }
    if (event.target.closest("#chat-suggest")) {
      const built = fullNote();
      if (!built.used) { status("Pick a guest for at least one sender first."); return; }
      setNote(built.note);
      status(built.dropped ? built.dropped + " short messages left out to fit the 2,000 character limit." : "");
      startSuggest();
    }
  });
}

// Copy for the group chat: shown under Guest shares once saved dues exist.
export function renderChatCopy(saved) {
  const box = $("chat-copy"); if (!box) return;
  const dues = saved?.calculated?.dues || [], payments = saved?.bill?.payments || {};
  const rows = dues.map(d => ({ name: d.name, cents: d.totalCents, url: payments[d.guestId]?.approvalUrl, guestId: d.guestId }));
  const linked = rows.filter(r => r.url).length;
  if (!saved?.bill?.items?.length || !linked) { box.hidden = true; box.replaceChildren(); return; }
  const bill = saved.bill;
  const receiptCents = bill.items.reduce((n, i) => n + i.cents, 0) + bill.taxCents + bill.tipCents - (bill.discountCents || 0);
  const group = buildGroupMessage({ title: bill.title, rows, receiptCents });
  const waiting = rows.filter(r => !r.url && r.cents > 0).length;
  box.hidden = false;
  box.innerHTML = '<h3>Send it back to the group chat</h3><p class="chat-hint">One message with everyone’s amount and their own PayPal link.' + (waiting ? " " + waiting + " guest" + (waiting === 1 ? " has" : "s have") + " no request yet; they show as “request coming”." : "") + '</p>' +
    '<pre id="chat-copy-preview" class="chat-copy-preview">' + esc(group) + '</pre>' +
    '<button type="button" id="copy-group-chat" class="primary" data-text="' + esc(group) + '">COPY FOR THE GROUP CHAT <span>⧉</span></button>' +
    '<ul class="chat-copy-list">' + rows.map(r => '<li><span><strong>' + esc(r.name) + '</strong> · ' + (r.cents ? "$" + (r.cents / 100).toFixed(2) : "nothing to pay") + '</span><button type="button" class="outline" data-copy-guest="' + esc(r.guestId) + '" data-text="' + esc(buildGuestMessage({ title: bill.title, row: r })) + '" aria-label="Copy message for ' + esc(r.name) + '">COPY</button></li>').join("") + "</ul>" +
    '<p id="chat-copy-status" class="chat-hint" role="status" aria-live="polite"></p>';
}
document.addEventListener("click", async event => {
  const button = event.target.closest("#copy-group-chat,[data-copy-guest]"); if (!button) return;
  const ok = await copyText(button.dataset.text);
  const label = button.id === "copy-group-chat" ? "Copied. Paste it into the group chat." : "Copied " + button.getAttribute("aria-label").replace("Copy message for ", "") + "’s message.";
  const note = $("chat-copy-status"); if (note) note.textContent = ok ? label : "Could not copy automatically. Select the text above and copy it.";
});
