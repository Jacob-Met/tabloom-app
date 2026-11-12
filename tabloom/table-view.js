// table view: a picture of the table replaces clicking checkboxes. It drives the same review checkboxes.
const $ = id => document.getElementById(id);
const sug = $("suggestions");
if (sug) init();
function init() {
  let view = null, frameUrl = "", frameFor = "", pos = [], holders = [], dims = [16, 9], brush = "";
  const names = () => [...document.querySelectorAll("#guests .guest-name")].map(i => i.value.trim()).filter(Boolean);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const HINT = "Tap a face, then tap what is theirs. Or tap an item to cycle who pays. Drag a box if it is off.";
  const col = i => "var(--scene-c" + (i % 8) + ")";
  const sets = () => [...sug.querySelectorAll("fieldset.suggestion")];
  const cents = f => { const m = /([\d.,]+)\s*$/.exec(f.querySelector("legend").textContent); return m ? Math.round(parseFloat(m[1].replace(/,/g, "")) * 100) : 0; };
  const label = f => f.querySelector("legend").textContent.replace(/\s*·[^·]*$/, "");
  const price = f => { const m = /·\s*([^·]*)$/.exec(f.querySelector("legend").textContent); return m ? m[1].trim() : ""; };
  const checks = f => [...f.querySelectorAll("[data-review-guest]")];
  const picked = f => checks(f).map((c, i) => c.checked ? i : -1).filter(i => i >= 0);

  async function getFrame() {
    const tv = window.tabloomVideo; if (!tv) return "";
    if (frameFor === tv.url) return frameUrl;
    const v = document.createElement("video"); v.muted = true; v.playsInline = true; v.preload = "auto"; v.src = tv.url;
    await new Promise((res, rej) => { v.addEventListener("loadeddata", res, { once: true }); v.addEventListener("error", rej, { once: true }); });
    await new Promise(res => { v.addEventListener("seeked", res, { once: true }); v.currentTime = (v.duration || 0) * 0.4; });
    const c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext("2d").drawImage(v, 0, 0);
    dims = [c.width, c.height]; frameFor = tv.url; frameUrl = c.toDataURL("image/jpeg", 0.88); pos = []; holders = [];
    // Faces are found on this machine; when nothing is found the boxes start evenly spaced and can be dragged.
    try {
      const blob = await new Promise(res => c.toBlob(res, "image/jpeg", 0.9));
      const r = await fetch("/tabloom/api/faces", { method: "POST", body: blob, headers: { "content-type": "image/jpeg" } });
      const found = ((await r.json()).faces || []).filter(f => f && f.w > 0.03);
      if (found.length) pos = found.map(f => ({ x: Math.max(0, f.x - f.w * 0.08), y: Math.max(0, f.y - f.h * 0.18), w: Math.min(1, f.w * 1.16), h: Math.min(1, f.h * 1.3) }));
    } catch {}
    return frameUrl;
  }

  // Faces: no detector is available in this build, so boxes start evenly spaced across the upper part
  // of the frame and every box can be dragged onto the right head.
  function defaults(n) {
    const w = 0.12, h = w * dims[0] / dims[1] * 1.25;
    return Array.from({ length: n }, (_, i) => ({ x: (i + 0.5) / n - w / 2, y: 0.12, w, h }));
  }

  function initHolders(gs) {
    const order = (window.tabloomVideo?.order?.() || []).filter(n => gs.includes(n));
    const filmer = gs[0], rest = [...order.filter(n => n !== filmer), ...gs.filter(n => n !== filmer && !order.includes(n))];
    if (!pos.length) pos = defaults(Math.max(1, gs.length - 1));
    holders = pos.map((_, i) => rest[i] ?? "");
  }

  async function build() {
    try { await build2(); } catch (e) { console.warn('table-view failed', e && e.message, e && e.stack); }
  }
  async function build2() {
    const gs = names(), fs = sets();
    if (!window.tabloomVideo || !fs.length || !gs.length) return;
    let src; try { src = await getFrame(); } catch (e) { console.warn('table-view frame failed', e && (e.message || e.type)); return; }
    if (!src || !sets().length) return;
    if (!holders.length) initHolders(gs);
    if (!view) {
      view = document.createElement("section"); view.id = "table-view"; view.setAttribute("aria-label", "Who had what");
      view.innerHTML = '<h3>Who had what</h3><p class="scene-hint">' + HINT + '</p><div class="scene-pic"></div><div class="scene-items"></div><div class="scene-apply-row"><button id="table-view-apply" type="button">Looks right</button></div>';
      let det = $("edit-list");
      if (!det) { det = document.createElement("details"); det.id = "edit-list"; det.innerHTML = "<summary>Edit as a list</summary>"; sug.before(det); det.append(sug); }
      det.before(view);
      view.querySelector(".scene-items").addEventListener("click", onItem);
      $("table-view-apply").addEventListener("click", () => { sets().forEach(f => { const c = f.querySelector("[data-review-confirm]"); if (c && picked(f).length && !c.checked) { c.disabled = false; c.checked = true; c.dispatchEvent(new Event("change", { bubbles: true })); } }); $("apply-ai")?.click(); setTimeout(() => { const sr = $("save-reviewed"); if (sr && !sr.disabled) sr.click(); }, 400); });
    }
    $("edit-list").open = false;
    paintPic(); paintItems();
  }

  const css = root => root.querySelectorAll('[data-css]').forEach(el => { el.style.cssText = el.dataset.css; });
  function paintPic() {
    const gs = names(), pic = view.querySelector(".scene-pic"), pcts = v => (v * 100).toFixed(2) + "%";
    let html = '<img alt="The table" src="' + frameUrl + '">';
    pos.forEach((p, i) => { const g = gs.indexOf(holders[i]); if (g < 0) return; html += '<div class="scene-band" data-css="background:' + col(g) + ';left:' + pcts(p.x - p.w * 0.3) + ';width:' + pcts(p.w * 1.6) + ';top:' + pcts(p.y + p.h * 1.05) + ';height:' + pcts(Math.min(0.42, 0.98 - p.y - p.h * 1.05)) + '"></div>'; });
    pos.forEach((p, i) => { const g = gs.indexOf(holders[i]); const c = g < 0 ? "#cbd2dc" : col(g); html += '<div class="scene-person" data-scene-person="' + esc((holders[i] || "nobody").toLowerCase()) + '"' + (brush && brush === holders[i] ? ' data-brush="1"' : "") + ' data-slot="' + i + '" data-css="left:' + pcts(p.x) + ';top:' + pcts(p.y) + ';width:' + pcts(p.w) + ';height:' + pcts(p.h) + '"><span class="scene-fill" data-css="background:' + c + '"></span><span class="scene-pill" data-css="background:' + c + '"><span class="scene-name">' + esc(holders[i] || "Nobody") + '</span> · <span class="scene-total"></span></span></div>'; });
    const fm = gs.filter(n => !holders.includes(n));
    if (fm.length) { const n = fm[0], g = gs.indexOf(n); html += '<div class="scene-filming" data-scene-person="' + esc(n.toLowerCase()) + '"' + (brush === n ? ' data-brush="1"' : "") + '><span class="scene-pill" data-css="background:' + col(g) + '"><span class="scene-name">' + esc(n) + '</span> · filming · <span class="scene-total"></span></span></div>'; }
    pic.innerHTML = html; css(pic);
    pic.querySelectorAll(".scene-person").forEach(el => wire(el, pic));
    const film = pic.querySelector(".scene-filming"); if (film) film.addEventListener("click", () => setBrush(film.querySelector(".scene-name").textContent));
    totals();
  }

  function wire(el, pic) {
    el.addEventListener("pointerdown", e => {
      const i = +el.dataset.slot, r = pic.getBoundingClientRect(), start = { x: e.clientX, y: e.clientY, px: pos[i].x, py: pos[i].y }; let moved = false;
      el.setPointerCapture(e.pointerId);
      const move = ev => { const dx = ev.clientX - start.x, dy = ev.clientY - start.y; if (Math.abs(dx) + Math.abs(dy) > 5) moved = true; if (!moved) return;
        pos[i].x = Math.min(1 - pos[i].w, Math.max(0, start.px + dx / r.width)); pos[i].y = Math.min(1 - pos[i].h, Math.max(0, start.py + dy / r.height));
        el.style.left = pos[i].x * 100 + "%"; el.style.top = pos[i].y * 100 + "%"; };
      const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up); if (moved) paintPic(); else setBrush(holders[i]); };
      el.addEventListener("pointermove", move); el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
    });
  }
  function setBrush(name) { brush = brush === name ? "" : (name || ""); paintPic(); const h = view.querySelector(".scene-hint"); if (h) h.textContent = brush ? "Now tap what " + brush + " is paying for. Tap " + brush + " again when done." : HINT; }
  function cycleHolder(i) {
    const gs = names(); const cur = gs.indexOf(holders[i]); const next = gs[(cur + 1) % gs.length];
    const other = holders.indexOf(next); if (other >= 0) holders[other] = holders[i]; holders[i] = next; paintPic(); paintItems();
  }

  function totals() {
    const gs = names(), sum = gs.map(() => 0);
    sets().forEach(f => { const p = picked(f); p.forEach(i => { if (i < sum.length) sum[i] += cents(f) / p.length; }); });
    view.querySelectorAll("[data-scene-person]").forEach(el => { const t = el.querySelector(".scene-total"); const g = gs.findIndex(n => n.toLowerCase() === el.dataset.scenePerson); if (t) t.textContent = "$" + ((sum[g] || 0) / 100).toFixed(2); });
  }

  function paintItems() {
    const gs = names();
    view.querySelector(".scene-items").innerHTML = sets().map((f, k) => {
      const p = picked(f).filter(i => i < gs.length);
      let bg = "", who = "";
      if (p.length) { const step = 100 / p.length; bg = "background:linear-gradient(90deg," + p.map((g, j) => col(g) + " " + (j * step) + "% " + ((j + 1) * step) + "%").join(",") + ")"; who = p.length === gs.length && gs.length > 1 ? "everyone" : p.map(g => gs[g][0].toUpperCase()).join(" "); }
      return '<button type="button" class="scene-item" data-scene-item="' + k + '" data-who="' + (p.length ? "some" : "none") + '" data-css="' + bg + '"><span>' + esc(label(f)) + '</span> <b>' + esc(price(f)) + '</b>' + (p.length ? '<span class="scene-who">' + esc(who) + '</span>' : '') + '</button>';
    }).join("");
    css(view.querySelector('.scene-items')); totals();
  }

  function write(f, idxs) {
    const set = new Set(idxs);
    checks(f).forEach((c, i) => { if (c.checked !== set.has(i)) { c.checked = set.has(i); c.dispatchEvent(new Event("change", { bubbles: true })); } });
    const conf = f.querySelector("[data-review-confirm]");
    if (conf && idxs.length) { conf.disabled = false; if (!conf.checked) { conf.checked = true; conf.dispatchEvent(new Event("change", { bubbles: true })); } }
  }
  function onItem(e) {
    const b = e.target.closest("[data-scene-item]"); if (!b) return;
    const f = sets()[+b.dataset.sceneItem], n = names().length, cur = picked(f);
    let next;
    const bi = names().indexOf(brush);
    if (brush && bi >= 0) { next = cur.includes(bi) ? cur.filter(i => i !== bi) : [...cur, bi].sort(); }
    else if (e.shiftKey) { const add = [...Array(n).keys()].find(i => !cur.includes(i)); next = add === undefined ? cur.slice(0, -1) : [...cur, add].sort(); }
    else {
      const states = [...Array(n).keys()].map(i => [i]); if (n > 1) states.push([...Array(n).keys()]); states.push([]);
      const at = states.findIndex(s => s.length === cur.length && s.every((v, j) => v === cur[j]));
      next = states[(at + 1) % states.length];
    }
    write(f, next); paintItems();
  }

  // re-render when a proposal appears, or when checkboxes change (including from the list)
  let t = null;
  const later = () => { clearTimeout(t); t = setTimeout(() => { if (sug.querySelector("fieldset.suggestion")) build(); else if (view && !sug.hasChildNodes()) { view.remove(); view = null; } }, 30); };
  new MutationObserver(later).observe(sug, { childList: true });
  sug.addEventListener("change", () => { if (view) setTimeout(paintItems, 0); });
  window.addEventListener("tabloom-video", () => { frameFor = ""; view?.remove(); view = null; });
}
