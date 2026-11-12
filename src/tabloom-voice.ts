// voice intake: browser -> Tabloom -> local listener (tools/voice/listen.py). Audio never leaves this machine.
import type { IncomingMessage, ServerResponse } from "node:http";

const LIMIT = 40 * 1024 * 1024;
const listenerUrl = () => process.env.TABLOOM_VOICE_URL ?? "http://127.0.0.1:5611";

export const VOICE_ASSETS: Record<string, string> = {
  "voice-intake.js": "text/javascript; charset=utf-8",
  "voice-intake.css": "text/css; charset=utf-8",
  "table-view.js": "text/javascript; charset=utf-8",
  "table-view.css": "text/css; charset=utf-8",
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
