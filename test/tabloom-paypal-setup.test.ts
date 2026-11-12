import test from "node:test";
import assert from "node:assert/strict";
import {checkPayPalSandboxConnection} from "../src/tabloom-paypal-setup.js";
const env = {TABLOOM_PAYPAL_CLIENT_ID:"sandbox-id",TABLOOM_PAYPAL_CLIENT_SECRET:"private-test-secret"};
const transport = (fn: (...args: Parameters<typeof fetch>) => Promise<Response>) => fn as typeof fetch;
test("missing credentials are named without contacting PayPal", async () => {
  const result = await checkPayPalSandboxConnection({env:{TABLOOM_PAYPAL_CLIENT_ID:"  "},fetch:transport(async()=>{throw Error("must not call");})});
  assert.equal(result.status,"missing"); assert.deepEqual(result.missing,["clientId","clientSecret"]);
  assert.ok(Number.isFinite(Date.parse(result.observedAt)));
});
test("connection checks only fixed Sandbox OAuth and never disclose credentials or token", async () => {
  const calls: string[]=[];
  const result=await checkPayPalSandboxConnection({env,fetch:transport(async(url,init)=>{
    calls.push(String(url)); assert.equal(init?.method,"POST"); assert.equal(init?.redirect,"error");
    assert.equal(init?.body,"grant_type=client_credentials");
    assert.equal(new Headers(init?.headers).get("Authorization"),"Basic "+Buffer.from("sandbox-id:private-test-secret").toString("base64"));
    return Response.json({access_token:"private-oauth-token",token_type:"Bearer"});
  })});
  assert.equal(result.status,"ready"); assert.deepEqual(calls,["https://api-m.sandbox.paypal.com/v1/oauth2/token"]);
  assert.doesNotMatch(JSON.stringify(result),/private-test-secret|private-oauth-token|sandbox-id/);
});
test("credential rejection differs from service outage and never echoes provider bodies", async () => {
  for(const status of [400,401,403,429,500]) {
    const result=await checkPayPalSandboxConnection({env,fetch:transport(async()=>new Response("private-test-secret",{status}))});
    assert.equal(result.status,status<429?"rejected":"unreachable");
    assert.doesNotMatch(JSON.stringify(result),/private-test-secret/);
  }
});
test("malformed success and thrown transport errors cannot imply readiness", async () => {
  for(const response of [{},{access_token:"x"},{access_token:"",token_type:"Bearer"},{access_token:"x",token_type:"other"}]) {
    assert.equal((await checkPayPalSandboxConnection({env,fetch:transport(async()=>Response.json(response))})).status,"unreachable");
  }
  const result=await checkPayPalSandboxConnection({env,fetch:transport(async()=>{throw Error("private-test-secret");})});
  assert.equal(result.status,"unreachable");assert.doesNotMatch(JSON.stringify(result),/private-test-secret/);
});
test("whole check is bounded even when response body ignores abort", async () => {
  let signal: AbortSignal | undefined;
  const result=await checkPayPalSandboxConnection({env,timeoutMs:10,fetch:transport(async(_url,init)=>{
    signal=init?.signal??undefined;
    return {ok:true,status:200,json:()=>new Promise(()=>{})} as unknown as Response;
  })});
  assert.equal(result.status,"unreachable");assert.equal(signal?.aborted,true); assert.match(result.message,/timed out/);
});
