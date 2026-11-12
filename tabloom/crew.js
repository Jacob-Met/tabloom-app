// Your people, repeat crews, nudges and balances. Lives beside home.js; reads the tables API and keeps the
// friends list on this device (localStorage), since PayPal has no public contacts API.
const PEOPLE = "tabloom.people", NUDGES = "tabloom.nudges";
const money = c => "$" + (c / 100).toFixed(2);
const esc = v => String(v).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const keyOf = n => String(n).trim().toLowerCase();
const initials = n => { const p = String(n).trim().split(/\s+/); return ((p[0]?.[0] || "?") + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase(); };
const hue = n => { let h = 7; for (const c of keyOf(n)) h = (h * 31 + c.charCodeAt(0)) % 12; return h; }; // class index: the page CSP forbids inline styles
const avatar = (n, cls = "") => '<span class="cr-av h' + hue(n) + ' ' + cls + '" aria-hidden="true">' + esc(initials(n)) + '</span>';

/** debts: [{from, to, cents}] -> fewest payments [{from, to, cents}] (greedy largest debtor to largest creditor). */
export function settle(debts) {
  const net = new Map();
  for (const d of debts || []) {
    const c = Math.round(Number(d.cents));
    if (!Number.isFinite(c) || c <= 0 || d.from === d.to) continue;
    net.set(d.from, (net.get(d.from) || 0) - c);
    net.set(d.to, (net.get(d.to) || 0) + c);
  }
  const order = (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1);
  const debtors = [...net].filter(([, v]) => v < 0).map(([k, v]) => [k, -v]).sort(order);
  const creditors = [...net].filter(([, v]) => v > 0).sort(order);
  const out = [];
  while (debtors.length && creditors.length) {
    const c = Math.min(debtors[0][1], creditors[0][1]);
    out.push({ from: debtors[0][0], to: creditors[0][0], cents: c });
    debtors[0][1] -= c; creditors[0][1] -= c;
    if (!debtors[0][1]) debtors.shift();
    if (!creditors[0][1]) creditors.shift();
    debtors.sort(order); creditors.sort(order);
  }
  return out;
}

if (typeof document !== "undefined" && document.getElementById("home")) {
  const $ = id => document.getElementById(id);
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || "") ?? d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
  let model = { people: new Map(), tables: [], debts: [] };

  async function gather() {
    const { tables } = await (await fetch("/tabloom/api/tables?table=legacy")).json();
    const shown = tables.filter(t => !t.sample);
    const states = await Promise.all(shown.map(t => fetch("/tabloom/api/state?table=" + encodeURIComponent(t.id)).then(r => r.json()).catch(() => null)));
    const people = new Map(), stored = load(PEOPLE, {});
    const person = n => { const k = keyOf(n); if (!people.has(k)) people.set(k, { key: k, name: String(n).trim(), dinners: 0, owes: 0 }); return people.get(k); };
    const out = [], debts = [];
    shown.forEach((t, i) => {
      const st = states[i]; if (!st) return;
      const bill = st.bill, dues = st.calculated?.dues || [];
      const names = bill.guests.map(g => g.name);
      names.forEach(n => person(n).dinners++);
      const stored2 = (() => { try { return localStorage.getItem("tabloom.payer." + t.id); } catch { return null; } })();
      const pg = bill.guests.find(g => stored2 && (g.id === stored2 || keyOf(g.name) === keyOf(stored2))) || bill.guests[0];
      const owing = [];
      for (const d of dues) {
        const pay = bill.payments?.[d.guestId], left = d.totalCents - d.paidCents;
        if (pg && d.guestId !== pg.id && left > 0) {
          debts.push({ from: keyOf(d.name), to: keyOf(pg.name), cents: left });
          if (pay && pay.status !== "captured") { owing.push({ name: d.name, cents: left, link: pay.approvalUrl || "" }); person(d.name).owes += left; }
        }
      }
      out.push({ id: t.id, title: t.title, names, owing, updatedAt: t.updatedAt });
    });
    for (const [k, v] of Object.entries(stored)) { const p = person(v.name || k); p.manual = true; }
    model = { people, tables: out, debts };
  }
  const contactOf = k => (load(PEOPLE, {})[k] || {}).contact || "";
  const handleLink = (c, cents) => {
    if (!c || c.includes("@")) return "";
    const h = c.replace(/^https?:\/\/(www\.)?paypal\.me\//i, "").replace(/^@/, "").replace(/\/.*$/, "");
    return h ? "https://paypal.me/" + encodeURIComponent(h) + (cents ? "/" + (cents / 100).toFixed(2) : "") : "";
  };
  const display = k => model.people.get(k)?.name || k;

  function renderCrew() {
    const el = $("crew"), ppl = [...model.people.values()].sort((a, b) => b.dinners - a.dinners || a.name.localeCompare(b.name));
    el.hidden = false;
    el.innerHTML = '<h2 class="cr-h">Your people</h2><div class="cr-strip">' + ppl.map(p =>
      '<button type="button" class="cr-chip" data-crew="' + esc(p.key) + '">' + avatar(p.name) + '<span>' + esc(p.name.split(/\s+/)[0]) + '</span>' + (p.owes ? '<i class="cr-dot" title="Owes"></i>' : '') + '</button>').join("") +
      '<button type="button" class="cr-chip cr-add" id="crew-add">' + '<span class="cr-av cr-plus" aria-hidden="true">+</span><span>Add</span></button></div>';
  }
  function openCard(key) {
    const p = key ? model.people.get(key) : null, card = $("crew-card");
    const contact = key ? contactOf(key) : "";
    card.hidden = false;
    card.innerHTML = '<div class="cr-back" data-cr-close></div><div class="cr-pane" role="dialog" aria-label="' + (p ? esc(p.name) : "Add a person") + '">' +
      (p ? '<div class="cr-top">' + avatar(p.name, "big") + '<div><strong>' + esc(p.name) + '</strong><small>' + p.dinners + (p.dinners === 1 ? " dinner" : " dinners") + ' together</small></div></div>' +
        '<p class="cr-owe ' + (p.owes ? "has" : "") + '">' + (p.owes ? "Currently owes " + money(p.owes) : "Nothing owed right now") + '</p>'
        : '<label class="cr-lbl">Name<input id="crew-name" maxlength="40" autocomplete="off" placeholder="Camille"></label>') +
      '<label class="cr-lbl">PayPal email or PayPal.Me handle<input id="crew-contact" maxlength="120" autocomplete="off" placeholder="camille@example.com or camille" value="' + esc(contact) + '"></label>' +
      '<div class="cr-actions"><button type="button" class="cr-ghost" data-cr-close>Close</button><button type="button" class="cr-solid" id="crew-save" data-key="' + esc(key || "") + '">Save</button></div></div>';
    (p ? $("crew-contact") : $("crew-name")).focus();
  }
  function renderSuggest() {
    const el = $("crew-suggest"); if (!el) return;
    const seen = new Set(), groups = [];
    for (const t of model.tables) {
      const k = t.names.map(keyOf).sort().join("|");
      if (t.names.length >= 2 && !seen.has(k)) { seen.add(k); groups.push(t.names); }
    }
    const ppl = [...model.people.values()].sort((a, b) => b.dinners - a.dinners || a.name.localeCompare(b.name)).slice(0, 8);
    el.hidden = !groups.length && !ppl.length;
    el.innerHTML = '<span class="cr-sl">Same crew?</span><div class="cr-strip">' +
      groups.slice(0, 3).map(g => '<button type="button" class="cr-chip cr-group" data-crew-group="' + esc(g.join("\n")) + '"><span class="cr-stack">' + g.slice(0, 3).map(n => avatar(n)).join("") + '</span><span>' + esc(g.join(", ")) + '</span></button>').join("") +
      ppl.map(p => '<button type="button" class="cr-chip" data-crew-person="' + esc(p.name) + '">' + avatar(p.name) + '<span>' + esc(p.name.split(/\s+/)[0]) + '</span></button>').join("") + '</div>';
  }
  function renderBalances() {
    const el = $("balances"), rows = settle(model.debts);
    el.hidden = !rows.length;
    el.innerHTML = rows.length ? '<h2 class="cr-h">Between you</h2><ul class="cr-bal">' + rows.map(r =>
      '<li data-bal="' + esc(r.from + ">" + r.to) + '">' + avatar(display(r.from)) + '<span class="cr-who">' + esc(display(r.from)) + ' <b>→</b> ' + esc(display(r.to)) + '</span><strong>' + money(r.cents) + '</strong></li>').join("") + '</ul>' : "";
  }
  const ago = ts => { const d = Math.floor((Date.now() - ts) / 864e5); return d <= 0 ? "today" : d === 1 ? "yesterday" : d + " days ago"; };
  function decorateCards() {
    const nudges = load(NUDGES, {});
    for (const a of document.querySelectorAll("[data-home-table]")) {
      const li = a.closest("li"), t = model.tables.find(x => x.id === a.dataset.homeTable);
      li.querySelector(".cr-owing")?.remove();
      if (!t || !t.owing.length) continue;
      const row = document.createElement("div"); row.className = "cr-owing";
      row.innerHTML = '<span class="cr-stack">' + t.owing.slice(0, 5).map(o => avatar(o.name)).join("") + '</span><span class="cr-owtxt">' + esc(t.owing.map(o => o.name.split(/\s+/)[0]).join(", ")) + ' still ' + (t.owing.length === 1 ? "owes" : "owe") + '</span>' +
        '<span class="cr-nwrap"><button type="button" class="cr-nudge" data-nudge="' + esc(t.id) + '">Nudge</button><small class="cr-nstat" data-nstat="' + esc(t.id) + '">' + (nudges[t.id] ? "Nudged " + esc(ago(nudges[t.id])) : "") + '</small></span>';
      li.append(row);
    }
  }
  function remindersFor(t) {
    return t.owing.map(o => {
      const link = o.link || handleLink(contactOf(keyOf(o.name)), o.cents);
      return "Hey " + o.name.split(/\s+/)[0] + ", " + money(o.cents) + " for " + t.title + (link ? ": " + link : " (on PayPal)");
    });
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
    const ta = document.createElement("textarea"); ta.value = text; ta.style.cssText = "position:fixed;opacity:0"; document.body.append(ta); ta.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch { /* none */ } ta.remove(); return ok;
  }
  async function nudge(id, btn) {
    const t = model.tables.find(x => x.id === id); if (!t) return;
    const msgs = remindersFor(t), text = msgs.join("\n\n"), n = msgs.length, word = n === 1 ? "reminder" : "reminders";
    const stat = document.querySelector('[data-nstat="' + CSS.escape(id) + '"]');
    let done = "";
    if (navigator.share) { try { await navigator.share({ text }); done = "Shared " + n + " " + word; } catch (e) { if (e && e.name === "AbortError") return; } }
    if (!done && await copyText(text)) done = "Copied " + n + " " + word;
    if (!done) done = "Could not copy";
    else { const all = load(NUDGES, {}); all[id] = Date.now(); save(NUDGES, all); }
    btn.textContent = done; btn.classList.add("done");
    if (stat) stat.textContent = done.startsWith("Could") ? "" : "Nudged today";
    setTimeout(() => { btn.textContent = "Nudge"; btn.classList.remove("done"); }, 2600);
  }

  function mount() {
    const home = $("home"), list = $("home-list");
    const crew = Object.assign(document.createElement("section"), { id: "crew", hidden: true }); crew.setAttribute("aria-label", "Your people");
    const bal = Object.assign(document.createElement("section"), { id: "balances", hidden: true }); bal.setAttribute("aria-label", "Between you");
    const card = Object.assign(document.createElement("div"), { id: "crew-card", hidden: true });
    list.before(crew); list.after(bal); document.body.append(card);
    const sheet = $("add-meal-sheet"), field = $("add-meal-guests")?.closest("label");
    if (sheet && field) { const s = Object.assign(document.createElement("div"), { id: "crew-suggest", hidden: true }); field.before(s); }
    document.addEventListener("click", e => {
      const t = e.target; if (!t.closest) return;
      let b;
      if ((b = t.closest("[data-crew]"))) openCard(b.dataset.crew);
      else if (t.closest("#crew-add")) openCard(null);
      else if (t.closest("[data-cr-close]")) $("crew-card").hidden = true;
      else if ((b = t.closest("#crew-save"))) {
        const all = load(PEOPLE, {}); let key = b.dataset.key;
        if (!key) { const n = $("crew-name").value.trim(); if (!n) { $("crew-name").focus(); return; } key = keyOf(n); all[key] = { name: n }; }
        all[key] = { ...(all[key] || { name: display(key) }), contact: $("crew-contact").value.trim() };
        save(PEOPLE, all); $("crew-card").hidden = true; refresh();
      }
      else if ((b = t.closest("[data-nudge]"))) { e.preventDefault(); nudge(b.dataset.nudge, b); }
      else if ((b = t.closest("[data-crew-group]"))) fill(b.dataset.crewGroup.split("\n"), true);
      else if ((b = t.closest("[data-crew-person]"))) fill([b.dataset.crewPerson], false);
    });
    document.addEventListener("keydown", e => { if (e.key === "Escape") $("crew-card").hidden = true; });
    new MutationObserver(() => refresh()).observe(list, { childList: true });
    if (sheet) new MutationObserver(() => { if (!sheet.hidden) renderSuggest(); }).observe(sheet, { attributes: true, attributeFilter: ["hidden"] });
    refresh();
  }
  function fill(names, replace) {
    const ta = $("add-meal-guests"), have = ta.value.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    const next = replace ? names : [...have, ...names.filter(n => !have.some(h => keyOf(h) === keyOf(n)))];
    ta.value = next.join("\n"); ta.dispatchEvent(new Event("input", { bubbles: true })); ta.focus();
  }
  let busy = false, again = false;
  async function refresh() {
    if (busy) { again = true; return; }
    busy = true;
    try { await gather(); renderCrew(); renderBalances(); decorateCards(); renderSuggest(); } catch { /* home still works without it */ }
    busy = false; if (again) { again = false; refresh(); }
  }
  mount();
}
