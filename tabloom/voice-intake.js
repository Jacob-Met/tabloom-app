// voice intake: "Record the table". Record or upload one recording; the local listener separates the voices;
// the payer says who is who; the result becomes an attributed note for the existing AI split.
const $ = id => document.getElementById(id);
const root = $("voice-intake");
if (root) init();

function init() {
  const state = { buffer: null, speakers: [], recorder: null, stream: null, timer: null, started: 0, playing: null, ctx: null };
  const say = (text, kind = "") => { const s = $("voice-status"); s.textContent = text; s.dataset.kind = kind; };
  const guestNames = () => [...document.querySelectorAll("#guests .guest-name")].map(i => i.value.trim()).filter(Boolean);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  fetch("/tabloom/api/voice/status").then(r => r.json()).then(s => {
    if (s.available) { $("voice-sample-row").hidden = false; return; }
    $("voice-unavailable").hidden = false;
    $("voice-unavailable").innerHTML = "<strong>The listener is not installed or not running.</strong> Recording needs a small local program that works out who is speaking; nothing is sent to the internet. In a terminal, run <code>npm run listen:install</code> once, then <code>npm run listen</code>. The typed note below works without it.";
    $("voice-record").disabled = true; $("voice-file").disabled = true; root.querySelector(".voice-upload").classList.add("disabled");
  }).catch(() => {});

  $("voice-file").addEventListener("change", e => { const f = e.target.files[0]; if (f) process(f); e.target.value = ""; });
  $("voice-sample").addEventListener("click", async () => {
    const r = await fetch("/tabloom/sample/table-talk.wav"); process(await r.blob());
  });

  $("voice-record").addEventListener("click", async () => {
    if (state.recorder) return stop();
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return say("This browser cannot record. Upload a recording instead.", "error");
    try { state.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false } }); }
    catch { return say("Microphone access was blocked. Allow it for this page, or upload a recording instead.", "error"); }
    const chunks = []; const rec = new MediaRecorder(state.stream);
    rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    rec.onstop = () => { state.stream.getTracks().forEach(t => t.stop()); clearInterval(state.timer); state.recorder = null; setRecordUi(false); process(new Blob(chunks, { type: rec.mimeType || "audio/webm" })); };
    state.recorder = rec; rec.start(); state.started = Date.now(); setRecordUi(true);
    state.timer = setInterval(() => { const s = Math.floor((Date.now() - state.started) / 1000); say("Listening… " + Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0") + ". Ask “what did you get?” and let everyone answer.", "live"); }, 250);
  });
  function stop() { state.recorder?.stop(); }
  function setRecordUi(on) { const b = $("voice-record"); b.classList.toggle("recording", on); b.innerHTML = on ? "■ STOP AND LISTEN" : "● RECORD THE TABLE"; }

  async function process(blob) {
    stopPlaying(); $("voice-speakers").replaceChildren(); $("voice-suggest").hidden = true; state.buffer = null;
    say("Listening to the recording… this takes about as long as the recording.", "live");
    root.classList.add("busy");
    try {
      const bytes = await blob.arrayBuffer();
      try { state.ctx ||= new (window.AudioContext || window.webkitAudioContext)(); state.buffer = await state.ctx.decodeAudioData(bytes.slice(0)); } catch { state.buffer = null; }
      const r = await fetch("/tabloom/api/voice?names=" + encodeURIComponent(guestNames().join(",")), { method: "POST", body: blob, headers: { "content-type": blob.type || "application/octet-stream" } });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw Error(out.error || "The listener could not process this recording.");
      show(out);
    } catch (e) { say(e.message, "error"); }
    finally { root.classList.remove("busy"); }
  }

  function guessGuest(text, names, taken) {
    const lead = text.slice(0, 90).toLowerCase();
    for (const n of names) {
      if (taken.has(n)) continue;
      const re = new RegExp("(?:\\b(?:i'?m|i am|this is|it'?s|my name is|name'?s)\\s+" + n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b)|(?:^\\s*" + n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b\\s*(?:here|speaking|[.,]))");
      if (re.test(lead)) return n;
    }
    return "";
  }

  function show(out) {
    const names = guestNames(), by = new Map();
    for (const s of out.segments || []) { if (!by.has(s.speaker)) by.set(s.speaker, []); by.get(s.speaker).push(s); }
    state.speakers = [...by].map(([id, segs], i) => ({ id, segs, n: i + 1 }));
    if (!state.speakers.length) return say("No speech was found in that recording. Try again closer to the table.", "error");
    const taken = new Set();
    const html = state.speakers.map(sp => {
      const guess = guessGuest(sp.segs[0].text, names, taken); if (guess) taken.add(guess);
      const longest = sp.segs.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
      sp.snip = [longest.start, Math.min(3, longest.end - longest.start)];
      return '<article class="voice-speaker" data-speaker="' + esc(sp.id) + '" data-c="' + ((sp.n - 1) % 6) + '">' +
        '<header><span class="voice-dot" aria-hidden="true"></span><strong>Speaker ' + sp.n + '</strong>' +
        '<button type="button" class="voice-play" data-play="' + esc(sp.id) + '" aria-label="Play 3 seconds of speaker ' + sp.n + '"' + (state.buffer ? "" : " disabled") + '>▶ HEAR</button></header>' +
        '<ul class="voice-said">' + sp.segs.map(s => "<li>" + esc(s.text) + "</li>").join("") + '</ul>' +
        '<label class="voice-who">WHO IS THIS?<select data-who="' + esc(sp.id) + '"><option value="">Choose a guest…</option>' +
        names.map(n => '<option' + (n === guess ? " selected" : "") + ">" + esc(n) + "</option>").join("") + '<option value="__skip">Not at the table</option></select></label></article>';
    }).join("");
    $("voice-speakers").innerHTML = html;
    const found = state.speakers.length;
    say(found + (found === 1 ? " voice" : " voices") + " found" + (names.length && found !== names.length ? " (the table has " + names.length + " guests; check the list)" : "") + ". Tap HEAR to listen, then say who is who." + (state.buffer ? "" : " Playback is not available for this file type."), "ok");
    $("voice-suggest").hidden = false; refresh();
  }

  function stopPlaying() { try { state.playing?.src.stop(); } catch {} state.playing?.btn && (state.playing.btn.innerHTML = "▶ HEAR"); state.playing = null; }
  $("voice-speakers").addEventListener("click", e => {
    const btn = e.target.closest("[data-play]"); if (!btn || !state.buffer) return;
    const was = state.playing?.btn === btn; stopPlaying(); if (was) return;
    const sp = state.speakers.find(s => s.id === btn.dataset.play); const src = state.ctx.createBufferSource();
    src.buffer = state.buffer; src.connect(state.ctx.destination); state.ctx.resume();
    src.onended = () => { if (state.playing?.src === src) stopPlaying(); };
    src.start(0, sp.snip[0], sp.snip[1]); btn.innerHTML = "■ STOP"; state.playing = { src, btn };
  });
  $("voice-speakers").addEventListener("change", refresh);

  function assignments() {
    const m = new Map();
    root.querySelectorAll("[data-who]").forEach(sel => {
      if (!sel.value || sel.value === "__skip") return;
      const sp = state.speakers.find(s => s.id === sel.dataset.who);
      m.set(sel.value, (m.get(sel.value) || []).concat(sp.segs.map(s => s.text)));
    });
    return m;
  }
  function refresh() { const n = assignments().size; $("voice-suggest").disabled = !n; $("voice-suggest").innerHTML = "SUGGEST SPLITS FROM THE RECORDING <span>↗</span>"; }

  $("voice-suggest").addEventListener("click", () => {
    const m = assignments(); if (!m.size) return;
    let note = [...m].map(([name, said]) => name + " said: " + said.join(" ")).join("\n");
    if (note.length > 2000) note = note.slice(0, 1990).replace(/\s+\S*$/, "") + " …";
    const field = $("bill-note"); field.value = note; field.dispatchEvent(new Event("input", { bubbles: true }));
    const card = field.closest("details"); if (card) card.open = true;
    const go = $("suggest");
    if (go.disabled) return say("Add the receipt items first (or the table is already locked by a payment), then press this again.", "error");
    say("Sent to the AI as: “" + note.split("\n").map(l => l.slice(0, 40)).join(" / ") + "…”. Check each item below before confirming.", "ok");
    go.click(); $("suggestions").scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
}
