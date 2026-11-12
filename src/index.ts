import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { TabloomGuestNetwork } from "./tabloom-guest-network.js";
import { TabloomService, handleTabloom } from "./tabloom-service.js";

const LOOPBACKS = new Set(["127.0.0.1", "::1", "localhost"]);

export function resolvePort(): number {
  const raw = process.env.TABLOOM_PORT ?? "3000";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`TABLOOM_PORT must be 1..65535, got ${JSON.stringify(raw)}`);
  }
  return port;
}

export function resolveHost(): string {
  const host = process.env.TABLOOM_HOST ?? "127.0.0.1";
  if (!LOOPBACKS.has(host)) {
    throw new Error(`Refusing non-loopback bind ${JSON.stringify(host)}: the organizer app is local only.`);
  }
  return host;
}

export async function main(): Promise<void> {
  const tabloom = new TabloomService(process.env.TABLOOM_DATA_PATH || join(homedir(), ".local", "share", "tabloom", "tabloom.json"));
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (await handleTabloom(req, res, tabloom)) return;
      if (req.url === "/healthz" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, service: "tabloom" }));
        return;
      }
      if (req.url === "/" && req.method === "GET") {
        res.writeHead(302, { location: "/tabloom/" });
        res.end();
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    } catch (err) {
      console.error("request failed", err);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    }
  });
  const host = resolveHost();
  const port = resolvePort();
  await new TabloomGuestNetwork(tabloom).initialize();
  await new Promise<void>((resolve) => httpServer.listen(port, host, resolve));
  console.log(`Tabloom is running at http://${host}:${port}/tabloom/`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
