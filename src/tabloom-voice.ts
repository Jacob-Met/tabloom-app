// voice intake: browser -> Tabloom -> local listener (tools/voice/listen.py). Audio never leaves this machine.
import type { IncomingMessage, ServerResponse } from "node:http";

const LIMIT = 40 * 1024 * 1024;
const listenerUrl = () => process.env.TABLOOM_VOICE_URL ?? "http://127.0.0.1:5611";

export const VOICE_ASSETS: Record<string, string> = {
  "voice-intake.js": "text/javascript; charset=utf-8",
  "voice-intake.css": "text/css; charset=utf-8",
  "home.js": "text/javascript; charset=utf-8",
  "home.css": "text/css; charset=utf-8",
  "shopping.js": "text/javascript; charset=utf-8",
  "shopping.css": "text/css; charset=utf-8",
  "table-view.js": "text/javascript; charset=utf-8",
  "table-view.css": "text/css; charset=utf-8",
  "payer.js": "text/javascript; charset=utf-8",
  "payer.css": "text/css; charset=utf-8",
  "crew.js": "text/javascript; charset=utf-8",
  "crew.css": "text/css; charset=utf-8",
  "sample/table-talk.wav": "audio/wav"
};

function loopback(raw: string): boolean {
  try { const u = new URL(raw); return ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname); } catch { return false; }
}
function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(data));
}
async function alive(): Promise<boolean> {
  if (process.env.TABLOOM_VOICE_CANNED) return true;
  if (!loopback(listenerUrl())) return false;
  try { return (await fetch(listenerUrl() + "/health", { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
}

/** Returns true when the request was a voice endpoint and has been answered. */
export async function handleVoice(req: IncomingMessage, res: ServerResponse, pathname: string, search: URLSearchParams): Promise<boolean> {
  if (pathname === "/tabloom/api/voice/status" && req.method === "GET") {
    const up = await alive();
    json(res, 200, { available: up, simulated: !!process.env.TABLOOM_VOICE_CANNED, install: "npm run listen:install && npm run listen" });
    return true;
  }
  if (pathname === "/tabloom/api/faces" && req.method === "POST") {
    // table view: where the faces are in one frame of the table video. A local script; the picture never leaves this machine.
    const parts: Buffer[] = []; let size = 0;
    for await (const c of req) { size += (c as Buffer).length; if (size > 6 * 1024 * 1024) { json(res, 413, { faces: [] }); return true; } parts.push(c as Buffer); }
    const { spawn } = await import("node:child_process"); const { fileURLToPath } = await import("node:url");
    const script = process.env.TABLOOM_FACES_SCRIPT ?? fileURLToPath(new URL("../../tools/voice/faces.py", import.meta.url));
    const out = await new Promise<string>(resolve => {
      let text = ""; const child = spawn(process.env.TABLOOM_FACES_PYTHON ?? "python3", [script], { stdio: ["pipe", "pipe", "ignore"] });
      const timer = setTimeout(() => child.kill(), 15000);
      child.stdout.on("data", d => { text += d; }); child.on("error", () => { clearTimeout(timer); resolve(""); }); child.on("close", () => { clearTimeout(timer); resolve(text); });
      child.stdin.on("error", () => {}); child.stdin.end(Buffer.concat(parts));
    });
    let faces: unknown = []; try { faces = JSON.parse(out).faces ?? []; } catch { faces = []; }
    json(res, 200, { faces });
    return true;
  }
  if (pathname !== "/tabloom/api/voice" || req.method !== "POST") return false;
  const origin = req.headers.origin;
  if (origin && origin !== "http://" + req.headers.host) { json(res, 403, { error: "Origin mismatch" }); return true; }
  const parts: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const b = Buffer.from(chunk); size += b.length; if (size > LIMIT) { json(res, 413, { error: "Recording is over 40 MB. Try a shorter one." }); return true; } parts.push(b); }
  if (!size) { json(res, 400, { error: "No audio received." }); return true; }
  if (process.env.TABLOOM_VOICE_CANNED) { await new Promise(r => setTimeout(r, 1800)); json(res, 200, JSON.parse(process.env.TABLOOM_VOICE_CANNED)); return true; }
  if (!(await alive())) { json(res, 503, { error: "The listener is not running. Install and start it with: npm run listen:install, then npm run listen." }); return true; }
  try {
    const names = (search.get("names") ?? "").slice(0, 400);
    const r = await fetch(listenerUrl() + "/listen?names=" + encodeURIComponent(names), { method: "POST", body: Buffer.concat(parts), signal: AbortSignal.timeout(10 * 60 * 1000) });
    const body = await r.json().catch(() => ({ error: "The listener sent an unreadable answer." }));
    json(res, r.ok ? 200 : 502, body);
  } catch { json(res, 502, { error: "The listener stopped answering. Restart it with npm run listen." }); }
  return true;
}
