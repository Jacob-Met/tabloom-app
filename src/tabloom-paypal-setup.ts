/** An explicit, non-payment check. Never returns or persists OAuth credentials. */
export type SandboxConnection = {
  status: "missing" | "rejected" | "unreachable" | "ready";
  observedAt: string;
  message: string;
  missing?: Array<"clientId" | "clientSecret">;
};
export async function checkPayPalSandboxConnection(options: {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
} = {}): Promise<SandboxConnection> {
  const env = options.env ?? process.env;
  const clientId = env.TABLOOM_PAYPAL_CLIENT_ID?.trim();
  const secret = env.TABLOOM_PAYPAL_CLIENT_SECRET?.trim();
  const result = (status: SandboxConnection["status"], message: string): SandboxConnection =>
    ({status, observedAt: new Date().toISOString(), message});
  const missing: Array<"clientId" | "clientSecret"> = [];
  if (!clientId) missing.push("clientId");
  if (!secret) missing.push("clientSecret");
  if (missing.length) return {...result("missing", "Add the Sandbox app client ID and secret to the server environment, then restart Tabloom and check again."), missing};
  const controller = new AbortController();
  const requested = options.timeoutMs ?? 8000;
  const timeoutMs = Number.isFinite(requested) ? Math.max(1, Math.min(requested, 15000)) : 8000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<SandboxConnection>(resolve => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(result("unreachable", "The Sandbox connection check timed out. Check the server's internet connection and try again."));
    }, timeoutMs);
  });
  const check = async (): Promise<SandboxConnection> => {
    try {
      const response = await (options.fetch ?? globalThis.fetch)("https://api-m.sandbox.paypal.com/v1/oauth2/token", {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {"Authorization": "Basic " + Buffer.from(clientId + ":" + secret).toString("base64"), "Content-Type": "application/x-www-form-urlencoded"},
        body: "grant_type=client_credentials",
      });
      if (response.status === 400 || response.status === 401 || response.status === 403)
        return result("rejected", "PayPal Sandbox rejected this connection. Confirm that both values belong to the same Sandbox app, update the server environment, and restart Tabloom.");
      if (!response.ok)
        return result("unreachable", "PayPal Sandbox is unavailable for this check. Try again later; no payment was requested.");
      const data: unknown = await response.json();
      if (!data || typeof data !== "object" || !("access_token" in data) ||
          typeof data.access_token !== "string" || !data.access_token.trim() ||
          !("token_type" in data) || typeof data.token_type !== "string" ||
          data.token_type.toLowerCase() !== "bearer")
        return result("unreachable", "PayPal Sandbox returned an incomplete connection response. Try again; no payment was requested.");
      return result("ready", "Connected to PayPal Sandbox. This checks the app credentials only; each buyer still needs to approve their own Sandbox checkout.");
    } catch {
      return result("unreachable", "Could not reach PayPal Sandbox. Check the server's internet connection and try again.");
    }
  };
  try { return await Promise.race([check(), timeout]); }
  finally { if (timer) clearTimeout(timer); }
}
