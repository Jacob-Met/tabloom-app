import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {TabloomService} from "../src/tabloom-service.js";
import {fixtureBill} from "../src/tabloom.js";
test("failed original-order observations survive restart without changing settlement history",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"provider-status-")),path=join(dir,"bill.json");
 const old=[process.env.TABLOOM_PAYPAL_CLIENT_ID,process.env.TABLOOM_PAYPAL_CLIENT_SECRET];
 process.env.TABLOOM_PAYPAL_CLIENT_ID="synthetic";process.env.TABLOOM_PAYPAL_CLIENT_SECRET="synthetic";
 let status="PAYER_ACTION_REQUIRED",amount="24.37",calls=0;
 const bill=fixtureBill();bill.payments.mira={status:"awaiting_approval",amountCents:2437,requestId:"original-create",orderId:"ORIGINAL"};
 await writeFile(path,JSON.stringify(bill));
 const fetcher=async(input:URL|string|Request,init?:RequestInit)=>{
  if(String(input).endsWith("/v1/oauth2/token"))return new Response(JSON.stringify({access_token:"fixture"}));
  assert.equal(init?.method,"GET");assert.match(String(input),/orders\/ORIGINAL$/);calls++;
  if(status==="NOT_FOUND")return new Response(JSON.stringify({name:"RESOURCE_NOT_FOUND"}),{status:404});
  return new Response(JSON.stringify({id:"ORIGINAL",status,purchase_units:[{reference_id:"mira",amount:{currency_code:"USD",value:amount}}]}));
 };
 try{
  let service=new TabloomService(path,fetcher as typeof fetch);
  let p=(await service.reconcile("mira")).payment;
  assert.equal(p.providerStatus,"PAYER_ACTION_REQUIRED");assert.equal(p.status,"awaiting_approval");assert.ok(p.providerCheckedAt);
  status="APPROVED";p=(await service.reconcile("mira")).payment;
  assert.equal(p.providerStatus,"APPROVED");assert.equal(p.captureRequestId,undefined);
  amount="99.00";await assert.rejects(()=>service.reconcile("mira"),/different or unreadable order/);
  p=(await service.state()).bill.payments.mira!;assert.equal(p.providerFailure?.reason,"order_mismatch");
  status="NOT_FOUND";await assert.rejects(()=>service.reconcile("mira"),/PayPal could not find this payment request.*organizer/);
  service=new TabloomService(path,fetcher as typeof fetch);
  p=(await service.state()).bill.payments.mira!;
  assert.equal(p.providerFailure?.reason,"not_found");assert.ok(p.providerFailure?.checkedAt);
  assert.equal(p.status,"awaiting_approval");assert.equal(p.providerStatus,"APPROVED");
  assert.equal(p.requestId,"original-create");assert.equal(p.orderId,"ORIGINAL");assert.equal(p.amountCents,2437);
  assert.equal(p.captureRequestId,undefined);assert.equal(p.paypalAppFingerprint,undefined);
  const before=await readFile(path,"utf8"),beforeCalls=calls;
  await assert.rejects(()=>service.capture("mira"),/Check the original payment status/);
  assert.equal(calls,beforeCalls);assert.equal(await readFile(path,"utf8"),before);
  status="APPROVED";amount="24.37";p=(await service.reconcile("mira")).payment;
  assert.equal(p.providerFailure,undefined);assert.equal(p.providerStatus,"APPROVED");assert.equal(p.status,"awaiting_approval");
 }finally{for(const[i,key]of ["TABLOOM_PAYPAL_CLIENT_ID","TABLOOM_PAYPAL_CLIENT_SECRET"].entries()){if(old[i]===undefined)delete process.env[key];else process.env[key]=old[i];}await rm(dir,{recursive:true,force:true});}
});
test("new requests retain app identity and reject changed connection before provider calls",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"provider-context-")),path=join(dir,"bill.json");
 const old=[process.env.TABLOOM_PAYPAL_CLIENT_ID,process.env.TABLOOM_PAYPAL_CLIENT_SECRET];
 process.env.TABLOOM_PAYPAL_CLIENT_ID="original-synthetic-app";process.env.TABLOOM_PAYPAL_CLIENT_SECRET="synthetic";
 const bill=fixtureBill();await writeFile(path,JSON.stringify(bill));let calls=0;
 const fetcher=async(input:URL|string|Request,init?:RequestInit)=>{
  calls++;
  if(String(input).endsWith("/v1/oauth2/token"))return new Response(JSON.stringify({access_token:"fixture"}));
  if(init?.method==="POST")return new Response(JSON.stringify({id:"ORIGINAL",links:[{rel:"payer-action",href:"https://sandbox.paypal.com/checkoutnow?token=ORIGINAL"}]}));
  return new Response(JSON.stringify({id:"ORIGINAL",status:"APPROVED",purchase_units:[{reference_id:"mira",amount:{currency_code:"USD",value:"24.37"}}]}));
 };
 try{
  const service=new TabloomService(path,fetcher as typeof fetch);
  const first=(await service.createOrder("mira",bill.revision)).payment;
  assert.match(first.paypalAppFingerprint!,/^[a-f0-9]{64}$/);
  assert(!JSON.stringify(first).includes("original-synthetic-app"));
  process.env.TABLOOM_PAYPAL_CLIENT_ID="different-synthetic-app";const before=calls;
  await assert.rejects(()=>service.reconcile("mira"),/original app/);
  await assert.rejects(()=>service.capture("mira"),/original app/);
  assert.equal(calls,before);
  const p=(await new TabloomService(path,fetcher as typeof fetch).state()).bill.payments.mira!;
  assert.equal(p.providerFailure?.reason,"connection_changed");assert.equal(p.orderId,first.orderId);assert.equal(p.requestId,first.requestId);
  process.env.TABLOOM_PAYPAL_CLIENT_ID="original-synthetic-app";
  const recovered=(await service.reconcile("mira")).payment;
  assert.equal(recovered.providerFailure,undefined);assert.equal(recovered.providerStatus,"APPROVED");assert.equal(recovered.captureId,undefined);
  const knownPaid={...recovered,status:"captured" as const,captureId:"KNOWN-CAPTURE"};
  const paidBill=JSON.parse(await readFile(path,"utf8"));paidBill.payments.mira=knownPaid;await writeFile(path,JSON.stringify(paidBill));
  process.env.TABLOOM_PAYPAL_CLIENT_ID="different-synthetic-app";const paidCalls=calls;
  assert.deepEqual((await service.createOrder("mira",bill.revision)).payment,knownPaid);
  assert.deepEqual((await service.capture("mira")).payment,knownPaid);assert.equal(calls,paidCalls);

 }finally{for(const[i,key]of ["TABLOOM_PAYPAL_CLIENT_ID","TABLOOM_PAYPAL_CLIENT_SECRET"].entries()){if(old[i]===undefined)delete process.env[key];else process.env[key]=old[i];}await rm(dir,{recursive:true,force:true});}
});

test("new request binds only after OAuth and before any possible order dispatch",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"provider-binding-")),path=join(dir,"bill.json");
 const old=[process.env.TABLOOM_PAYPAL_CLIENT_ID,process.env.TABLOOM_PAYPAL_CLIENT_SECRET];
 process.env.TABLOOM_PAYPAL_CLIENT_ID="initial-invalid-app";process.env.TABLOOM_PAYPAL_CLIENT_SECRET="synthetic";
 const bill=fixtureBill();await writeFile(path,JSON.stringify(bill));let oauthFails=true,loseResponse=true,calls=0;const requestIds:string[]=[];
 const fetcher=async(input:URL|string|Request,init?:RequestInit)=>{
  calls++;
  if(String(input).endsWith("/token"))return new Response(JSON.stringify(oauthFails?{error:"invalid_client"}:{access_token:"fixture"}),{status:oauthFails?401:200});
  const durable=JSON.parse(await readFile(path,"utf8")).payments.mira;
  assert.match(durable.paypalAppFingerprint,/^[a-f0-9]{64}$/);assert.equal(durable.paypalAppBindingPending,undefined);
  requestIds.push((init?.headers as Record<string,string>)["PayPal-Request-Id"]);
  if(loseResponse)throw Error("Response lost after possible order dispatch");
  return new Response(JSON.stringify({id:"ORIGINAL",links:[{rel:"payer-action",href:"https://sandbox.paypal.com/checkoutnow?token=ORIGINAL"}]}));
 };
 try{
  const service=new TabloomService(path,fetcher as typeof fetch);
  await assert.rejects(()=>service.createOrder("mira",bill.revision),/OAuth failed/);
  let p=(await service.state()).bill.payments.mira!;const originalRequest=p.requestId;
  assert.equal(p.paypalAppBindingPending,true);assert.equal(p.paypalAppFingerprint,undefined);assert.equal(requestIds.length,0);
  process.env.TABLOOM_PAYPAL_CLIENT_ID="corrected-app";oauthFails=false;
  await assert.rejects(()=>service.createOrder("mira",bill.revision),/Response lost/);
  p=(await service.state()).bill.payments.mira!;
  assert.equal(p.paypalAppBindingPending,undefined);assert.ok(p.paypalAppFingerprint);assert.equal(p.requestId,originalRequest);
  process.env.TABLOOM_PAYPAL_CLIENT_ID="another-app";const before=calls;
  await assert.rejects(()=>service.createOrder("mira",bill.revision),/original app/);assert.equal(calls,before);
  assert.deepEqual(requestIds,[originalRequest]);
  process.env.TABLOOM_PAYPAL_CLIENT_ID="corrected-app";loseResponse=false;
  const resumed=(await service.createOrder("mira",bill.revision)).payment;
  assert.equal(resumed.providerFailure,undefined);assert.equal(resumed.requestId,originalRequest);assert.equal(resumed.orderId,"ORIGINAL");
  assert.deepEqual(requestIds,[originalRequest,originalRequest]);
 }finally{for(const[i,key]of ["TABLOOM_PAYPAL_CLIENT_ID","TABLOOM_PAYPAL_CLIENT_SECRET"].entries()){if(old[i]===undefined)delete process.env[key];else process.env[key]=old[i];}await rm(dir,{recursive:true,force:true});}
});
