// voice intake: "Record the table". Record or upload one recording; the local listener separates the voices;
// the payer says who is who; the result becomes an attributed note for the existing AI split.
const $ = id => document.getElementById(id);
const root = $("voice-intake");
if (root) init();

function init() {
  const state = { buffer: null, speakers: [], recorder: null, stream: null, timer: null, started: 0, playing: null, ctx: null, lines: [], who: [], video: null, videoUrl: "" };
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
    stopPlaying(); $("voice-speakers").replaceChildren(); $("voice-lines").replaceChildren(); state.lines = []; state.who = []; if (state.videoUrl) URL.revokeObjectURL(state.videoUrl); state.videoUrl = ""; state.video = null; window.tabloomVideo = null; $("voice-suggest").hidden = true; state.buffer = null;
    say("Listening to the recording… this takes about as long as the recording.", "live");
    root.classList.add("busy");
    try {
      const isVideo = /^video\//.test(blob.type || "") || /\.(mp4|mov|m4v)$/i.test(blob.name || "");
      if (isVideo) state.videoUrl = URL.createObjectURL(blob);
      const bytes = await blob.arrayBuffer();
      try { state.ctx ||= new (window.AudioContext || window.webkitAudioContext)(); state.buffer = await state.ctx.decodeAudioData(bytes.slice(0)); } catch { state.buffer = null; }
      const r = await fetch("/tabloom/api/voice?names=" + encodeURIComponent(guestNames().join(",")), { method: "POST", body: blob, headers: { "content-type": blob.type || "application/octet-stream" } });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw Error(out.error || "The listener could not process this recording.");
      show(out, isVideo);
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

  function show(out, isVideo) {
    const names = guestNames(), by = new Map();
    for (const s of out.segments || []) { if (!by.has(s.speaker)) by.set(s.speaker, []); by.get(s.speaker).push(s); }
    state.speakers = [...by].map(([id, segs], i) => ({ id, segs, n: i + 1 }));
    if (!state.speakers.length) return say("No speech was found in that recording. Try again closer to the table.", "error");
    const lines = (out.lines || []).filter(l => l && l.text);
    if (lines.length && (state.speakers.length <= 1 || state.speakers.length < names.length - 1)) return showLines(lines, names, isVideo, state.speakers.length);
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

  // Fallback when voices could not be told apart: one line at a time, the payer says who said it.
  function showLines(lines, names, isVideo, found) {
    state.lines = lines; state.who = lines.map(() => "");
    const chip = (i, key, label) => '<button type="button" class="voice-chip' + (key === "skip" ? " skip" : "") + '" data-voice-line-who="' + esc(key) + '" aria-pressed="false">' + esc(label) + "</button>";
    $("voice-lines").innerHTML = '' + lines.map((l, i) =>
      '<article class="voice-line" data-voice-line="' + i + '">' +
      (isVideo ? '<img class="voice-line-frame" alt="Video frame at ' + l.start.toFixed(1) + ' seconds" width="96" height="72">' :
        '<button type="button" class="voice-play voice-line-play" data-play-line="' + i + '" aria-label="Play this line"' + (state.buffer ? "" : " disabled") + '>▶ HEAR</button>') +
      '<div class="voice-line-body"><p class="voice-line-text">' + esc(l.text) + '</p><div class="voice-chips" role="group" aria-label="Who said this?">' +
      names.map(n => chip(i, n.toLowerCase(), n)).join("") + chip(i, "skip", "Nobody / skip") + "</div></div></article>").join("");
    say((found > 1 ? "Only " + found + " voices could be told apart" : "The voices could not be told apart") + ", so here is what was said, line by line. Tap who said each one.", "ok");
    $("voice-suggest").hidden = false; refresh();
    if (isVideo) captureFrames(lines);
  }
  function captureFrames(lines) {
    const v = document.createElement("video"); v.muted = true; v.playsInline = true; v.preload = "auto"; v.src = state.videoUrl; state.video = v;
    window.tabloomVideo = { url: state.videoUrl, order: () => { const names = guestNames(), seen = []; state.who.forEach(k => { const n = names.find(x => x.toLowerCase() === k); if (n && !seen.includes(n)) seen.push(n); }); return seen; } };
    window.dispatchEvent(new Event("tabloom-video"));
    const seek = t => new Promise((res, rej) => { const ok = () => { v.removeEventListener("error", bad); res(); }, bad = () => { v.removeEventListener("seeked", ok); rej(); }; v.addEventListener("seeked", ok, { once: true }); v.addEventListener("error", bad, { once: true }); v.currentTime = t; });
    (async () => {
      await new Promise((res, rej) => { v.addEventListener("loadeddata", res, { once: true }); v.addEventListener("error", rej, { once: true }); });
      const w = 192, h = Math.round(w * (v.videoHeight || 3) / (v.videoWidth || 4)), c = document.createElement("canvas"); c.width = w; c.height = h;
      const cx = c.getContext("2d");
      for (let i = 0; i < lines.length; i++) {
        if (state.video !== v) return;
        const mid = (lines[i].start + lines[i].end) / 2;
        await seek(Math.min(Math.max(mid, 0), Math.max(0, (v.duration || mid) - 0.05)));
        cx.drawImage(v, 0, 0, w, h);
        const img = root.querySelector('[data-voice-line="' + i + '"] img.voice-line-frame');
        if (img) { img.src = c.toDataURL("image/jpeg", 0.8); img.removeAttribute("height"); img.dataset.ready = "1"; }
      }
    })().catch(err => { console.warn("frame capture failed", err && (err.type || err.message), state.video && state.video.error && state.video.error.code); root.querySelectorAll("img.voice-line-frame").forEach(i => { if (!i.dataset.ready) i.classList.add("failed"); }); });
  }
  $("voice-lines").addEventListener("click", e => {
    const chip = e.target.closest("[data-voice-line-who]");
    if (chip) {
      const line = chip.closest("[data-voice-line]"), i = +line.dataset.voiceLine, key = chip.dataset.voiceLineWho;
      state.who[i] = state.who[i] === key ? "" : key;
      line.querySelectorAll("[data-voice-line-who]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.voiceLineWho === state.who[i])));
      return refresh();
    }
    const btn = e.target.closest("[data-play-line]"); if (!btn || !state.buffer) return;
    const was = state.playing?.btn === btn; stopPlaying(); if (was) return;
    const l = state.lines[+btn.dataset.playLine], src = state.ctx.createBufferSource();
    src.buffer = state.buffer; src.connect(state.ctx.destination); state.ctx.resume();
    src.onended = () => { if (state.playing?.src === src) stopPlaying(); };
    src.start(0, l.start, Math.max(0.3, l.end - l.start)); btn.innerHTML = "■ STOP"; state.playing = { src, btn };
  });

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
    if (state.lines.length) {
      const names = guestNames();
      state.lines.forEach((l, i) => { const n = names.find(x => x.toLowerCase() === state.who[i]); if (n) m.set(n, (m.get(n) || []).concat(l.text)); });
      return m;
    }
    root.querySelectorAll("[data-who]").forEach(sel => {
      if (!sel.value || sel.value === "__skip") return;
      const sp = state.speakers.find(s => s.id === sel.dataset.who);
      m.set(sel.value, (m.get(sel.value) || []).concat(sp.segs.map(s => s.text)));
    });
    return m;
  }
  function refresh() { const n = assignments().size; $("voice-suggest").disabled = !n; $("voice-suggest").innerHTML = (state.lines.length ? "READ WHAT THE TABLE SAID" : "SUGGEST SPLITS FROM THE RECORDING") + " <span>↗</span>"; }

  $("voice-suggest").addEventListener("click", () => {
    const m = assignments(); if (!m.size) return;
    // Lines tagged one by one go through the same reading as a pasted group chat, so vague answers
    // ("I had the chicken") and items nobody mentioned get their "Clear this up" cards before any split.
    if (state.lines.length && $("chat-text") && $("chat-read")) {
      const names = guestNames();
      const said = state.lines.map((l, i) => { const n = names.find(x => x.toLowerCase() === state.who[i]); return n ? n + ": " + l.text : ""; }).filter(Boolean).join("\n");
      const box = $("chat-text"); box.value = said; box.dispatchEvent(new Event("input", { bubbles: true }));
      const card = box.closest("details"); if (card) card.open = true;
      $("chat-read").click(); say("Read what the table said. Clear up anything below, then suggest the split.", "ok");
      setTimeout(() => ($("chat-result") || box).scrollIntoView({ block: "start", behavior: "smooth" }), 250);
      return;
    }
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
