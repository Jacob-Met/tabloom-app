#!/usr/bin/env python3
"""Tabloom listener: audio or video in, [{speaker, start, end, text}] plus sentence lines [{start, end, text}] out (ffmpeg takes the audio track of video files). Local only, no network at request time.

  POST /listen   raw audio bytes (wav/webm/m4a/mp3...)  ->  {"speakers": n, "duration": s, "segments": [...]}
  GET  /health   ->  {"ok": true}

Speech to text: faster-whisper (CPU, int8). Speakers: resemblyzer voice embeddings, clustered
with agglomerative clustering. Models are fetched once from PyPI / Hugging Face (no token).
"""
import json, os, subprocess, sys, tempfile, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Model files live next to this script (gitignored), not in the repo history.
os.environ.setdefault("HF_HOME", os.path.join(os.path.dirname(os.path.abspath(__file__)), "models"))
PORT = int(os.environ.get("TABLOOM_VOICE_PORT", "5611"))
WHISPER = os.environ.get("TABLOOM_VOICE_WHISPER", "base.en")
FFMPEG = os.environ.get("FFMPEG", "/opt/homebrew/bin/ffmpeg" if os.path.exists("/opt/homebrew/bin/ffmpeg") else "ffmpeg")
GAP = float(os.environ.get("TABLOOM_VOICE_GAP", "0.7"))        # silence (s) that may start a new speaker turn
THRESH = float(os.environ.get("TABLOOM_VOICE_THRESHOLD", "0.25"))  # cosine distance at which voices count as different
LONG = 1.8  # seconds; shorter turns are matched to a voice found in longer ones
MAX_BYTES = 60 * 1024 * 1024
_lock = threading.Lock()
_models = {}


def models():
    if not _models:
        from faster_whisper import WhisperModel
        from resemblyzer import VoiceEncoder
        _models["asr"] = WhisperModel(WHISPER, device="cpu", compute_type="int8")
        _models["enc"] = VoiceEncoder("cpu", verbose=False)
    return _models["asr"], _models["enc"]


def decode(raw):
    with tempfile.TemporaryDirectory() as d:
        src, dst = os.path.join(d, "in"), os.path.join(d, "out.wav")
        open(src, "wb").write(raw)
        p = subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", src, "-ar", "16000", "-ac", "1", "-sample_fmt", "s16", dst],
                           capture_output=True)
        if p.returncode:
            raise ValueError("could not decode this audio: " + p.stderr.decode()[-200:])
        import soundfile as sf
        audio, rate = sf.read(dst, dtype="float32")
        return audio, rate


def chunks(words):
    """Split the word stream into turns at long silences and after sentence ends that follow a pause."""
    out, cur = [], []
    for w in words:
        if cur:
            gap = w.start - cur[-1].end
            ends = cur[-1].word.strip()[-1:] in ".?!"
            if gap > GAP or (ends and gap > GAP * 0.6):
                out.append(cur); cur = []
        cur.append(w)
    if cur:
        out.append(cur)
    return out


def sentence_lines(words):
    """Sentence-level lines with timestamps, split at sentence-ending punctuation from the transcriber's own words."""
    out, cur = [], []
    for w in words:
        cur.append(w)
        if w.word.strip()[-1:] in ".?!":
            out.append(cur); cur = []
    if cur:
        out.append(cur)
    res = []
    for c in out:
        text = "".join(w.word for w in c).strip()
        if text:
            res.append({"start": round(c[0].start, 2), "end": round(c[-1].end, 2), "text": text})
    return res


def listen(raw, names=()):
    import numpy as np
    from resemblyzer import preprocess_wav
    from sklearn.cluster import AgglomerativeClustering
    full, sr = decode(raw)
    asr, enc = models()
    segs, _ = asr.transcribe(full, word_timestamps=True, language="en", beam_size=1, condition_on_previous_text=False,
                            initial_prompt=("Dinner with " + ", ".join(names) + ".") if names else None)
    words = [w for s in segs for w in (s.words or [])]
    turns = chunks(words)
    items = []
    for t in turns:
        a, b = t[0].start, t[-1].end
        text = "".join(w.word for w in t).strip()
        if not text:
            continue
        clip = full[int(max(0, a - 0.05) * sr): int((b + 0.05) * sr)]
        clip = preprocess_wav(clip, source_sr=sr) if len(clip) > sr * 0.3 else clip
        emb = enc.embed_utterance(clip) if len(clip) > sr * 0.3 else None
        items.append({"start": round(a, 2), "end": round(b, 2), "text": text, "emb": emb, "dur": b - a})
    # Short clips give weak voice prints: cluster the longer turns first, then attach short ones to the nearest voice.
    ok = [i for i in items if i["emb"] is not None]
    long_ = [i for i in ok if i["dur"] >= LONG] or ok
    if len(long_) >= 2:
        X = np.stack([i["emb"] for i in long_])
        lab = AgglomerativeClustering(n_clusters=None, metric="cosine", linkage="average", distance_threshold=THRESH).fit_predict(X)
    else:
        lab = [0] * len(long_)
    cents = {}
    for i, l in zip(long_, lab):
        i["l"] = int(l); cents.setdefault(int(l), []).append(i["emb"])
    cents = {l: np.mean(v, axis=0) for l, v in cents.items()}
    for i in ok:
        if "l" not in i and cents:
            i["l"] = min(cents, key=lambda l: 1 - np.dot(i["emb"], cents[l]) / (np.linalg.norm(i["emb"]) * np.linalg.norm(cents[l]) + 1e-9))
    # Name speakers in order of first appearance; chunks with no usable embedding join the previous speaker.
    order, prev = {}, None
    for i in items:
        l = i.get("l", prev)
        if l is None:
            l = 0
        order.setdefault(l, "S%d" % (len(order) + 1))
        i["speaker"] = order[l]; prev = l
    merged = []
    for i in items:
        if merged and merged[-1]["speaker"] == i["speaker"] and i["start"] - merged[-1]["end"] < 1.2:
            merged[-1]["end"] = i["end"]; merged[-1]["text"] += " " + i["text"]
        else:
            merged.append({"speaker": i["speaker"], "start": i["start"], "end": i["end"], "text": i["text"]})
    return {"speakers": len(order), "duration": round(len(full) / sr, 2), "segments": merged, "lines": sentence_lines(words)}


class H(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(b)))
        self.end_headers(); self.wfile.write(b)

    def do_GET(self):
        self._send(200, {"ok": True, "whisper": WHISPER}) if self.path == "/health" else self._send(404, {"error": "not found"})

    def do_POST(self):
        from urllib.parse import urlparse, parse_qs
        url = urlparse(self.path)
        names = [n.strip()[:40] for n in (parse_qs(url.query).get("names", [""])[0]).split(",") if n.strip()][:12]
        if url.path != "/listen":
            return self._send(404, {"error": "not found"})
        n = int(self.headers.get("content-length") or 0)
        if n <= 0 or n > MAX_BYTES:
            return self._send(413, {"error": "audio must be between 1 byte and 60 MB"})
        raw = self.rfile.read(n)
        try:
            with _lock:
                self._send(200, listen(raw, names))
        except ValueError as e:
            self._send(422, {"error": str(e)})
        except Exception as e:  # keep the listener alive
            self._send(500, {"error": "listener failed: %s" % e})

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    if len(sys.argv) > 1:  # `listen.py file.wav` prints the result and exits (handy for checking)
        print(json.dumps(listen(open(sys.argv[1], "rb").read(), sys.argv[2].split(",") if len(sys.argv) > 2 else ()), indent=1)); sys.exit()
    print("Tabloom listener on http://127.0.0.1:%d (loading models on first use)" % PORT, flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
