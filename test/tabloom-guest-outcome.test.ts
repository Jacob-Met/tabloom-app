import {test} from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {TabloomService} from "../src/tabloom-service.js";
import {TabloomGuestLinks} from "../src/tabloom-guest-links.js";
async function course(run:(service:TabloomService,links:TabloomGuestLinks,origin:string)=>Promise<void>){
 const dir=await mkdtemp(join(tmpdir(),"tabloom-outcome-"));let links:TabloomGuestLinks;
 const server=createServer((req,res)=>void links.handle(req,res));
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const origin="http://127.0.0.1:"+(server.address() as {port:number}).port;
 links=new TabloomGuestLinks(origin);const service=new TabloomService(join(dir,"bill.json"),fetch,"legacy",links);
 try{await run(service,links,origin);}finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
}
test("explicit reviewed Save gives guest a read-only outcome, later edits retain the dated snapshot, revoke still closes it",async()=>course(async(service,links,origin)=>{
 const before=await service.state(),invite=await links.create(service,"mira");
 const items=before.bill.items.map(i=>({id:i.id,selected:i.sharedBy.includes("mira")||i.id==="dumplings"}));
 const send=()=>fetch(invite.url+"/response",{method:"POST",headers:{"content-type":"application/json",origin},body:JSON.stringify({items})});
 assert.equal((await send()).status,200);
 assert.deepEqual(await(await fetch(invite.url+"/review-state")).json(),{state:"pending"});
 const identity=links.reviewIdentity("legacy",invite.id),preview=await service.reviewGuestResponse(links.response("legacy",invite.id));
 assert.deepEqual((await service.state()).bill,before.bill);
 await assert.rejects(service.updateDraft({...preview.bill,title:"Unreviewed title"},before.bill.revision,identity),/differs from the reviewed/);
 assert.deepEqual((await service.state()).bill,before.bill);
 const saved=await service.updateDraft(preview.bill,before.bill.revision,identity);
 const savedState=await(await fetch(invite.url+"/review-state")).json();
 assert.deepEqual(savedState,{state:"saved",current:true,totalCents:saved.calculated.dues.find(d=>d.guestId==="mira")!.totalCents,revision:saved.bill.revision,submittedAt:links.list("legacy",saved.bill.revision)[0].submittedAt,responseItems:items});
 assert.deepEqual((await service.state()).bill,saved.bill);
 let response=await fetch(invite.url);assert.equal(response.status,200);let html=await response.text();
 assert.match(html,/Saved by your organizer/);assert.match(html,/Mira’s saved share/);assert.match(html,/<time datetime="/);
 assert.ok(html.includes("$"+(saved.calculated.dues.find(d=>d.guestId==="mira")!.totalCents/100).toFixed(2)));
 assert.ok(!html.includes('id="download-response"'));assert.equal((await send()).status,409);
 assert.equal(Object.keys(saved.bill.payments).length,0);
 await service.updateDraft({...saved.bill,title:"Later dinner correction"},saved.bill.revision);
 assert.deepEqual(await(await fetch(invite.url+"/review-state")).json(),{...savedState,current:false});
 html=await(await fetch(invite.url)).text();assert.match(html,/The receipt has changed/);assert.match(html,/Mira’s earlier share/);assert.ok(!html.includes('class="payment"'));
 await links.revoke("legacy",invite.id);assert.equal((await fetch(invite.url)).status,410);assert.equal((await fetch(invite.url+"/review-state")).status,410);
}));
test("matching allocations without explicit response identity never claim acceptance; replaced responses invalidate a prior review",async()=>course(async(service,links,origin)=>{
 const before=await service.state(),invite=await links.create(service,"mira");
 const items=before.bill.items.map(i=>({id:i.id,selected:i.sharedBy.includes("mira")||i.id==="dumplings"}));
 const send=()=>fetch(invite.url+"/response",{method:"POST",headers:{"content-type":"application/json",origin},body:JSON.stringify({items})});
 await send();const identity=links.reviewIdentity("legacy",invite.id),preview=await service.reviewGuestResponse(links.response("legacy",invite.id));
 items[0].selected=!items[0].selected;await send();await assert.rejects(service.updateDraft(preview.bill,before.bill.revision,identity),/response changed/);
 assert.deepEqual((await service.state()).bill,before.bill);
 await service.updateDraft(preview.bill,before.bill.revision);
 assert.equal((await fetch(invite.url)).status,409);assert.equal(links.list("legacy",1)[0].savedAt,null);
 assert.deepEqual(await(await fetch(invite.url+"/review-state")).json(),{state:"changed"});
}));

test("browser stale and stopped links explain recovery; JSON actions keep their errors",async()=>course(async(service,links)=>{
 const state=await service.state(),invite=await links.create(service,"mira");
 await service.updateDraft({...state.bill,title:"Private changed title"},state.bill.revision);
 let response=await fetch(invite.url,{headers:{accept:"text/html"}});
 assert.equal(response.status,409);assert.match(response.headers.get("content-type")??"",/text.html/);
 let html=await response.text();assert.match(html,/This receipt has changed/);assert.match(html,/fresh invitation/);assert.match(html,/"receiptChanged":true/);assert.ok(!html.includes("Private changed title"));
 response=await fetch(invite.url,{headers:{accept:"application/json"}});assert.equal(response.status,409);assert.match(await response.text(), /"error":/);
 links.revoke("legacy",invite.id);response=await fetch(invite.url,{headers:{accept:"text/html"}});
 assert.equal(response.status,410);html=await response.text();assert.match(html,/This invitation is no longer available/);
 response=await fetch(invite.url+"/response",{method:"POST",headers:{"content-type":"application/json"},body:"{}"});
 assert.equal(response.status,410);assert.match(await response.text(), /"error":/);
}));
test("expired browser invitation preserves410 and explains expiry",async()=>course(async(service,links)=>{
 const invite=await links.create(service,"mira"),realNow=Date.now;
 try{Date.now=()=>realNow()+7200001;const response=await fetch(invite.url,{headers:{accept:"text/html"}});
 assert.equal(response.status,410);assert.match(await response.text(),/This invitation has expired/);
 }finally{Date.now=realNow;}
}));


test("identical guest retries preserve the original review, including reordered item selections",async()=>course(async(service,links,origin)=>{
 const before=await service.state(),invite=await links.create(service,"mira");
 const items=before.bill.items.map(i=>({id:i.id,selected:i.sharedBy.includes("mira")||i.id==="dumplings"}));
 const send=(choices:typeof items)=>fetch(invite.url+"/response",{method:"POST",headers:{"content-type":"application/json",origin},body:JSON.stringify({items:choices})});
 const first=await(await send(items)).json() as {submittedAt:string};
 const identity=links.reviewIdentity("legacy",invite.id),preview=await service.reviewGuestResponse(links.response("legacy",invite.id));
 for(const choices of [items,[...items].reverse()]){
  const retry=await send(choices);assert.equal(retry.status,200);
  assert.equal((await retry.json() as {submittedAt:string}).submittedAt,first.submittedAt);
  assert.deepEqual(links.reviewIdentity("legacy",invite.id),identity);
  assert.deepEqual((await service.state()).bill,before.bill);
 }
 const invalid=await send([...items.slice(1),items[1]]);assert.notEqual(invalid.status,200);
 assert.deepEqual(links.reviewIdentity("legacy",invite.id),identity);
 const saved=await service.updateDraft(preview.bill,before.bill.revision,identity);
 assert.equal(saved.bill.revision,before.bill.revision+1);assert.deepEqual(saved.bill.payments,{});
 assert.equal((await send(items)).status,409);
}));


test("explicit unchanged live confirmation keeps peers current; a later real change advances the receipt",async()=>course(async(service,links,origin)=>{
 const before=await service.state(),first=await links.create(service,"mira"),peer=await links.create(service,"joss");
 const items=before.bill.items.map(i=>({id:i.id,selected:i.sharedBy.includes("mira")}));
 assert.equal((await fetch(first.url+"/response",{method:"POST",headers:{"content-type":"application/json",origin},body:JSON.stringify({items})})).status,200);
 const identity=links.reviewIdentity("legacy",first.id),preview=await service.reviewGuestResponse(links.response("legacy",first.id));
 const accepted=await service.updateDraft(preview.bill,before.bill.revision,identity);
 assert.deepEqual(accepted.bill,before.bill);assert.deepEqual((await service.state()).bill,before.bill);
 const outcome=await(await fetch(first.url+"/review-state")).json() as {state:string;current:boolean;revision:number};assert.equal(outcome.state,"saved");assert.equal(outcome.current,true);assert.equal(outcome.revision,before.bill.revision);
 assert.equal((await fetch(peer.url)).status,200);
 await assert.rejects(service.updateDraft(preview.bill,before.bill.revision,identity),/response changed/);
 const added=before.bill.items.find(i=>!i.sharedBy.includes("joss"))!;assert.ok(added);
 const changedItems=before.bill.items.map(i=>({id:i.id,selected:i.sharedBy.includes("joss")||i.id===added.id}));
 assert.equal((await fetch(peer.url+"/response",{method:"POST",headers:{"content-type":"application/json",origin},body:JSON.stringify({items:changedItems})})).status,200);
 const changed=await service.reviewGuestResponse(links.response("legacy",peer.id));
 const saved=await service.updateDraft(changed.bill,before.bill.revision,links.reviewIdentity("legacy",peer.id));
 assert.equal(saved.bill.revision,before.bill.revision+1);assert.equal(saved.calculated.totalCents,before.calculated.totalCents);
 assert.equal((await(await fetch(first.url+"/review-state")).json() as {current:boolean}).current,false);assert.deepEqual(saved.bill.payments,{});
}));

test("unchanged offline review preserves receipt and other forms without accepting live replies",async()=>course(async(service,links)=>{
 const before=await service.state(),invite=await links.create(service,"mira");
 const packet=await service.guestReview("mira"),response={...packet,kind:"tabloom-guest-response"};
 const preview=await service.reviewGuestResponse(response);
 await assert.rejects(service.updateDraft({...preview.bill,title:"Other edit"},before.bill.revision,undefined,undefined,[response]),/differs from the reviewed/);
 await assert.rejects(service.updateDraft(preview.bill,before.bill.revision,undefined,undefined,[{...response,fingerprint:"wrong"}]),/older or different/);
 const accepted=await service.updateDraft(preview.bill,before.bill.revision,undefined,undefined,[response]);
 assert.deepEqual(accepted.bill,before.bill);assert.equal((await fetch(invite.url)).status,200);assert.equal(links.list("legacy",before.bill.revision)[0].savedAt,null);
 const peerPacket=await service.guestReview("joss"),added=before.bill.items.find(i=>!i.sharedBy.includes("joss"))!;
 const peer={...peerPacket,kind:"tabloom-guest-response",items:peerPacket.items.map(i=>({...i,selected:i.selected||i.id===added.id}))};
 const changed=await service.reviewGuestResponse(peer);
 const final=await service.updateDraft(changed.bill,before.bill.revision,undefined,undefined,[peer]);assert.equal(final.bill.revision,before.bill.revision+1);
 await assert.rejects(service.updateDraft(preview.bill,final.bill.revision,undefined,undefined,[response]),/older or different/);
}));

test("saved response outcome waits for persistence and failed storage leaves review retryable",async()=>course(async(service,links,origin)=>{
 const before=await service.state(),invite=await links.create(service,"mira");
 const items=before.bill.items.map(i=>({id:i.id,selected:i.sharedBy.includes("mira")}));
 await fetch(invite.url+"/response",{method:"POST",headers:{"content-type":"application/json",origin},body:JSON.stringify({items})});
 const identity=links.reviewIdentity("legacy",invite.id),preview=await service.reviewGuestResponse(links.response("legacy",invite.id));
 let rejectWrite!:(error:Error)=>void,entered!:()=>void;const ready=new Promise<void>(r=>entered=r);
 links.setOnChange(async()=>{entered();await new Promise<void>((_,reject)=>rejectWrite=reject);});
 const saving=service.updateDraft(preview.bill,before.bill.revision,identity);
 await ready;assert.equal(links.list("legacy",before.bill.revision)[0].savedAt,null);
 rejectWrite(Error("owned storage refusal"));await assert.rejects(saving,/confirmation could not be saved/);
 assert.equal(links.list("legacy",before.bill.revision)[0].savedAt,null);
 assert.deepEqual(links.reviewedForSave("legacy",identity),links.response("legacy",invite.id));
 let persisted:unknown[]=[];links.setOnChange(async rows=>{persisted=structuredClone(rows);});
 await service.updateDraft(preview.bill,before.bill.revision,identity);
 assert.ok(links.list("legacy",before.bill.revision)[0].savedAt);
 const restored=new TabloomGuestLinks(origin);await restored.restore(persisted,async()=>service);
 assert.ok(restored.list("legacy",before.bill.revision)[0].savedAt);
}));

test("failed guest Send persistence does not acknowledge an identical retry until stored",async()=>course(async(service,links,origin)=>{
 const before=await service.state(),invite=await links.create(service,"mira");
 const items=before.bill.items.map(i=>({id:i.id,selected:i.sharedBy.includes("mira")||i.id==="dumplings"}));
 links.setOnChange(async()=>{throw Error("owned storage refusal");});
 const send=()=>fetch(invite.url+"/response",{method:"POST",headers:{"content-type":"application/json",origin},body:JSON.stringify({items})});
 assert.equal((await send()).status,503);assert.equal(links.list("legacy",before.bill.revision)[0].submittedAt,null);
 let persisted:unknown[]=[];links.setOnChange(async rows=>{persisted=structuredClone(rows);});
 assert.equal((await send()).status,200);
 const identity=links.reviewIdentity("legacy",invite.id);
 const restored=new TabloomGuestLinks(origin);await restored.restore(persisted,async()=>service);
 assert.deepEqual(restored.reviewIdentity("legacy",invite.id),identity);
 assert.deepEqual((restored.response("legacy",invite.id) as {items:unknown}).items,items);
 assert.deepEqual((await service.state()).bill,before.bill);
}));

test("concurrent guest outcome writes retain both accepted snapshots",async()=>course(async(service,links,origin)=>{
 const mira=await links.create(service,"mira"),joss=await links.create(service,"joss");
 const bill=(await service.state()).bill;
 for(const [invite,guest] of [[mira,"mira"],[joss,"joss"]] as const){
  assert.equal((await fetch(invite.url+"/response",{method:"POST",headers:{"content-type":"application/json",origin},body:JSON.stringify({items:bill.items.map(i=>({id:i.id,selected:i.sharedBy.includes(guest)}))})})).status,200);
 }
 // Direct outcome calls exercise the shared invitation writer used by separate tables.
 let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(r=>entered=r);
 let writes=0,persisted:unknown[]=[];
 links.setOnChange(async rows=>{writes++;if(writes===1){entered();await new Promise<void>(r=>release=r);}persisted=structuredClone(rows);});
 const first=links.recordSaved("legacy",links.reviewIdentity("legacy",mira.id),await service.guestReview("mira"));
 await ready;
 const second=links.recordSaved("legacy",links.reviewIdentity("legacy",joss.id),await service.guestReview("joss"));
 release();await Promise.all([first,second]);
 assert.equal(writes,2);assert.equal(persisted.filter(row=>(row as {saved?:unknown}).saved).length,2);
}));

test("explicit receipt check reports only this invitation's retained choices without saving or replacing its reply",async()=>course(async(service,links,origin)=>{
 const before=await service.state(),invite=await links.create(service,"mira"),peer=await links.create(service,"joss");
 const read=async(url:string)=>(await fetch(url+"/review-state?receipt=1")).json();
 assert.deepEqual(await read(invite.url),{state:"pending",submittedAt:null,responseItems:null});
 const items=before.bill.items.map(i=>({id:i.id,selected:i.sharedBy.includes("mira")||i.id==="dumplings"}));
 assert.equal((await fetch(invite.url+"/response",{method:"POST",headers:{"content-type":"application/json",origin},body:JSON.stringify({items})})).status,200);
 const original=links.list("legacy",before.bill.revision).find(i=>i.id===invite.id)!;
 assert.deepEqual(await read(invite.url),{state:"pending",submittedAt:original.submittedAt,responseItems:items});
 assert.deepEqual(await read(peer.url),{state:"pending",submittedAt:null,responseItems:null});
 assert.deepEqual(links.list("legacy",before.bill.revision).find(i=>i.id===invite.id),original);
 assert.deepEqual((await service.state()).bill,before.bill);
 await service.updateDraft({...before.bill,title:"Corrected dinner"},before.bill.revision);
 assert.deepEqual(await read(invite.url),{state:"changed"});
 await links.revoke("legacy",invite.id);assert.equal((await fetch(invite.url+"/review-state?receipt=1")).status,410);
}));
