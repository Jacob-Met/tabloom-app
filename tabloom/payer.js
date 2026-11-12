// Who paid, one-tap fair rules, and the service-charge warning. Works from the DOM main.js renders.
const $ = id => document.getElementById(id);
const esc = v => String(v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = c => "$" + (c / 100).toFixed(2);
const parseMoney = t => { const m = String(t).replace(/,/g, "").match(/-?\$?\s*(\d+(?:\.\d+)?)/); return m ? Math.round(parseFloat(m[1]) * 100) : 0; };
const tableKey = () => "tabloom:payer:" + (new URLSearchParams(location.search).get("table") || "legacy");
const DRINK = /\b(beers?|wines?|teas?|coffees?|sodas?|water|cocktails?|juices?|sakes?|mimosas?|spritz|margaritas?|negronis?|lattes?|colas?|lemonades?|prosecco|champagne|whiskey|lager|ipa|ale)\b/i;
const ALCOHOL = /\b(beers?|wines?|sakes?|cocktails?|mimosas?|spritz|margaritas?|negronis?|prosecco|champagne|whiskey|lager|ipa|ale)\b/i;
const SERVICE = /gratuity|service\s*charge|svc\s*chg|serv\.?\s*chg|auto[\s-]*grat|(18|20)\s*%\s*(service|serv|svc)/i;

function guests() { // [{name, key}]
  const seen = new Set();
  return [...document.querySelectorAll("#guests input")].map(i => i.value.trim()).filter(n => n && !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase())).map(n => ({ name: n, key: n.toLowerCase() }));
}
const getPayer = gs => { let v = null; try { v = localStorage.getItem(tableKey()); } catch {} return gs.find(g => g.key === v) || gs[0]; };
const setPayer = key => { try { localStorage.setItem(tableKey(), key); } catch {} };

function put(el, html) { if (el.innerHTML !== html) el.innerHTML = html; }
function ensure(id, tag, cls, place) {
  let el = $(id); if (el) return el;
  el = document.createElement(tag); el.id = id; el.className = cls; place(el); return el;
}

// ---------- fair rules ----------
let rule = null, picked = new Set(), snapshot = null;
const itemRows = () => [...document.querySelectorAll("#items .item")];
const idToName = () => { const m = {}; document.querySelectorAll("#items input[data-share]").forEach(i => { m[i.value] = i.parentElement.textContent.trim().toLowerCase(); }); return m; };
function readState() { const s = new Map(); document.querySelectorAll("#items input[data-share]").forEach(i => s.set(i.dataset.share + "|" + i.value, i.checked)); return s; }
function setShare(itemId, gid, on) {
  const el = [...document.querySelectorAll("#items input[data-share]")].find(i => i.dataset.share === itemId && i.value === gid);
  if (el && el.checked !== on) { el.checked = on; el.dispatchEvent(new Event("change", { bubbles: true })); }
}
function applyDesired(fn) { // fn(itemName, ids, currentSet) -> Set of ids
  const names = idToName(), ids = Object.keys(names);
  const byItem = new Map();
  readState().forEach((on, k) => { const [it, g] = k.split("|"); if (!byItem.has(it)) byItem.set(it, new Set()); if (on) byItem.get(it).add(g); });
  const nameOf = row => row.querySelector(".item-name")?.value || "";
  for (const row of itemRows()) {
    const itemId = row.dataset.item, cur = byItem.get(itemId) || new Set();
    const want = fn(nameOf(row), ids, cur, names);
    if (!want) continue;
    for (const g of ids) setShare(itemId, g, want.has(g));
  }
}
function restore() {
  if (!snapshot) return;
  snapshot.forEach((on, k) => { const [it, g] = k.split("|"); setShare(it, g, on); });
  snapshot = null;
}
function runRule() {
  const names = idToName(), idOf = key => Object.keys(names).find(i => names[i] === key);
  const sel = [...picked].map(idOf).filter(Boolean);
  if (rule === "even") applyDesired((n, ids) => new Set(ids));
  else if (rule === "covered" && sel.length) applyDesired((n, ids, cur) => { const sub = new Set(sel); if (![...cur].some(g => sub.has(g))) return null; const others = ids.filter(g => !sub.has(g)); return others.length ? new Set(others) : null; });
  else if (rule === "drinks-on" && sel.length) applyDesired(n => DRINK.test(n) ? new Set([sel[0]]) : null);
  else if (rule === "no-alcohol" && sel.length) applyDesired((n, ids, cur) => { if (!ALCOHOL.test(n)) return null; const left = new Set([...cur].filter(g => !sel.includes(g))); return left.size ? left : null; });
}
function clearRule() { restore(); rule = null; picked = new Set(); }
const RULES = [["covered", "Someone’s covered", "Pick who’s being treated. The others split their items."], ["drinks-on", "Drinks on…", "Pick who’s buying the drinks."], ["no-alcohol", "Doesn’t drink", "Pick everyone who skips alcohol."], ["even", "Split everything evenly", ""]];
function renderRules() {
  const box = $("fair-rules"); if (!box) return;
  const gs = guests(), has = itemRows().length > 0;
  box.hidden = !has;
  const multi = rule === "no-alcohol", hint = RULES.find(r => r[0] === rule)?.[2] || "";
  put(box, '<div class="fr-label">Fair rules</div><div class="fr-pills">' + RULES.map(([k, l]) => '<button type="button" class="pill' + (rule === k ? " on" : "") + '" data-rule="' + k + '" aria-pressed="' + (rule === k) + '">' + l + '</button>').join("") + '</div>' +
    (rule && rule !== "even" ? '<div class="fr-pick" id="fair-pick"><span>' + esc(hint) + '</span><div class="fr-pills">' + gs.map(g => '<button type="button" class="pill small' + (picked.has(g.key) ? " on" : "") + '" data-fair-guest="' + esc(g.key) + '" aria-pressed="' + picked.has(g.key) + '">' + esc(g.name) + '</button>').join("") + '</div></div>' : "") +
    (rule ? '<div class="fr-undo"><span>' + (rule === "even" || picked.size ? "Applied." : "Choose someone.") + '</span><button type="button" class="text-button" data-fair-undo>Undo</button></div>' : ""));
}
document.addEventListener("click", e => {
  const r = e.target.closest("[data-rule]"), g = e.target.closest("[data-fair-guest]"), u = e.target.closest("[data-fair-undo]");
  if (!r && !g && !u) return;
  if (u || (r && rule === r.dataset.rule)) { clearRule(); renderRules(); return; }
  if (r) {
    clearRule(); rule = r.dataset.rule;
    if (rule === "even") { snapshot = readState(); runRule(); }
  } else {
    const k = g.dataset.fairGuest;
    if (snapshot) restore();
    if (rule === "no-alcohol") { picked.has(k) ? picked.delete(k) : picked.add(k); } else picked = new Set([k]);
    if (picked.size) { snapshot = readState(); runRule(); }
  }
  renderRules();
});

// ---------- payer ----------
function renderPicker() {
  const box = $("payer-pick"); if (!box) return;
  const gs = guests(); box.hidden = gs.length < 2;
  const p = getPayer(gs);
  put(box, '<div class="fr-label">Who paid?</div><div class="fr-pills">' + gs.map(g => '<button type="button" class="pill' + (p && p.key === g.key ? " on" : "") + '" data-payer="' + esc(g.key) + '" aria-pressed="' + (p && p.key === g.key) + '">' + esc(g.name) + '</button>').join("") + '</div>');
}
document.addEventListener("click", e => { const b = e.target.closest("[data-payer]"); if (!b) return; setPayer(b.dataset.payer); renderAll(); });

function renderShares() {
  const gs = guests(), p = getPayer(gs); if (!p) return;
  const cards = [...document.querySelectorAll("#payments .payment-card")];
  let total = 0, mine = 0;
  for (const c of cards) {
    const name = c.querySelector("h3")?.textContent.trim().toLowerCase();
    const amt = parseMoney(c.querySelector(".payment-amount strong")?.textContent || "0");
    total += amt;
    const isP = name === p.key;
    if (isP) mine = amt;
    if (isP !== c.hasAttribute("data-payer-row")) c.toggleAttribute("data-payer-row", isP);
    const actions = c.querySelector(".payment-actions");
    const note = actions?.querySelector(".payer-note");
    if (isP && actions && !note) actions.insertAdjacentHTML("afterbegin", '<div class="payer-note"><span class="payer-badge">Paid the bill</span><small>Their own share · nothing to request</small></div>');
    if (!isP && note) note.remove();
  }
  const sec = $("payments"); if (!sec) return;
  const sum = ensure("payer-summary", "p", "payer-summary", el => sec.before(el));
  sum.hidden = !cards.length;
  const text = cards.length ? p.name + " paid " + money(total) + ". The others owe them " + money(total - mine) + " in total." : "";
  if (sum.textContent !== text) sum.textContent = text;
  const pre = $("chat-copy-preview");
  if (pre) {
    const fix = t => t.split("\n").map(l => l.toLowerCase().startsWith(p.key) && /^\W*$/.test(l.slice(p.key.length, p.key.length + 1)) ? p.name + " paid the bill" : l).join("\n");
    const t = fix(pre.textContent); if (t !== pre.textContent) pre.textContent = t;
    const b = $("copy-group-chat"); if (b && b.dataset.text) { const d = fix(b.dataset.text); if (d !== b.dataset.text) b.dataset.text = d; }
  }
}

// ---------- gratuity ----------
const svcKey = () => "tabloom:service-charge:" + (new URLSearchParams(location.search).get("table") || "legacy");
function scanReceiptText() { // the importer asks for service-charge lines to be re-entered as tip/tax, so remember it from the pasted text
  const area = $("receipt-text"); if (!area || !area.value) return;
  let cents = 0;
  for (const line of area.value.split("\n")) if (SERVICE.test(line)) { const m = line.match(/(\d[\d,]*\.\d{2})\s*$/); if (m) cents += parseMoney(m[1]); }
  if (cents > 0) try { sessionStorage.setItem(svcKey(), String(cents)); } catch {}
}
document.addEventListener("input", e => { if (e.target.id === "receipt-text") scanReceiptText(); });
document.addEventListener("click", e => { if (e.target.closest("#preview-receipt,#use-receipt")) scanReceiptText(); }, true);
function renderGratuity() {
  const hit = itemRows().map(r => ({ n: r.querySelector(".item-name")?.value || "", c: parseMoney(r.querySelector(".item-cents")?.value || "0") })).filter(x => SERVICE.test(x.n) && x.c > 0);
  let svc = hit.reduce((n, x) => n + x.c, 0);
  if (!svc && itemRows().length) { try { svc = Number(sessionStorage.getItem(svcKey())) || 0; } catch {} }
  let card = $("gratuity-warning");
  if (!svc) { card?.remove(); return; }
  const tip = parseMoney($("tip")?.value || "0");
  if (!card) card = ensure("gratuity-warning", "div", "gratuity-warning", el => { el.setAttribute("role", "status"); ($("fair-rules") || $("items")).after(el); });
  put(card, '<span class="gw-icon" aria-hidden="true">!</span><div><strong>This receipt already includes a ' + money(svc) + ' service charge.</strong> You probably don’t need to tip again.' + (tip > 0 ? '<span class="gw-tip">Tip currently set: ' + money(tip) + '</span>' : "") + '</div>');
}

function renderAll() { renderPicker(); renderRules(); renderShares(); renderGratuity(); }
function mount() {
  const left = document.querySelector(".left"), items = $("items"); if (!left || !items) return setTimeout(mount, 100);
  ensure("payer-pick", "section", "payer-pick fair-card", el => left.prepend(el));
  ensure("fair-rules", "section", "fair-rules fair-card", el => items.before(el));
  renderAll();
  let t = 0;
  const go = () => { clearTimeout(t); t = setTimeout(() => { obs.disconnect(); try { renderAll(); } finally { obs.observe(document.querySelector("main.shell"), { childList: true, subtree: true }); } }, 60); };
  const obs = new MutationObserver(go);
  obs.observe(document.querySelector("main.shell"), { childList: true, subtree: true });
  document.addEventListener("input", go); document.addEventListener("change", go);
}
mount();
