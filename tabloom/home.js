// Home screen ("Your dinners") and the Add a meal sheet. Drives the existing table editor by id.
const $ = id => document.getElementById(id);
const INTENT = "tabloom:home-intent:v1", DB = "tabloom-home", STORE = "files";
const params = new URLSearchParams(location.search);
const homeMode = !params.has("table");
const money = c => "$" + (c / 100).toFixed(2);
const esc = v => String(v).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const ic = {
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  cross: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>',
  dot: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="currentColor"/></svg>',
  camera: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8.5A2.5 2.5 0 016.5 6h1.6l1.2-1.8A1 1 0 0110.1 4h3.8a1 1 0 01.8.4L15.9 6h1.6A2.5 2.5 0 0120 8.5v8a2.5 2.5 0 01-2.5 2.5h-11A2.5 2.5 0 014 16.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="12" cy="12.5" r="3.4" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
  video: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6.5" width="12.5" height="11" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M15.5 10.5l5-2.6v8.2l-5-2.6z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>'
};

// Tiny IndexedDB hand-off so a photo/video chosen in the sheet survives the table navigation.
const idb = () => new Promise((res, rej) => { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore(STORE); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function stash(file) { try { const db = await idb(); await new Promise((res, rej) => { const t = db.transaction(STORE, "readwrite"); t.objectStore(STORE).put(file, "file"); t.oncomplete = res; t.onerror = () => rej(t.error); }); return true; } catch { return false; } }
async function unstash() { try { const db = await idb(); const f = await new Promise(res => { const t = db.transaction(STORE, "readwrite"), s = t.objectStore(STORE), g = s.get("file"); g.onsuccess = () => { s.delete("file"); res(g.result || null); }; g.onerror = () => res(null); }); return f; } catch { return null; } }
const until = async (test, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await new Promise(r => setTimeout(r, 120)); } return false; };

function build() {
  const shell = document.querySelector("main.shell");
  const link = document.createElement("a");
  link.id = "home-link"; link.href = "/tabloom/"; link.textContent = "← Dinners";
  shell.prepend(link);
  const home = document.createElement("section");
  home.id = "home"; home.setAttribute("aria-label", "Your dinners");
  home.innerHTML = '<h1 class="home-title">Your dinners</h1><p class="home-sub" id="home-sub"></p><ul id="home-list" class="home-list"></ul>' +
    '<div class="home-cta"><button id="add-meal" type="button">' + ic.plus + '<span>Add a meal</span></button></div>';
  shell.prepend(home);
  const sheet = document.createElement("div");
  sheet.id = "add-meal-sheet"; sheet.hidden = true; sheet.setAttribute("role", "dialog"); sheet.setAttribute("aria-modal", "true"); sheet.setAttribute("aria-label", "Add a meal");
  sheet.innerHTML = '<div class="am-backdrop" data-am-close></div><form class="am-card" id="add-meal-form"><div class="am-grab" aria-hidden="true"></div>' +
    '<div class="am-head"><h2>Add a meal</h2><button type="button" class="am-x" data-am-close aria-label="Close">' + ic.cross + '</button></div>' +
    '<label class="am-field">Name<input id="add-meal-title" maxlength="100" autocomplete="off"></label>' +
    '<label class="am-field">Who was there<textarea id="add-meal-guests" rows="3" placeholder="Alex, Sam, Priya"></textarea><small>One per line or separated by commas. 2 to 12 people.</small></label>' +
    '<p id="add-meal-error" class="am-error" role="alert"></p>' +
    '<div class="am-tiles"><button type="button" id="add-meal-receipt" class="am-tile">' + ic.camera + '<strong>Snap the receipt</strong><span>Take or choose a photo</span></button>' +
    '<button type="button" id="add-meal-record" class="am-tile">' + ic.video + '<strong>Film the table</strong><span>Everyone says what they had</span></button></div>' +
    '<input id="add-meal-receipt-file" type="file" accept="image/*" capture="environment" hidden><input id="add-meal-record-file" type="file" accept="video/*,audio/*" capture hidden></form>';
  document.body.append(sheet);
}

function status(t) {
  if (t.paymentCount === 0) return { cls: "none", icon: ic.dot, text: "Not split yet" };
  if (t.unresolvedPayments > 0) return { cls: "owe", icon: ic.cross, text: t.unresolvedPayments + " still owe" };
  return { cls: "paid", icon: ic.check, text: "Everyone paid" };
}
async function loadHome() {
  const list = $("home-list");
  try {
    const r = await fetch("/tabloom/api/tables?table=legacy"); const { tables } = await r.json();
    const shown = tables.filter(t => !t.sample);
    $("home-sub").textContent = shown.length ? shown.length + (shown.length === 1 ? " meal" : " meals") + " on this computer" : "";
    list.innerHTML = shown.length ? shown.map(t => {
      const s = status(t), d = t.updatedAt ? new Date(t.updatedAt) : null;
      const date = d && Number.isFinite(d.getTime()) ? d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }) : "";
      return '<li><a class="home-card" data-home-table="' + esc(t.id) + '" href="?table=' + encodeURIComponent(t.id) + '"><span class="hc-main"><strong>' + esc(t.title) + '</strong><small>' + esc(date) + (date ? " · " : "") + t.guestCount + (t.guestCount === 1 ? " guest" : " guests") + '</small></span><span class="hc-side"><b>' + money(t.totalCents) + '</b><em class="hc-status ' + s.cls + '">' + s.icon + esc(s.text) + '</em></span></a></li>';
    }).join("") : '<li class="home-empty">No dinners yet. Add your first meal below.</li>';
  } catch { list.innerHTML = '<li class="home-empty">Could not load your dinners.</li>'; }
}

function prefillTitle() {
  const d = new Date(), wd = d.toLocaleDateString("en-GB", { weekday: "short" }), mo = d.toLocaleDateString("en-GB", { month: "short" });
  return "Dinner · " + wd + " " + d.getDate() + " " + mo;
}
const parseGuests = text => text.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
function openSheet() { $("add-meal-title").value = prefillTitle(); $("add-meal-error").textContent = ""; $("add-meal-sheet").hidden = false; document.body.classList.add("am-open"); $("add-meal-guests").focus(); }
function closeSheet() { $("add-meal-sheet").hidden = true; document.body.classList.remove("am-open"); }

// Create through the existing form, then the editor navigates to ?table=<id>.
async function createTable(kind, file) {
  const title = $("add-meal-title").value.trim(), guests = parseGuests($("add-meal-guests").value), err = $("add-meal-error");
  if (!title) { err.textContent = "Give the meal a name."; return false; }
  if (guests.length < 2 || guests.length > 12) { err.textContent = "Add 2 to 12 people."; return false; }
  err.textContent = "Setting up your table…";
  if (file && !(await stash(file))) file = null;
  sessionStorage.setItem(INTENT, JSON.stringify({ kind, file: !!file }));
  document.documentElement.classList.remove("home-mode");
  document.body.classList.add("home-creating");
  await until(() => $("table-count") && $("table-count").textContent !== "Loading tables…");
  $("new-table").click();
  $("new-table-title").value = title; $("new-table-guests").value = guests.join("\n");
  $("create-table").click();
  return true;
}
function wireSheet() {
  $("add-meal").addEventListener("click", openSheet);
  $("add-meal-sheet").addEventListener("click", e => { if (e.target.closest("[data-am-close]")) closeSheet(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("add-meal-sheet").hidden) closeSheet(); });
  $("add-meal-form").addEventListener("submit", e => e.preventDefault());
  for (const [tile, kind] of [["add-meal-receipt", "receipt"], ["add-meal-record", "record"]]) {
    const input = $(tile + "-file");
    $(tile).addEventListener("click", () => {
      const title = $("add-meal-title").value.trim(), n = parseGuests($("add-meal-guests").value).length;
      if (!title || n < 2 || n > 12) { $("add-meal-error").textContent = !title ? "Give the meal a name." : "Add 2 to 12 people."; return; }
      input.value = ""; input.click();
    });
    input.addEventListener("change", () => { if (input.files[0]) createTable(kind, input.files[0]); });
    // Cancelling the picker still starts the table with the right card open.
    input.addEventListener("cancel", () => createTable(kind, null));
  }
}

// After landing in a table: open the card the user asked for and hand over the picked file.
async function resumeIntent() {
  let intent; try { intent = JSON.parse(sessionStorage.getItem(INTENT) || "null"); sessionStorage.removeItem(INTENT); } catch { return; }
  if (!intent) return;
  const file = intent.file ? await unstash() : null;
  const give = (input, f) => { const dt = new DataTransfer(); dt.items.add(f); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true })); };
  if (intent.kind === "record") {
    await until(() => $("voice-intake"));
    const card = $("voice-intake"); card.open = true; card.scrollIntoView({ behavior: "smooth", block: "center" });
    if (file && $("voice-file") && !$("voice-file").disabled) give($("voice-file"), file);
  } else {
    await until(() => $("paste-receipt") && !$("paste-receipt").disabled);
    $("paste-receipt").click(); $("paste-receipt").scrollIntoView({ block: "center" });
    if (file) { await until(() => $("receipt-photo-file")); give($("receipt-photo-file"), file); }
  }
}

build();
wireSheet();
if (homeMode) {
  document.documentElement.classList.add("home-mode");
  // The old direct path (#new-table) must still work while home is showing.
  document.addEventListener("click", e => { if (e.target.closest && e.target.closest("#new-table")) document.documentElement.classList.remove("home-mode"); }, true);
  loadHome();
} else resumeIntent();
