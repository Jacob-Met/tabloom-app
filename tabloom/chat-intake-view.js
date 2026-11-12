// Group-chat intake UI: paste the chat, match senders to guests, hand an attributed note to the existing split review,
// and copy the per-guest PayPal requests back out for the chat.
import { parseChat, senderList, matchSenders, buildChatNote, buildGroupMessage, buildGuestMessage } from "./chat-intake.js";
const norm = text => String(text).normalize("NFKD").replace(/\p{M}/gu, "").trim().toLowerCase().replace(/\s+/g, " ");
const esc = value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const $ = id => document.getElementById(id);

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const area = document.createElement("textarea");
  area.value = text; area.setAttribute("readonly", ""); area.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  document.body.append(area); area.select();
  let ok = false; try { ok = document.execCommand("copy"); } catch {}
  area.remove(); return ok;
}

export function initChatIntake({ getDraft, addGuests, setNote, startSuggest }) {
  let messages = [], assign = {}; // assign: normalized sender -> guest id, or "" to ignore
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
      '<details class="chat-preview"><summary>What the model will read (' + used + ' messages)</summary><pre id="chat-note-preview">' + esc(buildChatNote(messages, nameMap()).note) + '</pre></details>' +
      '<button type="button" id="chat-suggest" class="primary"' + (used ? "" : " disabled") + '>SUGGEST SPLITS FROM THE CHAT <span>↗</span></button>';
  }
  function nameMap() {
    const out = {}, guests = getDraft().guests;
    for (const [key, id] of Object.entries(assign)) { const g = guests.find(g => g.id === id); if (g) out[key] = g.name; }
    return out;
  }
  function read() {
    messages = parseChat($("chat-text").value);
    if (!messages.length) { status("No messages found. Paste lines like “Camille: I had the sea bass”."); render(); return; }
    const senders = senderList(messages).map(s => s.sender);
    const { matched } = matchSenders(senders, getDraft().guests);
    assign = matched;
    status("");
    render();
  }
  $("chat-read").addEventListener("click", read);
  $("chat-result").addEventListener("change", event => {
    const select = event.target.closest("[data-chat-sender]"); if (!select) return;
    assign[select.dataset.chatSender] = select.value; render();
    $("chat-senders").querySelector('[data-chat-sender="' + CSS.escape(select.dataset.chatSender) + '"]')?.focus();
  });
  $("chat-result").addEventListener("click", event => {
    if (event.target.closest("#chat-create-guests")) {
      const names = senderList(messages).map(s => s.sender.split(" ").slice(0, 2).join(" ")).slice(0, 12);
      addGuests(names); const { matched } = matchSenders(senderList(messages).map(s => s.sender), getDraft().guests); assign = matched; render(); return;
    }
    if (event.target.closest("#chat-suggest")) {
      const built = buildChatNote(messages, nameMap());
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
