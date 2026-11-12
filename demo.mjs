// Simulated demo: `npm run demo` (or `node demo.mjs`) after `npm install && npm run build`.
// Runs the normal app with an in-process fake PayPal Sandbox and a canned AI answer.
// Nothing here touches the network, reads PayPal keys, or needs a local model.
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
if (!existsSync(join(here, "dist", "src", "tabloom-service.js"))) {
  console.error("Build first: npm install && npm run build");
  process.exit(1);
}
const port = Number(process.env.TABLOOM_PORT || 3000);
const origin = `http://127.0.0.1:${port}`;
const SB = "https://www.sandbox.paypal.com/checkoutnow?token=";
const SAMPLE = {
  title: "Noor’s birthday dinner",
  guests: "Noor\nIdris\nCamille\nTomas",
  receipt: "Lamb tagine 26.00\nGrilled sea bass 29.00\nMezze platter 18.00\nSaffron rice 7.00\nMint tea pot 8.00\nBirthday cake 9.00\nTax 8.00\nTip 19.40\nTotal 124.40",
  chat: [ // chat intake
    "[11/12/26, 9:41 PM] Idris: I paid the bill, tell me what you had and I'll send requests",
    "[11/12/26, 9:42 PM] Camille: I had the lamb tagine and shared the mezze with Tomas",
    "[11/12/26, 9:42 PM] Tomas: lamb tagine for me too, and the mezze platter with Camille",
    "[11/12/26, 9:43 PM] Idris: I had the grilled sea bass and the lamb tagine",
    "[11/12/26, 9:43 PM] Noor: <Media omitted>",
    "[11/12/26, 9:44 PM] Camille: it's Noor's birthday, she pays nothing for her own food. Idris, Tomas and I split the birthday cake",
    "[11/12/26, 9:45 PM] Tomas: Everyone had the saffron rice and the mint tea pot",
    "[11/12/26, 9:45 PM] Noor: thank you all!!"
  ].join("\n"),
  note: "It was Noor’s birthday so she pays nothing for her own food. Idris, Camille and Tomas split the lamb tagine and the birthday cake. Only Idris had the grilled sea bass. Camille and Tomas shared the mezze platter. Everyone had the saffron rice and the mint tea pot."
};

// voice intake: what the real listener returned for the bundled sample recording (tabloom/sample/table-talk.wav).
const VOICE_RESULT = {"speakers":4,"duration":24.57,"segments":[{"speaker":"S1","start":0.0,"end":5.42,"text":"I'm Idris. I had the grilled sea base and I shared the lamb tagine with Camille and Tomas."},{"speaker":"S2","start":6.8,"end":11.68,"text":"Camille here. I split the mez platter with Tomas and I had a third of the tagine."},{"speaker":"S3","start":12.36,"end":18.26,"text":"And I had the mez with Camille. The rice and the mint tea were shared between the three of us."},{"speaker":"S4","start":19.22,"end":23.32,"text":"I'm Noor and it's my birthday, so I only had a slice of the birthday cake."}]};

// Replace the whole environment the app reads: fake credentials, fake model URL, throwaway data.
for (const key of Object.keys(process.env)) if (/^(TABLOOM_|HOUSEHOLD_LEDGER_)/.test(key)) Reflect.deleteProperty(process.env, key);
Object.assign(process.env, {
  TABLOOM_PORT: String(port), TABLOOM_PAYPAL_CLIENT_ID: "SIMULATED", TABLOOM_PAYPAL_CLIENT_SECRET: "SIMULATED",
  TABLOOM_VOICE_CANNED: JSON.stringify(VOICE_RESULT), // voice intake: canned listener answer for tabloom/sample/table-talk.wav
  TABLOOM_AI_URL: "http://127.0.0.1:1/api/chat", TABLOOM_AI_MODEL: "simulated-canned-answer",
  TABLOOM_DATA_PATH: join(mkdtempSync(join(tmpdir(), "tabloom-demo-")), "tabloom.json")
});

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const wait = ms => new Promise(r => setTimeout(r, ms));

// ---- fake PayPal: token, create order, get order, capture ----
const orders = new Map();
const payPal = async (method, pathname, body) => {
  if (pathname === "/v1/oauth2/token")
    return json({ scope: "https://uri.paypal.com/services/payments/payment", access_token: "SIMULATED-ACCESS-TOKEN", token_type: "Bearer", app_id: "APP-SIMULATED", expires_in: 32400, nonce: "simulated" });
  if (method === "POST" && pathname === "/v2/checkout/orders") {
    const unit = body.purchase_units[0], id = "SIM" + randomBytes(7).toString("hex").toUpperCase();
    orders.set(id, { id, status: "CREATED", unit, returnUrl: body.payment_source?.paypal?.experience_context?.return_url || origin + "/tabloom/", captures: [] });
    return json({ id, status: "PAYER_ACTION_REQUIRED", links: [
      { href: "https://api-m.sandbox.paypal.com/v2/checkout/orders/" + id, rel: "self", method: "GET" },
      { href: SB + id, rel: "payer-action", method: "GET" }] }, 201);
  }
  const m = pathname.match(/^\/v2\/checkout\/orders\/([A-Z0-9]+)(\/capture)?$/), o = m && orders.get(m[1]);
  if (!o) return json({ name: "RESOURCE_NOT_FOUND", message: "The specified resource does not exist." }, 404);
  const view = () => ({ id: o.id, intent: "CAPTURE", status: o.status,
    purchase_units: [{ reference_id: o.unit.reference_id, description: o.unit.description, amount: o.unit.amount, ...(o.captures.length ? { payments: { captures: o.captures } } : {}) }] });
  if (method === "GET" && !m[2]) return json(view());
  if (method === "POST" && m[2]) {
    if (o.status !== "APPROVED") return json({ name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_NOT_APPROVED" }] }, 422);
    o.captures = [{ id: "SIMCAP" + randomBytes(5).toString("hex").toUpperCase(), status: "COMPLETED", amount: o.unit.amount, final_capture: true }];
    o.status = "COMPLETED";
    return json(view(), 201);
  }
  return json({ name: "NOT_FOUND" }, 404);
};

// ---- canned AI answer: an Ollama /api/chat reply, fixed for the built-in sample note ----
const WHO = [[/tagine|cake/i, ["Idris", "Camille", "Tomas"], "Idris, Camille and Tomas split the lamb tagine and the birthday cake."],
  [/sea bass/i, ["Idris"], "Only Idris had the grilled sea bass."],
  [/mezze/i, ["Camille", "Tomas"], "Camille and Tomas shared the mezze platter."],
  [/rice|tea/i, ["Idris", "Camille", "Tomas"], "Everyone had the saffron rice and the mint tea pot; Noor pays nothing for her own food."]];
const CHAT_WHO = [[/tagine/i, ["Idris", "Camille", "Tomas"], "Camille said: I had the lamb tagine; Tomas said: lamb tagine for me too; Idris said: I had the lamb tagine."], // chat intake
  [/cake/i, ["Idris", "Camille", "Tomas"], "Camille said: Idris, Tomas and I split the birthday cake (it is Noor's birthday)."],
  [/sea bass/i, ["Idris"], "Idris said: I had the grilled sea bass."],
  [/mezze/i, ["Camille", "Tomas"], "Camille said: shared the mezze with Tomas; Tomas said: the mezze platter with Camille."],
  [/rice|tea/i, ["Idris", "Camille", "Tomas"], "Tomas said: Everyone had the saffron rice and the mint tea pot; Camille said Noor pays nothing for her own food."]];
const model = async body => {
  await wait(1200);
  const { guests, items, tableNote } = JSON.parse(body.messages.at(-1).content);
  const rules = /\bsaid: /.test(tableNote || "") ? CHAT_WHO : WHO; // chat intake
  const assignments = items.map(item => {
    const rule = rules.find(([re]) => re.test(item.name));
    return { itemId: item.id, guestIds: rule ? rule[1].map(n => guests.find(g => g.name === n)?.id).filter(Boolean) : [], reason: rule ? rule[2] : "The note does not say who had this item." };
  });
  return json({ model: "simulated", created_at: new Date().toISOString(), message: { role: "assistant", content: JSON.stringify({ assignments }) }, done: true, done_reason: "stop" });
};

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url)), body = typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : undefined;
  if (u.hostname === "api-m.sandbox.paypal.com") return payPal(init.method || "GET", u.pathname, body);
  if (u.hostname === "127.0.0.1" && u.port === "1" && u.pathname === "/api/chat") return model(body);
  throw new TypeError("Simulated demo: network access is disabled (" + u.hostname + ")");
};

// ---- the normal app (same wiring as src/index.ts) plus demo-only routes ----
const { TabloomService, handleTabloom } = await import("./dist/src/tabloom-service.js");
const { TabloomGuestNetwork } = await import("./dist/src/tabloom-guest-network.js");
const tabloom = new TabloomService(process.env.TABLOOM_DATA_PATH);
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; base-uri 'none'; form-action 'self'; object-src 'none'; frame-ancestors 'none'"; // same as tabloom-service.ts
const send = (res, status, type, text) => { res.writeHead(status, { "content-type": type, "content-security-policy": CSP, "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(text); };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const badgeJs = `(function(){
  var SB=${JSON.stringify(SB)},S=${JSON.stringify(SAMPLE)};
  var b=document.createElement("div");b.className="sim-badge";b.setAttribute("role","note");b.textContent="Simulated demo: no real PayPal call";document.body.prepend(b);
  var sample={"new-table-title":S.title,"new-table-guests":S.guests,"receipt-text":S.receipt,"bill-note":S.note,"chat-text":S.chat};
  var typed={};
  document.addEventListener("input",function(ev){if(ev.isTrusted&&ev.target.id)typed[ev.target.id]=true;},true);
  function fix(){
    // The fake PayPal returns a realistic sandbox link (the page only accepts those); point it at the local approval page instead.
    document.querySelectorAll('a[href^="'+SB+'"]').forEach(function(a){a.href="/demo/paypal/approve?order="+a.getAttribute("href").slice(SB.length);});
    // Preload the sample input into each empty field that is on screen (table fields only once a table is open), until the visitor types in it.
    Object.keys(sample).forEach(function(id){var e=document.getElementById(id);if(e&&!typed[id]&&!e.value&&e.offsetParent&&(/^new-/.test(id)||/table=/.test(location.search))){e.value=sample[id];e.dispatchEvent(new Event("input",{bubbles:true}));}});
  }
  new MutationObserver(fix).observe(document.documentElement,{childList:true,subtree:true,attributes:true});setInterval(fix,400);fix();
})();`;
const httpServer = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", origin);
    if (req.method === "GET" && url.pathname === "/tabloom/demo-badge.css") return send(res, 200, "text/css; charset=utf-8", readFileSync(join(here, "demo-badge.css")));
    if (req.method === "GET" && url.pathname === "/tabloom/demo-badge.js") return send(res, 200, "text/javascript; charset=utf-8", badgeJs);
    if (req.method === "GET" && (url.pathname === "/tabloom" || url.pathname === "/tabloom/")) {
      const html = readFileSync(join(here, "dist", "tabloom", "index.html"), "utf8").replace("</head>", '<link rel="stylesheet" href="/tabloom/demo-badge.css"></head>').replace("</body>", '<script src="/tabloom/demo-badge.js" defer></script></body>');
      return send(res, 200, "text/html; charset=utf-8", html);
    }
    if (url.pathname === "/demo/paypal/approve") {
      if (req.method === "POST") {
        let raw = ""; for await (const c of req) raw += c;
        const form = new URLSearchParams(raw), o = orders.get(form.get("order"));
        if (!o) return send(res, 404, "text/plain", "Unknown simulated order.");
        if (form.get("action") === "approve" && o.status === "CREATED") o.status = "APPROVED";
        const back = new URL(o.returnUrl); back.searchParams.set("token", o.id);
        res.writeHead(303, { Location: back.href }); return res.end();
      }
      const o = orders.get(url.searchParams.get("order"));
      if (!o) return send(res, 404, "text/plain", "Unknown simulated order.");
      return send(res, 200, "text/html; charset=utf-8", `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Simulated PayPal approval</title><link rel="stylesheet" href="/tabloom/demo-badge.css"><script src="/tabloom/demo-badge.js" defer></script></head><body class="sim-page"><main class="sim-card"><h1>Simulated PayPal approval</h1><p>This page stands in for PayPal's hosted approval page. No real PayPal account or card is involved.</p><p><b>${esc(o.unit.description)}</b><br>$${esc(o.unit.amount.value)} ${esc(o.unit.amount.currency_code)}<br>Order ${esc(o.id)}</p><form method="post" action="/demo/paypal/approve"><input type="hidden" name="order" value="${esc(o.id)}"><button type="submit" name="action" value="approve" id="sim-approve">Approve</button> <button type="submit" name="action" value="cancel" class="sim-secondary">Cancel</button></form></main></body></html>`);
    }
    if (await handleTabloom(req, res, tabloom)) return;
    if (req.url === "/" && req.method === "GET") { res.writeHead(302, { location: "/tabloom/" }); return res.end(); }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  } catch (err) {
    console.error("request failed", err);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "internal error" }));
  }
});
await new TabloomGuestNetwork(tabloom).initialize();
await new Promise(resolve => httpServer.listen(port, "127.0.0.1", resolve));
console.log(`Tabloom SIMULATED demo: ${origin}/tabloom/\nFake PayPal Sandbox and a canned AI answer; no keys, no model, no network.`);
