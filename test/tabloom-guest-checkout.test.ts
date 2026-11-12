import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TabloomService, handleTabloom } from "../src/tabloom-service.js";
import { TabloomGuestLinks } from "../src/tabloom-guest-links.js";
import type { Bill } from "../src/tabloom.js";

async function listening(server: Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return "http://127.0.0.1:" + (server.address() as {port:number}).port;
}
const dinner: Omit<Bill,"revision"|"payments"> = {
  title: "Willow ramen", note: "Private organizer note: birthday surprise.",
  guests: [{id:"ada",name:"Ada"},{id:"bo",name:"Bo"}],
  items: [
    {id:"noodles",name:"Mushroom noodles",cents:1263,sharedBy:["ada"]},
    {id:"sushi",name:"Salmon sushi",cents:981,sharedBy:["bo"]},
    {id:"tea",name:"Jasmine tea",cents:517,sharedBy:["ada","bo"]}
  ], taxCents:214, tipCents:427
};

async function setup() {
  const dir=await mkdtemp(join(tmpdir(),"tabloom-guest-payment-"));
  const priorId=process.env.TABLOOM_PAYPAL_CLIENT_ID, priorSecret=process.env.TABLOOM_PAYPAL_CLIENT_SECRET;
  process.env.TABLOOM_PAYPAL_CLIENT_ID="synthetic-client";
  process.env.TABLOOM_PAYPAL_CLIENT_SECRET="synthetic-secret";
  const orders: Array<{body:any;requestId:string}>=[];
  let approved=false, capturePosts=0, failCreateOnce=false, failCaptureOnce=false, pendingCapture=false;
  const captureKeys:string[]=[];
  const provider: typeof fetch=async(input,init) => {
    const url=String(input);
    assert.ok(url.startsWith("https://api-m.sandbox.paypal.com/"));
    if(url.endsWith("/token"))return Response.json({access_token:"synthetic-token"});
    if(url.endsWith("/orders")&&init?.method==="POST") {
      orders.push({body:JSON.parse(String(init.body)),requestId:(init.headers as Record<string,string>)["PayPal-Request-Id"]});
      if(failCreateOnce){failCreateOnce=false;throw new Error("Synthetic response lost after order acceptance");}
      return Response.json({id:"TESTORDERADA001",links:[{rel:"payer-action",href:"https://www.sandbox.paypal.com/checkoutnow?token=TESTORDERADA001"}]});
    }
    if(url.endsWith("/TESTORDERADA001")&&init?.method==="GET")return Response.json({
      id:"TESTORDERADA001",status:approved?"APPROVED":"CREATED",
      purchase_units:[{reference_id:"ada",amount:{currency_code:"USD",value:"18.75"},...(pendingCapture?{payments:{captures:[{id:"PENDINGADA",status:"PENDING",amount:{currency_code:"USD",value:"18.75"}}]}}:{})}]
    });
    if(url.endsWith("/TESTORDERADA001/capture")&&init?.method==="POST") {
      capturePosts++;
      captureKeys.push((init.headers as Record<string,string>)["PayPal-Request-Id"]);
      if(failCaptureOnce){failCaptureOnce=false;throw new Error("Synthetic lost capture response");}
      assert.equal((init.headers as Record<string,string>)["Prefer"],"return=representation");
      return Response.json({id:"TESTORDERADA001",status:"COMPLETED",purchase_units:[
        {reference_id:"ada",payments:{captures:[{id:"TESTCAPTUREADA001",status:"COMPLETED",amount:{currency_code:"USD",value:"18.75"}}]}}
      ]});
    }
    throw Error("Unexpected synthetic provider route");
  };
  const service=new TabloomService(join(dir,"bill.json"),provider);
  const guestServer=createServer((req,res)=>void links.handle(req,res));
  const guestOrigin=await listening(guestServer);
  const links=new TabloomGuestLinks(guestOrigin); service.links=links;
  const organizer=createServer((req,res)=>void handleTabloom(req,res,service));
  const organizerOrigin=await listening(organizer);
  await service.updateDraft(dinner,0);
  const post=async(url:string,body:unknown={})=>fetch(url,{method:"POST",headers:{"content-type":"application/json",origin:new URL(url).origin},body:JSON.stringify(body)});
  const organizerPost=async(path:string,body:unknown={})=>post(organizerOrigin+"/tabloom/api/"+path,body);
  return {service,links,orders,post,organizerPost,guestOrigin,organizerOrigin,
    approve:()=>{approved=true;}, failNextCreate:()=>{failCreateOnce=true;}, capturePosts:()=>capturePosts,
    failNextCapture:()=>{failCaptureOnce=true;}, reportPending:()=>{pendingCapture=true;}, captureKeys,
    async close(){
      await Promise.all([guestServer,organizer].map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))));
      if(priorId===undefined)delete process.env.TABLOOM_PAYPAL_CLIENT_ID;else process.env.TABLOOM_PAYPAL_CLIENT_ID=priorId;
      if(priorSecret===undefined)delete process.env.TABLOOM_PAYPAL_CLIENT_SECRET;else process.env.TABLOOM_PAYPAL_CLIENT_SECRET=priorSecret;
      await rm(dir,{recursive:true,force:true});
    }
  };
}

test("actual organizer and guest HTTP paths preserve saved share, approval boundary and own-only completion",async()=>{
  const h=await setup();
  try {
    const invitation=await (await h.organizerPost("guest-links/create",{guestId:"ada"})).json() as any;
    const initial=await (await fetch(invitation.checkoutUrl+"/state")).json() as any;
    assert.equal(initial.guestName,"Ada");assert.equal(initial.totalCents,1875);
    assert.equal(initial.taxCents,118);assert.equal(initial.tipCents,235);
    assert.equal(initial.payment,null);assert.equal(initial.lineItems.length,2);
    assert.ok(!JSON.stringify(initial).includes("Salmon sushi"));
    assert.ok(!JSON.stringify(initial).includes(dinner.note));
    assert.ok(!JSON.stringify(initial).includes('"name":"Bo"'));
    const refused=await h.post(invitation.checkoutUrl+"/order",{guestId:"bo",amountCents:1});
    assert.equal(refused.status,409);assert.equal(h.orders.length,0);

    const response=await h.organizerPost("payments/ada/order",{revision:1});
    assert.equal(response.status,200);
    const order=await response.json() as any;
    assert.equal(order.checkoutUrl,invitation.checkoutUrl);
    assert.equal(h.orders.length,1);
    assert.equal(h.orders[0].body.purchase_units[0].amount.value,"18.75");
    assert.equal(h.orders[0].body.purchase_units[0].reference_id,"ada");
    assert.equal(h.orders[0].body.payment_source.paypal.experience_context.return_url,invitation.checkoutUrl+"?returned=1");
    assert.equal(h.orders[0].body.payment_source.paypal.experience_context.cancel_url,invitation.checkoutUrl+"?returned=1");
    const redirect=await fetch(invitation.url,{redirect:"manual"});
    assert.equal(redirect.status,303);assert.equal(redirect.headers.get("location"),invitation.checkoutUrl);

    // A returned URL, forged payer and amount never count as PayPal approval.
    const returned=await fetch(invitation.checkoutUrl+"/state?returned=1&token=OTHER&PayerID=bo");
    assert.equal(returned.status,200);assert.equal(h.capturePosts(),0);
    const unapproved=await h.post(invitation.checkoutUrl+"/capture",{guestId:"bo",orderId:"OTHER",amountCents:1});
    assert.equal(unapproved.status,409);assert.equal(h.capturePosts(),0);
    const foreignOrigin=await fetch(invitation.checkoutUrl+"/capture",{method:"POST",headers:{"content-type":"application/json",origin:"https://elsewhere.invalid"},body:"{}"});
    assert.equal(foreignOrigin.status,403);assert.equal(h.capturePosts(),0);

    h.approve();
    const captured=await h.post(invitation.checkoutUrl+"/capture",{guestId:"bo",orderId:"OTHER",amountCents:1});
    assert.equal(captured.status,200);
    const packet=await captured.json() as any;
    assert.equal(packet.payment.status,"captured");
    assert.equal(packet.payment.amountCents,1875);
    assert.equal(packet.payment.captureId,"TESTCAPTUREADA001");
    for(const privateField of ["requestId","captureRequestId","returnUrl","synthetic-client","synthetic-secret","synthetic-token",dinner.note])assert.ok(!JSON.stringify(packet).includes(privateField));
    assert.equal(h.capturePosts(),1);
    await h.post(invitation.checkoutUrl+"/capture");assert.equal(h.capturePosts(),1);
    assert.equal((await h.service.state()).calculated.dues.find(d=>d.guestId==="ada")?.paidCents,1875);
    assert.equal((await h.service.state()).calculated.dues.find(d=>d.guestId==="bo")?.paidCents,0);
    const fresh=await h.links.create(h.service,"ada");
    assert.equal(fresh.id,invitation.id,"an active receipt keeps its invitation after payment");
    h.links.revoke("legacy",invitation.id);
    assert.equal((await h.post(invitation.checkoutUrl+"/capture")).status,410);
    assert.equal((await fetch(invitation.checkoutUrl+"/state")).status,410);
    const expiredPage=await fetch(invitation.checkoutUrl);
    assert.equal(expiredPage.status,410);assert.match(expiredPage.headers.get("content-type")??"",/text\/html/);
    const expiredHtml=await expiredPage.text();assert.match(expiredHtml,/reopen the existing dinner/);
    assert.ok(!expiredHtml.includes("TESTCAPTUREADA001"));assert.ok(!expiredHtml.includes(dinner.note));assert.ok(!expiredHtml.includes("Willow ramen"));
    assert.match((await fetch(invitation.checkoutUrl+"/state")).headers.get("content-type")??"",/application\/json/);
    assert.equal(h.capturePosts(),1);
  }finally{await h.close();}
});

test("changed saved dinner invalidates the earlier guest payment capability before a provider call",async()=>{
  const h=await setup();
  try {
    const invite=await h.links.create(h.service,"ada");
    await h.service.updateDraft({...dinner,title:"A different dinner"},1);
    assert.equal((await fetch(invite.checkoutUrl+"/state")).status,409);
    assert.equal((await h.post(invite.checkoutUrl+"/order")).status,409);
    assert.equal(h.orders.length,0);
    for(const path of ["/mcp","/tabloom/api/state","/tabloom/api/payments/bo/capture"]){
      assert.equal((await fetch(h.guestOrigin+path)).status,404);
    }
  } finally {await h.close();}
});

test("uncertain order retries keep the original payload and request identity through a fresh guest invitation",async()=>{
  const h=await setup();
  try {
    h.failNextCreate();
    const started=await h.organizerPost("payments/ada/order",{revision:1});
    assert.equal(started.status,502);assert.equal(h.orders.length,1);
    const first=h.orders[0];
    const payment=(await h.service.state()).bill.payments.ada;
    assert.equal(payment.status,"unknown_order");
    const old=h.links.list("legacy",1)[0];
    h.links.revoke("legacy",old.id);
    const fresh=await h.links.create(h.service,"ada");
    assert.notEqual(fresh.url,old.url);
    const retry=await h.post(fresh.checkoutUrl+"/order");
    assert.equal(retry.status,200);assert.equal(h.orders.length,2);
    assert.deepEqual(h.orders[1],first);
    assert.equal((await retry.json() as any).payment.status,"awaiting_approval");
    assert.equal((await h.service.state()).bill.payments.ada.requestId,payment.requestId);
    assert.equal((await fetch(old.checkoutUrl+"/state")).status,410);
  }finally{await h.close();}
});

test("guest status check preserves an uncertain capture for a deliberate retry with the original request",async()=>{
  const h=await setup();
  try {
    const requested=await (await h.organizerPost("payments/ada/order",{revision:1})).json() as any;
    h.approve();h.failNextCapture();
    assert.equal((await h.post(requested.checkoutUrl+"/capture")).status,502);
    const lost=(await h.service.state()).bill.payments.ada;
    assert.equal(lost.status,"capture_unknown");
    const checked=await h.post(requested.checkoutUrl+"/reconcile");
    assert.equal(checked.status,200);
    assert.equal((await checked.json() as any).payment.status,"capture_unknown");
    assert.equal(h.capturePosts(),1,"a status check does not replay a capture");
    const retried=await h.post(requested.checkoutUrl+"/capture");
    assert.equal(retried.status,200);
    assert.equal((await retried.json() as any).payment.status,"captured");
    assert.deepEqual(h.captureKeys,[lost.captureRequestId,lost.captureRequestId]);
  }finally{await h.close();}
});

test("a provider-reported pending capture stays pending and cannot be posted again",async()=>{
  const h=await setup();
  try {
    const requested=await (await h.organizerPost("payments/ada/order",{revision:1})).json() as any;
    h.approve();h.failNextCapture();
    await h.post(requested.checkoutUrl+"/capture");
    h.reportPending();
    const checked=await h.post(requested.checkoutUrl+"/reconcile");
    assert.equal((await checked.json() as any).payment.status,"pending");
    assert.equal((await h.post(requested.checkoutUrl+"/capture")).status,409);
    assert.equal(h.capturePosts(),1);
    assert.equal((await h.service.state()).calculated.dues[0].paidCents,0);
  }finally{await h.close();}
});

test("retained replies do not prevent organizer checkout after invitations stop",async()=>{
 const h=await setup();
 try{
  const invitation=await h.links.create(h.service,"ada");
  const before=await h.service.state();
  const items=before.bill.items.map(item=>({id:item.id,selected:item.sharedBy.includes("ada")}));
  assert.equal((await h.post(invitation.url+"/response",{items})).status,200);
  h.links.stopInvitations();
  assert.equal((await h.service.state()).guestLinksReady,false);
  assert.ok(h.links.response(h.service.tableId,invitation.id));
  const response=await h.organizerPost("payments/ada/order",{revision:1});
  assert.equal(response.status,200,await response.clone().text());
  const order=await response.json() as any;
  assert.equal(order.checkoutUrl,undefined);
  assert.equal(h.orders.length,1);
  assert.equal(h.orders[0].body.purchase_units[0].amount.value,"18.75");
  assert.equal(h.capturePosts(),0);
  assert.equal((await fetch(invitation.url)).status,410);
 }finally{await h.close();}
});

test("unreviewed guest choices block new payment for the whole table before any provider request",async()=>{
 const h=await setup();
 try{
  const invitation=await h.links.create(h.service,"bo");
  const before=(await h.service.state()).bill;
  const items=before.items.map(item=>({id:item.id,selected:item.sharedBy.includes("bo")||item.id==="noodles"}));
  assert.equal((await h.post(invitation.url+"/response",{items})).status,200);
  const attempt=await h.organizerPost("payments/ada/order",{revision:before.revision});
  assert.equal(attempt.status,409);
  assert.match((await attempt.json() as any).error,/review.*guest.*repl/i);
  assert.equal(h.orders.length,0);
  assert.deepEqual((await h.service.state()).bill,before);
  // Retained replies still matter after Stop and after restoring the organizer.
  h.links.stopInvitations();
  const retained=h.links.snapshot();
  const restored=new TabloomGuestLinks(h.guestOrigin);
  await restored.restore(retained,async()=>h.service);
  restored.acceptingInvitations=false;h.service.links=restored;
  const stopped=await h.organizerPost("payments/ada/order",{revision:before.revision});
  assert.equal(stopped.status,409);assert.equal(h.orders.length,0);
  await restored.revoke("legacy",invitation.id,restored.reviewIdentity("legacy",invitation.id).responseId);
  const requested=await h.organizerPost("payments/ada/order",{revision:before.revision});
  assert.equal(requested.status,200);assert.equal(h.orders.length,1);
  const original=(await h.service.state()).bill.payments.ada.requestId;
  assert.equal((await h.organizerPost("payments/ada/order",{revision:before.revision})).status,200);
  assert.equal(h.orders.length,1);assert.equal((await h.service.state()).bill.payments.ada.requestId,original);
 }finally{await h.close();}
});

test("reply persistence completes before a concurrent new order can inspect the table",async()=>{
 const h=await setup();let release!:()=>void;
 try{
  const invite=await h.links.create(h.service,"bo");
  const bill=(await h.service.state()).bill;
  let entered!:()=>void;const waiting=new Promise<void>(r=>{entered=r;});
  const gate=new Promise<void>(r=>{release=r;});
  const originalReview=h.service.reviewGuestResponse.bind(h.service);
  h.service.reviewGuestResponse=(response,accept)=>originalReview(response,async()=>{
    entered();await gate;await accept?.();
  });
  const items=bill.items.map(item=>({id:item.id,selected:item.sharedBy.includes("bo")||item.id==="noodles"}));
  const sending=h.post(invite.url+"/response",{items});await waiting;
  const ordering=h.service.createOrder("ada",bill.revision);
  const rejected=assert.rejects(ordering,/Review and save or dismiss.*guest replies/);
  release();assert.equal((await sending).status,200);await rejected;
  assert.equal(h.orders.length,0);assert.deepEqual((await h.service.state()).bill,bill);
 }finally{release?.();await h.close();}
});
test("a stale retained reply does not prevent payment for the newly saved receipt",async()=>{
 const h=await setup();
 try{
  const invite=await h.links.create(h.service,"bo"),bill=(await h.service.state()).bill;
  const items=bill.items.map(item=>({id:item.id,selected:item.sharedBy.includes("bo")||item.id==="noodles"}));
  assert.equal((await h.post(invite.url+"/response",{items})).status,200);
  await h.service.updateDraft({...bill,title:"Revised dinner"},bill.revision);
  assert.equal((await h.organizerPost("payments/ada/order",{revision:bill.revision+1})).status,200);
  assert.equal(h.orders.length,1);
  // Payment wins the lock: a later guest reply is rejected without replacing choices.
  const retained=h.links.response("legacy",invite.id);
  assert.equal((await h.post(invite.url+"/response",{items})).status,409);
  assert.deepEqual(h.links.response("legacy",invite.id),retained);
 }finally{await h.close();}
});

test("Stop closes one guest link but retains corrections until explicit current-reply dismissal",async()=>{
 const h=await setup();
 try{
  const invite=await h.links.create(h.service,"bo"),bill=(await h.service.state()).bill;
  const items=bill.items.map(item=>({id:item.id,selected:item.sharedBy.includes("bo")||item.id==="noodles"}));
  assert.equal((await h.post(invite.url+"/response",{items})).status,200);
  const first=h.links.reviewIdentity("legacy",invite.id);
  assert.equal((await h.organizerPost("guest-links/revoke",{id:invite.id,discardResponseId:first.responseId})).status,400,"active replies need Stop before Dismiss");
  items[1].selected=!items[1].selected;
  assert.equal((await h.post(invite.url+"/response",{items})).status,200);
  const current=h.links.reviewIdentity("legacy",invite.id),reply=h.links.response("legacy",invite.id);
  assert.notEqual(first.responseId,current.responseId);
  for(let count=0;count<2;count++){
   const stop=await h.organizerPost("guest-links/revoke",{id:invite.id});assert.equal(stop.status,200);
   assert.equal((await stop.json() as any).replyRetained,true);
   assert.deepEqual(h.links.response("legacy",invite.id),reply);
  }
  assert.equal((await fetch(invite.url)).status,410);
  assert.equal((await h.organizerPost("payments/ada/order",{revision:bill.revision})).status,409);assert.equal(h.orders.length,0);
  assert.equal((await h.organizerPost("guest-links/revoke",{id:invite.id,discardResponseId:first.responseId})).status,400);
  assert.deepEqual(h.links.response("legacy",invite.id),reply);
  assert.equal((await h.organizerPost("guest-links/revoke",{id:invite.id,discardResponseId:current.responseId})).status,200);
  assert.equal(h.links.list("legacy",bill.revision).some(link=>link.id===invite.id),false);
  assert.deepEqual((await h.service.state()).bill,bill);
  assert.equal((await h.organizerPost("payments/ada/order",{revision:bill.revision})).status,200);
  assert.equal(h.orders.length,1);
 }finally{await h.close();}
});
test("an old dismiss action cannot remove a reply that was subsequently saved",async()=>{
 const h=await setup();
 try{
  const invite=await h.links.create(h.service,"bo"),bill=(await h.service.state()).bill;
  const items=bill.items.map(item=>({id:item.id,selected:item.sharedBy.includes("bo")}));
  assert.equal((await h.post(invite.url+"/response",{items})).status,200);
  const identity=h.links.reviewIdentity("legacy",invite.id);
  await h.links.revoke("legacy",invite.id);
  await h.links.recordSaved("legacy",identity,await h.service.guestReview("bo"));
  await assert.rejects(h.links.revoke("legacy",invite.id,identity.responseId),/changed.*Refresh/);
  assert.ok(h.links.list("legacy",bill.revision).find(link=>link.id===invite.id)?.savedAt);
 }finally{await h.close();}
});
