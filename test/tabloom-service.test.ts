import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TabloomService } from "../src/tabloom-service.js";
import { fixtureBill } from "../src/tabloom.js";

test("saved local bill survives reload; stale revision and payment lock refuse unsafe edits",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"tabloom-case-"));const path=join(dir,"bill.json");
  try {
    const svc=new TabloomService(path);
    const initial=await svc.state();assert.equal(initial.bill.revision,0);
    const next=await svc.updateDraft({...fixtureBill(),title:"Our final bill"},0);
    assert.equal(next.bill.revision,1);
    assert.equal((await new TabloomService(path).state()).bill.title,"Our final bill");
    await assert.rejects(()=>svc.updateDraft(fixtureBill(),0),/Reload/);
    await assert.rejects(()=>svc.updateDraft({...fixtureBill(),taxCents:-1},1),/tax/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test("model proposal remains read-only, then applies only after explicit reviewed choice",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"tabloom-ai-"));
  const oldURL=process.env.TABLOOM_AI_URL,oldModel=process.env.TABLOOM_AI_MODEL;
  process.env.TABLOOM_AI_URL="http://127.0.0.1:11434/api/chat";
  process.env.TABLOOM_AI_MODEL="stub-model";
  let calls=0;
  const responder=async(input:URL|string|Request,init?:RequestInit):Promise<Response>=>{
    calls++;
    assert.equal(String(input),"http://127.0.0.1:11434/api/chat");
    const payload=JSON.parse(String(init?.body));
    assert.equal(payload.model,"stub-model");
    assert.match(payload.messages[1].content,/Mira had udon/);
    return new Response(JSON.stringify({message:{content:JSON.stringify({assignments:fixtureBill().items.map(i=>({itemId:i.id,guestIds:["mira"],reason:"Local suggestion only"}))})}}),{status:200});
  };
  try{
    const svc=new TabloomService(join(dir,"bill.json"),responder as typeof fetch);
    const proposal=await svc.suggest();
    assert.equal(calls,1);assert.equal(proposal.suggestions.length,3);
    assert.deepEqual((await svc.state()).bill.items[1].sharedBy,["joss","petra"]);
    await assert.rejects(()=>svc.applySuggestions(0,proposal.suggestions),/confirm every item/);
    await assert.rejects(()=>svc.applySuggestions(0,proposal.suggestions,["udon","udon","water"]),/confirm every item/);
    const unresolved=proposal.suggestions.map(s=>({...s,guestIds:[]}));
    await assert.rejects(()=>svc.applySuggestions(0,unresolved,["udon","dumplings","water"]),/at least one guest/);
    assert.equal((await svc.state()).bill.revision,0);
    const applied=await svc.applySuggestions(0,proposal.suggestions,["udon","dumplings","water"]);
    assert.equal(applied.bill.revision,1);assert.deepEqual(applied.bill.items[1].sharedBy,["mira"]);
    await assert.rejects(()=>svc.applySuggestions(0,proposal.suggestions),/changed/);
  }finally{
    if(oldURL===undefined)delete process.env.TABLOOM_AI_URL;else process.env.TABLOOM_AI_URL=oldURL;
    if(oldModel===undefined)delete process.env.TABLOOM_AI_MODEL;else process.env.TABLOOM_AI_MODEL=oldModel;
    await rm(dir,{recursive:true,force:true});
  }
});
test("Sandbox order requests are durable and amount-bound; capture is never double counted",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"tabloom-payment-"));
  const vars=["TABLOOM_PAYPAL_CLIENT_ID","TABLOOM_PAYPAL_CLIENT_SECRET","TABLOOM_PORT"] as const;
  const originals=vars.map(k=>process.env[k]);
  process.env.TABLOOM_PAYPAL_CLIENT_ID="synthetic-sandbox-client";
  process.env.TABLOOM_PAYPAL_CLIENT_SECRET="synthetic-sandbox-secret";
  process.env.TABLOOM_PORT="3000";
  let creates=0,captures=0,queries=0,oauth=0;
  const responder=async(input:URL|string|Request,init?:RequestInit):Promise<Response>=>{
    const url=String(input);assert.match(url,/^https:\/\/api-m\.sandbox\.paypal\.com\//);
    if(url.endsWith("/v1/oauth2/token")){oauth++;return new Response(JSON.stringify({access_token:"test-token"}),{status:200});}
    if(url.endsWith("/v2/checkout/orders")&&init?.method==="POST"){
      creates++;assert.equal((init.headers as Record<string,string>)["PayPal-Request-Id"].length,36);
      const body=JSON.parse(String(init.body));
      assert.equal(body.purchase_units[0].amount.value,"24.37");
      return new Response(JSON.stringify({id:"2ABCD345678901234",links:[{rel:"payer-action",href:"https://www.sandbox.paypal.com/checkoutnow?token=2ABCD345678901234"}]}),{status:201});
    }
    if(url.endsWith("/capture")){
      captures++;
      assert.equal((init?.headers as Record<string,string>)["Prefer"],"return=representation");
      return new Response(JSON.stringify({id:"2ABCD345678901234",status:"COMPLETED",purchase_units:[{reference_id:"mira",payments:{captures:[{status:"COMPLETED",id:"CAPTURE-1234",amount:{currency_code:"USD",value:"24.37"}}]}}]}),{status:201});
    }
    if(url.includes("/v2/checkout/orders/")){queries++;return new Response(JSON.stringify({id:"2ABCD345678901234",status:"APPROVED",purchase_units:[{reference_id:"mira",amount:{currency_code:"USD",value:"24.37"}}]}),{status:200});}
    throw Error("Unexpected PayPal request");
  };
  try{
    const path=join(dir,"bill.json");const svc=new TabloomService(path,responder as typeof fetch);
    const first=await svc.createOrder("mira",0);assert.equal(first.payment.status,"awaiting_approval");
    assert.equal(creates,1);
    const second=await svc.createOrder("mira",0);assert.deepEqual(second,first);assert.equal(creates,1);
    await assert.rejects(()=>svc.updateDraft(fixtureBill(),0),/locked/);
    const done=await svc.capture("mira");assert.equal(done.payment.status,"captured");assert.equal(captures,1);
    assert.equal((await svc.capture("mira")).payment.status,"captured");assert.equal(captures,1);
    assert.equal((await new TabloomService(path).state()).calculated.dues.find(d=>d.guestId==="mira")?.paidCents,2437);
    assert.equal(queries,1);assert.ok(oauth>=3);
  }finally{
    vars.forEach((k,i)=>{if(originals[i]===undefined)delete process.env[k];else process.env[k]=originals[i];});
    await rm(dir,{recursive:true,force:true});
  }
});
test("capture amount mismatch stays unresolved and keeps the existing capture idempotency ID",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"tabloom-mismatch-"));
  const oldID=process.env.TABLOOM_PAYPAL_CLIENT_ID,oldSecret=process.env.TABLOOM_PAYPAL_CLIENT_SECRET;
  process.env.TABLOOM_PAYPAL_CLIENT_ID="sandbox";
  process.env.TABLOOM_PAYPAL_CLIENT_SECRET="sandbox";
  let IDs:string[]=[];
  const responder=async(input:URL|string|Request,init?:RequestInit):Promise<Response>=>{
    const url=String(input);
    if(url.endsWith("/token"))return new Response(JSON.stringify({access_token:"token"}));
    if(url.endsWith("/orders"))return new Response(JSON.stringify({id:"2ABCDE123456",links:[{rel:"approve",href:"https://www.sandbox.paypal.com/checkoutnow?token=x"}]}));
    if(url.includes("/v2/checkout/orders/") && !url.endsWith("/capture"))
      return new Response(JSON.stringify({id:"2ABCDE123456",status:"APPROVED",purchase_units:[{reference_id:"mira",amount:{currency_code:"USD",value:"24.37"}}]}));
    if(url.endsWith("/capture")){
      IDs.push((init?.headers as Record<string,string>)["PayPal-Request-Id"]);
      if(IDs.length===1)throw new Error("lost provider response");
      return new Response(JSON.stringify({id:"2ABCDE123456",status:"COMPLETED",purchase_units:[{reference_id:"mira",payments:{captures:[{status:"COMPLETED",id:"CAPTURE-OK",amount:{currency_code:"USD",value:"24.38"}}]}}]}));
    }
    throw Error("Unexpected PayPal route: "+url);
  };
  try{
    const svc=new TabloomService(join(dir,"bill.json"),responder as typeof fetch);
    await svc.createOrder("mira",0);
    await assert.rejects(()=>svc.capture("mira"),/lost provider response/);
    assert.equal((await svc.state()).calculated.dues[0].paidCents,0);
    await svc.capture("mira");
    assert.equal(IDs.length,2);assert.equal(IDs[0],IDs[1]);
    assert.equal((await svc.state()).calculated.dues[0].paidCents,0);
    assert.equal((await svc.state()).bill.payments.mira.status,"pending");
  }finally{
    if(oldID===undefined)delete process.env.TABLOOM_PAYPAL_CLIENT_ID;else process.env.TABLOOM_PAYPAL_CLIENT_ID=oldID;
    if(oldSecret===undefined)delete process.env.TABLOOM_PAYPAL_CLIENT_SECRET;else process.env.TABLOOM_PAYPAL_CLIENT_SECRET=oldSecret;
    await rm(dir,{recursive:true,force:true});
  }
});


test("capture requires PayPal buyer consent and matching amount before capture POST",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"tabloom-consent-"));
  const oldID=process.env.TABLOOM_PAYPAL_CLIENT_ID,oldSecret=process.env.TABLOOM_PAYPAL_CLIENT_SECRET;
  process.env.TABLOOM_PAYPAL_CLIENT_ID="test-sandbox";
  process.env.TABLOOM_PAYPAL_CLIENT_SECRET="test-sandbox";
  let orderStatus="CREATED",amount="24.37",buyerRef="mira",getCalls=0,capturePosts=0;
  const responder=async(input:URL|string|Request,init?:RequestInit):Promise<Response>=>{
    const url=String(input);
    if(url.endsWith("/token"))return new Response(JSON.stringify({access_token:"test-token"}));
    if(url.endsWith("/orders"))return new Response(JSON.stringify({id:"2ABCDE123456",links:[{rel:"approve",href:"https://www.sandbox.paypal.com/checkoutnow?token=2ABCDE123456"}]}));
    if(url.endsWith("/2ABCDE123456") && init?.method==="GET"){
      getCalls++;
      return new Response(JSON.stringify({id:"2ABCDE123456",status:orderStatus,purchase_units:[{reference_id:buyerRef,amount:{currency_code:"USD",value:amount}}]}));
    }
    if(url.endsWith("/capture")){
      capturePosts++;
      assert.equal((init?.headers as Record<string,string>)["Prefer"],"return=representation");
      // Even successful minimal representation cannot be counted as captured.
      return new Response(JSON.stringify({id:"2ABCDE123456",status:"COMPLETED"}));
    }
    throw Error("Unexpected "+url);
  };
  try{
    const svc=new TabloomService(join(dir,"bill.json"),responder as typeof fetch);
    await svc.createOrder("mira",0);
    await assert.rejects(()=>svc.capture("mira"),/buyer approval and exact amount/);
    assert.equal(capturePosts,0);
    assert.equal((await svc.state()).bill.payments.mira.status,"awaiting_approval");
    orderStatus="APPROVED";amount="24.38";
    await assert.rejects(()=>svc.capture("mira"),/different or unreadable order/);
    assert.equal(capturePosts,0);
    amount="24.37";buyerRef="joss";
    await assert.rejects(()=>svc.reconcile("mira"),/different or unreadable order/);
    assert.equal(capturePosts,0);
    buyerRef="mira";
    await svc.reconcile("mira");
    const result=await svc.capture("mira");
    assert.equal(result.payment.status,"pending");
    assert.equal(capturePosts,1);
    assert.equal(getCalls,5);
    assert.equal((await svc.state()).calculated.dues[0].paidCents,0);
  }finally{
    if(oldID===undefined)delete process.env.TABLOOM_PAYPAL_CLIENT_ID;else process.env.TABLOOM_PAYPAL_CLIENT_ID=oldID;
    if(oldSecret===undefined)delete process.env.TABLOOM_PAYPAL_CLIENT_SECRET;else process.env.TABLOOM_PAYPAL_CLIENT_SECRET=oldSecret;
    await rm(dir,{recursive:true,force:true});
  }
});

test("proposal cost preview is exact, read-only and bound to the saved revision",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"tabloom-preview-"));
  try{
    const svc=new TabloomService(join(dir,"bill.json"),(async()=>{throw Error("Preview must not contact a provider");}) as typeof fetch);
    const initial=await svc.state();
    const draft=structuredClone(initial.bill);
    draft.items[0].cents=1651;
    draft.items[0].sharedBy=["mira","petra"];
    draft.items[1].sharedBy=["joss"];
    const preview=await svc.previewDraft(draft,0);
    assert.deepEqual(await svc.state(),initial);
    assert.equal(preview.calculated.totalCents,4876);
    assert.equal(preview.calculated.dues.reduce((sum,d)=>sum+d.totalCents,0),4876);
    await assert.rejects(()=>svc.previewDraft({...draft,items:[{...draft.items[0],sharedBy:[]}]},0),/at least one/);
    assert.deepEqual(await svc.state(),initial);
    const saved=await svc.updateDraft(draft,0);
    assert.deepEqual(saved.calculated,preview.calculated);
    await assert.rejects(()=>svc.previewDraft(draft,0),/changed/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("an unassigned receipt can receive model proposals without becoming a saved bill",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"tabloom-unsaved-ai-"));
  const oldURL=process.env.TABLOOM_AI_URL,oldModel=process.env.TABLOOM_AI_MODEL;
  process.env.TABLOOM_AI_URL="http://127.0.0.1:11434/api/chat";process.env.TABLOOM_AI_MODEL="test-only";
  let calls=0;
  const draft={...fixtureBill(),title:"New unassigned dinner",note:"Mira had the noodles",items:fixtureBill().items.map(i=>({...i,sharedBy:[]}))};
  const responder=async(_input:unknown,init?:RequestInit)=>{
    calls++;const body=JSON.parse(String(init?.body));assert.match(body.messages[1].content,/Mira had the noodles/);
    return new Response(JSON.stringify({message:{content:JSON.stringify({assignments:draft.items.map(i=>({itemId:i.id,guestIds:["mira"],reason:"Review this choice"}))})}}));
  };
  try{
    const svc=new TabloomService(join(dir,"bill.json"),responder as typeof fetch);
    const proposal=await svc.suggest(draft,0);assert.equal(proposal.suggestions.length,3);
    assert.deepEqual((await svc.state()).bill,fixtureBill());
    await assert.rejects(()=>svc.updateDraft(draft,0),/at least one/);
    await assert.rejects(()=>svc.suggest(draft,99),/changed/);
    await assert.rejects(()=>svc.suggest({...draft,items:[{...draft.items[0],cents:-1}]},0),/exact integer/);
    assert.equal(calls,1);
    const reviewed={...draft,items:draft.items.map(i=>({...i,sharedBy:["mira"]}))};
    const saved=await svc.updateDraft(reviewed,0);assert.equal(saved.bill.revision,1);assert.equal(saved.bill.title,draft.title);
  }finally{
    if(oldURL===undefined)delete process.env.TABLOOM_AI_URL;else process.env.TABLOOM_AI_URL=oldURL;
    if(oldModel===undefined)delete process.env.TABLOOM_AI_MODEL;else process.env.TABLOOM_AI_MODEL=oldModel;
    await rm(dir,{recursive:true,force:true});
  }
});

test("failed model requests explain timeout and invalid proposals without saving the draft",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"tabloom-ai-recovery-"));
  const oldURL=process.env.TABLOOM_AI_URL,oldModel=process.env.TABLOOM_AI_MODEL;
  process.env.TABLOOM_AI_URL="http://127.0.0.1:11434/api/chat";process.env.TABLOOM_AI_MODEL="test-only";
  const draft={...fixtureBill(),title:"Still my unsaved dinner",items:fixtureBill().items.map(i=>({...i,sharedBy:[]}))};
  try{
    const cases:[typeof fetch,RegExp][]=[
      [(async()=>{throw new DOMException("test timeout","TimeoutError");}) as typeof fetch,/Receipt review timed out/],
      [(async()=>{throw new TypeError("test unreachable");}) as typeof fetch,/could not be reached/],
      [(async()=>new Response(JSON.stringify({message:{content:JSON.stringify({assignments:[{itemId:"udon",guestIds:["mira"],reason:"one"},{itemId:"udon",guestIds:["joss"],reason:"duplicate"}]})}}))) as typeof fetch,/repeated or mismatched receipt items/]
    ];
    for(const[fetcher,message]of cases){
      const svc=new TabloomService(join(dir,"bill.json"),fetcher);
      await assert.rejects(()=>svc.suggest(draft,0),message);
      assert.deepEqual((await svc.state()).bill,fixtureBill());
      assert.ok(draft.items.every(i=>i.sharedBy.length===0));
    }
  }finally{
    if(oldURL===undefined)delete process.env.TABLOOM_AI_URL;else process.env.TABLOOM_AI_URL=oldURL;
    if(oldModel===undefined)delete process.env.TABLOOM_AI_MODEL;else process.env.TABLOOM_AI_MODEL=oldModel;
    await rm(dir,{recursive:true,force:true});
  }
});

test("stopping an AI review cancels its request once and preserves the saved dinner and draft",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"tabloom-ai-stop-"));
  const oldURL=process.env.TABLOOM_AI_URL,oldModel=process.env.TABLOOM_AI_MODEL;
  process.env.TABLOOM_AI_URL="http://127.0.0.1:11434/api/chat";process.env.TABLOOM_AI_MODEL="test-only";
  const draft={...fixtureBill(),title:"My unsaved dinner",items:fixtureBill().items.map(i=>({...i,sharedBy:[]}))};
  let began!:()=>void;
  const started=new Promise<void>(resolve=>{began=resolve;});
  let calls=0,providerSignal:AbortSignal|undefined;
  const fetcher=(async(_input:unknown,init?:RequestInit)=>{
    calls++;const signal=init?.signal;if(!signal)throw Error("Expected request signal");providerSignal=signal;
    began();
    return await new Promise<Response>((_resolve,reject)=>signal.addEventListener("abort",()=>reject(signal.reason),{once:true}));
  }) as typeof fetch;
  try{
    const service=new TabloomService(join(dir,"bill.json"),fetcher);
    const before=(await service.state()).bill;
    const cancelled=new AbortController();cancelled.abort();
    await assert.rejects(()=>service.suggest(draft,0,cancelled.signal),/Receipt review stopped/);
    assert.equal(calls,0);
    const request=new AbortController();
    const pending=service.suggest(draft,0,request.signal);
    await started;request.abort();
    await assert.rejects(pending,/Receipt review stopped/);
    assert.equal(calls,1);assert.equal(providerSignal?.aborted,true);
    assert.deepEqual((await service.state()).bill,before);
    assert.equal(draft.title,"My unsaved dinner");assert.ok(draft.items.every(i=>i.sharedBy.length===0));
  }finally{
    if(oldURL===undefined)delete process.env.TABLOOM_AI_URL;else process.env.TABLOOM_AI_URL=oldURL;
    if(oldModel===undefined)delete process.env.TABLOOM_AI_MODEL;else process.env.TABLOOM_AI_MODEL=oldModel;
    await rm(dir,{recursive:true,force:true});
  }
});

test("recognized source notes work without a model and keep unclaimed items for review",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"tabloom-source-"));
 const oldURL=process.env.TABLOOM_AI_URL,oldModel=process.env.TABLOOM_AI_MODEL;
 delete process.env.TABLOOM_AI_URL;delete process.env.TABLOOM_AI_MODEL;
 let calls=0;const responder=async()=>{calls++;throw Error("No model should be called");};
 try{
  const svc=new TabloomService(join(dir,"bill.json"),responder as typeof fetch);
  const initial=await svc.state(),draft=fixtureBill();
  draft.items[0].name="Flatbread";
  draft.note="Everyone except Mira shared the flatbread. Only Joss ate the pan-fried dumplings. Nobody remembers who ordered the sparkling water.";
  const proposal=await svc.suggest(draft,0);
  assert.deepEqual(proposal.suggestions.map(s=>s.guestIds),[["joss","petra"],["joss"],[]]);
  assert.equal(calls,0);assert.deepEqual((await svc.state()).bill,initial.bill);
  await assert.rejects(()=>svc.applySuggestions(0,proposal.suggestions,draft.items.map(i=>i.id)),/at least one guest/);
  draft.note="We had a pleasant lunch.";
  await assert.rejects(()=>svc.suggest(draft,0),/Could not match these notes/);
  assert.equal(calls,0);assert.deepEqual((await svc.state()).bill,initial.bill);
 }finally{
  if(oldURL===undefined)delete process.env.TABLOOM_AI_URL;else process.env.TABLOOM_AI_URL=oldURL;
  if(oldModel===undefined)delete process.env.TABLOOM_AI_MODEL;else process.env.TABLOOM_AI_MODEL=oldModel;
  await rm(dir,{recursive:true,force:true});
 }
});


test("complete explicit source notes remain usable with an unavailable configured model", async()=>{
 const oldUrl=process.env.TABLOOM_AI_URL,oldModel=process.env.TABLOOM_AI_MODEL;
 process.env.TABLOOM_AI_URL="http://127.0.0.1:11434/api/chat";process.env.TABLOOM_AI_MODEL="unavailable";
 const dir=await mkdtemp(join(tmpdir(),"tabloom-source-fast-"));
 let calls=0;
 try{
  const svc=new TabloomService(join(dir,"table.json"),async()=>{calls++;throw Error("offline");});
  const before=await svc.state();const draft=structuredClone(before.bill);draft.items[0].name="Flatbread";
  draft.note="Joss and Petra shared the flatbread. Only Joss ate the pan-fried dumplings. Nobody remembers who ordered the sparkling water.";
  assert.deepEqual((await svc.suggest(draft,0)).suggestions.map(s=>s.guestIds),[["joss","petra"],["joss"],[]]);assert.equal(calls,0);assert.deepEqual((await svc.state()).bill,before.bill);
  draft.note="Joss and Petra shared the flatbread.";
  await assert.rejects(()=>svc.suggest(draft,0),/could not be reached/);assert.equal(calls,1);assert.deepEqual((await svc.state()).bill,before.bill);
 }finally{if(oldUrl===undefined)delete process.env.TABLOOM_AI_URL;else process.env.TABLOOM_AI_URL=oldUrl;if(oldModel===undefined)delete process.env.TABLOOM_AI_MODEL;else process.env.TABLOOM_AI_MODEL=oldModel;await rm(dir,{recursive:true,force:true});}
});
