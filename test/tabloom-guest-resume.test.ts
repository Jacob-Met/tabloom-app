import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { privateGuestAddresses } from "../src/tabloom-guest-network.js";
import { fixtureBill } from "../src/tabloom.js";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
async function waitFor<T>(check: () => Promise<T>, timeout = 12000): Promise<T> {
  const start = Date.now();
  let last: unknown;
  while (Date.now() - start < timeout) {
    try { const result = await check(); if (result) return result; }
    catch (error) { last = error; }
    await pause(75);
  }
  throw new Error("App did not become ready: " + String(last));
}
async function closeProcess(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await waitFor(async () => child.exitCode !== null || child.signalCode !== null, 5000)
    .catch(async () => { child.kill("SIGKILL"); await pause(100); });
}

test("actual app restart preserves the original guest URL, expiry and saved dinner, while occupied resume and Stop never move or revive it", { timeout: 50000 }, async t => {
  const address = privateGuestAddresses()[0]?.address;
  if (!address) { t.skip("This host has no assigned private IPv4 interface."); return; }
  const directory = await fs.mkdtemp(join(tmpdir(), "tabloom-resume-"));
  const dataPath = join(directory, "dinner.json");
  const bill = fixtureBill();
  bill.title = "After-hours noodles";
  bill.note = "PRIVATE ORGANIZER NOTE";
  bill.guests[0].name = "Etta";
  bill.guests[1].name = "Noor";
  const original = JSON.stringify(bill, null, 2) + "\n";
  await fs.writeFile(dataPath, original, { mode: 0o600 });
  const port = await freePort();
  const organizer = "http://127.0.0.1:" + port + "/tabloom/api/";
  const children: ChildProcess[] = [];
  let occupied: ReturnType<typeof createServer> | undefined;

  async function api(path: string, body?: unknown) {
    const response = await fetch(organizer + path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { response, data: await response.json() as any };
  }
  async function startApp() {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../src/index.js", import.meta.url))], {
      env: { ...process.env, TABLOOM_HOST: "127.0.0.1", TABLOOM_PORT: String(port),
        TABLOOM_DATA_PATH: dataPath,
        TABLOOM_GUEST_URL: "", TABLOOM_AI_URL: "", TABLOOM_AI_MODEL: "",
        TABLOOM_PAYPAL_CLIENT_ID: "", TABLOOM_PAYPAL_CLIENT_SECRET: "" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    children.push(child);
    let output = "";
    child.stdout?.on("data", data => { output += String(data); });
    child.stderr?.on("data", data => { output += String(data); });
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(output);
      const result = await api("guest-network");
      return result.response.ok;
    });
    return child;
  }

  try {
    let child = await startApp();
    assert.equal((await api("guest-network")).data.enabled, false);
    const enabled = await api("guest-network/start", { address });
    assert.equal(enabled.response.status, 200);
    const origin = enabled.data.origin as string;
    const invitation = (await api("guest-links/create", { guestId: bill.guests[0].id })).data;
    assert.equal((await fetch(invitation.checkoutUrl)).status, 200);
    const spare=(await api("guest-links/create",{guestId:bill.guests[1].id})).data;
    const firstItems=bill.items.map(item=>({id:item.id,selected:item.sharedBy.includes(bill.guests[0].id)||item.id==="dumplings"}));
    assert.equal((await fetch(invitation.url+"/response",{method:"POST",headers:{"content-type":"application/json",origin},body:JSON.stringify({items:firstItems})})).status,200);
    const originalExpiry = invitation.expiresAt;
    const storedPath = dataPath + ".guest-invitations.json";
    assert.equal((await fs.stat(storedPath)).mode & 0o777, 0o600);
    await closeProcess(child);

    child = await startApp();
    const resumed = (await api("guest-network")).data;
    assert.equal(resumed.enabled, true);
    assert.equal(resumed.origin, origin, "restart must not choose a new return address or port");
    const links = (await api("guest-links")).data.links;
    const same = links.find((link: any) => link.id === invitation.id);
    assert.ok(same);
    assert.equal(same.expiresAt, originalExpiry, "restart must not renew the invitation lifetime");
    assert.equal(same.checkoutUrl, invitation.checkoutUrl);
    const returned = await fetch(invitation.checkoutUrl + "?returned=1");
    assert.equal(returned.status, 200);
    const html = await returned.text();
    assert.match(html, /Etta/);
    assert.ok(!html.includes("PRIVATE ORGANIZER NOTE"));
    assert.ok(!html.includes("Noor"));
    assert.equal(await fs.readFile(dataPath, "utf8"), original);
    await closeProcess(child);

    const prior = new URL(origin);
    occupied = createServer((_req, res) => { res.end("unrelated listener"); });
    await new Promise<void>((resolve, reject) => {
      occupied!.once("error", reject);
      occupied!.listen(Number(prior.port), prior.hostname, () => resolve());
    });
    child = await startApp();
    const blocked = (await api("guest-network")).data;
    assert.equal(blocked.enabled, false);
    assert.equal(blocked.origin, null);
    assert.equal(blocked.remembered, true);
    assert.equal(blocked.resumeOrigin, origin);
    assert.equal((await api("guest-links/response",{id:invitation.id})).response.status,200);
    assert.equal((await api("guest-links/revoke",{id:spare.id})).response.status,200);
    const pausedStorage=JSON.parse(await fs.readFile(storedPath,"utf8"));
    assert.equal(pausedStorage.sessions.find((row:any)=>row.id===invitation.id).stopped,false,"pausing must not durably stop other original invitations");
    assert.equal((await api("guest-network/start", { address })).response.status, 503);
    assert.equal(await (await fetch(origin)).text(), "unrelated listener");
    await new Promise<void>(resolve => { occupied!.close(() => resolve()); occupied!.closeIdleConnections(); });
    occupied = undefined;
    const recovered = await api("guest-network/start", { address });
    assert.equal(recovered.response.status, 200);
    assert.equal(recovered.data.origin, origin);
    assert.equal((await fetch(invitation.checkoutUrl)).status, 200);

    const items=bill.items.map(item=>({id:item.id,selected:item.sharedBy.includes(bill.guests[0].id)||item.id==="dumplings"}));
    const submitted=await fetch(invitation.url+"/response",{method:"POST",headers:{"content-type":"application/json",origin},body:JSON.stringify({items})});
    assert.equal(submitted.status,200);
    const received=(await api("guest-links/response",{id:invitation.id})).data;
    assert.ok(received.identity.responseId);
    assert.equal((await api("guest-network/stop", {})).response.status, 200);
    await closeProcess(child);
    child = await startApp();
    const stopped = (await api("guest-network")).data;
    assert.equal(stopped.enabled, false);
    assert.equal(stopped.remembered, false);
    assert.equal((await api("state")).data.guestLinksReady,false);
    const retained=(await api("guest-links")).data.links;
    assert.equal(retained.length,1);
    assert.equal(retained[0].stopped,true);
    assert.deepEqual((await api("guest-links/response",{id:invitation.id})).data,received);
    assert.equal((await api("guest-links/create",{guestId:bill.guests[0].id})).response.status,400);
    const stored=JSON.parse(await fs.readFile(storedPath,"utf8"));
    stored.sessions[0].expiresAt=Date.now()-1000;
    await fs.writeFile(storedPath,JSON.stringify(stored));
    await closeProcess(child);
    child=await startApp();
    assert.deepEqual((await api("guest-links/response",{id:invitation.id})).data,received,"received reply outlives invitation expiry");
    const preview=(await api("guest-review/preview",{response:received.response})).data;
    assert.equal(await fs.readFile(dataPath,"utf8"),original,"retaining and reviewing never saves the bill");
    const fresh = await api("guest-network/start", { address });
    assert.equal(fresh.response.status, 200);
    const oldPath = new URL(invitation.checkoutUrl).pathname;
    const revoked = await fetch(fresh.data.origin + oldPath);
    assert.equal(revoked.status, 410);
    assert.match(revoked.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(await fs.readFile(dataPath, "utf8"), original);
    assert.deepEqual((await api("guest-links/response",{id:invitation.id})).data,received);
    const saved=await api("bill",{bill:preview.bill,revision:bill.revision,guestResponse:received.identity});
    assert.equal(saved.response.status,200);
    assert.equal(saved.data.bill.revision,bill.revision+1);
    assert.equal((await api("bill",{bill:preview.bill,revision:bill.revision,guestResponse:received.identity})).response.status,409);
    await api("guest-network/stop", {});
  } finally {
    if (occupied) await new Promise<void>(resolve => { occupied!.close(() => resolve()); occupied!.closeIdleConnections(); });
    for (const child of children) await closeProcess(child);
    await fs.rm(directory, { recursive: true, force: true });
  }
});
