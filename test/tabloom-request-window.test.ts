import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";import {join} from "node:path";
import {TabloomService} from "../src/tabloom-service.js";
import {fixtureBill,paymentRetryAllowed,Payment} from "../src/tabloom.js";
test("unresolved request retries retain history and stop outside known retention",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"tabloom-window-")),path=join(dir,"bill.json"),old=[process.env.TABLOOM_PAYPAL_CLIENT_ID,process.env.TABLOOM_PAYPAL_CLIENT_SECRET];
 process.env.TABLOOM_PAYPAL_CLIENT_ID="synthetic";process.env.TABLOOM_PAYPAL_CLIENT_SECRET="synthetic";
 try{
  const now=Date.now(),base:Payment={status:"unknown_order",amountCents:2437,requestId:"original"};
  assert.equal(paymentRetryAllowed({...base,requestStartedAt:new Date(now-6*3600000).toISOString()},now),false);
  assert.equal(paymentRetryAllowed({...base,requestStartedAt:new Date(now-6*3600000+20001).toISOString()},now),true);
  for(const status of ["unknown_order","creating","capture_unknown"] as const)for(const stamp of [undefined,"invalid",new Date(now-6*3600000-1000).toISOString(),new Date(now+60000).toISOString()]){
   const b=fixtureBill();b.payments.mira={...base,status,requestStartedAt:stamp,captureStartedAt:stamp,...(status==="capture_unknown"?{orderId:"ORIGINAL",captureRequestId:"original-capture"}:{})};await writeFile(path,JSON.stringify(b));const before=await readFile(path,"utf8");let requests=0;
   const svc=new TabloomService(path,(async()=>{requests++;throw Error("No provider request permitted");}) as typeof fetch);
   await assert.rejects(()=>status==="capture_unknown"?svc.capture("mira"):svc.createOrder("mira",0),/review/);assert.equal(requests,0);assert.equal(await readFile(path,"utf8"),before);assert.equal((await svc.state()).paymentRetries.mira,false);
  }
  await rm(path);let posts=0;const keys:string[]=[],bodies:string[]=[];
  const svc=new TabloomService(path,(async(u,init)=>{
   if(String(u).endsWith("/v1/oauth2/token"))return new Response(JSON.stringify({access_token:"fixture"}));
   assert.equal(init?.method,"POST");assert.ok(String(u).endsWith("/v2/checkout/orders"));const saved=JSON.parse(await readFile(path,"utf8")).payments.mira;assert.ok(saved.requestStartedAt);assert.equal(saved.captureRequestId,undefined);
   keys.push((init?.headers as Record<string,string>)["PayPal-Request-Id"]);bodies.push(String(init?.body));posts++;
   if(posts===1)throw Error("simulated lost response");return new Response(JSON.stringify({id:"ORIGINAL1",links:[{rel:"approve",href:"https://www.sandbox.paypal.com/checkoutnow?token=ORIGINAL1"}]}));
  }) as typeof fetch);
  await assert.rejects(()=>svc.createOrder("mira",0),/lost response/);const first=JSON.parse(await readFile(path,"utf8")).payments.mira;
  await svc.createOrder("mira",0);const after=JSON.parse(await readFile(path,"utf8")).payments.mira;
  assert.equal(posts,2);assert.equal(keys[0],keys[1]);assert.equal(bodies[0],bodies[1]);assert.equal(after.requestStartedAt,first.requestStartedAt);assert.equal(after.orderId,"ORIGINAL1");
 }finally{for(const[i,k]of ["TABLOOM_PAYPAL_CLIENT_ID","TABLOOM_PAYPAL_CLIENT_SECRET"].entries()){if(old[i]===undefined)delete process.env[k];else process.env[k]=old[i];}await rm(dir,{recursive:true,force:true});}
});

test("OAuth elapsed time cannot dispatch an unresolved POST without its full timeout budget",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"tabloom-deadline-")),path=join(dir,"bill.json");
 const old=[process.env.TABLOOM_PAYPAL_CLIENT_ID,process.env.TABLOOM_PAYPAL_CLIENT_SECRET],realNow=Date.now;
 process.env.TABLOOM_PAYPAL_CLIENT_ID="synthetic";process.env.TABLOOM_PAYPAL_CLIENT_SECRET="synthetic";
 try{
  for(const status of ["unknown_order","capture_unknown"] as const)for(const remaining of [5000,25000]){
   let now=realNow(),oauth=0,posts=0;Date.now=()=>now;
   const started=new Date(now-6*3600000+remaining).toISOString();const bill=fixtureBill();
   bill.payments.mira={status,amountCents:2437,requestId:"original-create",requestStartedAt:started,...(status==="capture_unknown"?{orderId:"ORIGINAL",captureRequestId:"original-capture",captureStartedAt:started}:{})};
   await writeFile(path,JSON.stringify(bill));
   const svc=new TabloomService(path,(async(u)=>{if(String(u).endsWith("/v1/oauth2/token")){oauth++;now+=10000;return new Response(JSON.stringify({access_token:"fixture"}));}posts++;throw Error("must not dispatch");}) as typeof fetch);
   await assert.rejects(()=>status==="unknown_order"?svc.createOrder("mira",0):svc.capture("mira"),/review/);
   assert.equal(oauth,remaining===5000?0:1);assert.equal(posts,0);
   const saved=JSON.parse(await readFile(path,"utf8")).payments.mira;assert.deepEqual(saved,bill.payments.mira);
  }
 }finally{Date.now=realNow;for(const[i,k]of ["TABLOOM_PAYPAL_CLIENT_ID","TABLOOM_PAYPAL_CLIENT_SECRET"].entries()){if(old[i]===undefined)delete process.env[k];else process.env[k]=old[i];}await rm(dir,{recursive:true,force:true});}
});
