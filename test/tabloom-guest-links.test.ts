import {createRequire} from "node:module";
const jsQR=createRequire(import.meta.url)("jsqr") as (data:Uint8ClampedArray,width:number,height:number)=>{data:string}|null;
import {PNG} from "pngjs";
import {test} from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {TabloomService} from "../src/tabloom-service.js";
import {TabloomGuestLinks,guestAddress} from "../src/tabloom-guest-links.js";
test("guest-only HTTP listener receives an actual guest response without exposing organizer routes or saving allocations",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"tabloom-live-test-"));
 let links:TabloomGuestLinks;
 const server=createServer((req,res)=>void links.handle(req,res));
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const address=server.address() as {port:number},origin="http://127.0.0.1:"+address.port;
 links=new TabloomGuestLinks(origin);const service=new TabloomService(join(dir,"table.json"),fetch,"legacy",links);
 try{
  const before=await service.state(),invite=await links.create(service,"mira");
  for(const person of ["mira","joss"]){const named=await links.create(service,person);const png=PNG.sync.read(Buffer.from(named.qr.split(",")[1],"base64"));const decoded=jsQR(new Uint8ClampedArray(png.data),png.width,png.height);assert.equal(decoded?.data,named.url);if(person!=="mira")assert.notEqual(decoded?.data,invite.url);}
  const response=await fetch(invite.url);assert.equal(response.status,200);
  const html=await response.text();assert.ok(html.includes("Send choices to organizer"));assert.ok(!html.includes(before.bill.note));
  for(const route of ["/mcp","/healthz","/tabloom/api/state","/tabloom/api/bill","/tabloom/api/receipt-source","/guest/unknown"]){assert.equal((await fetch(origin+route)).status,404);}
  const items=before.bill.items.map(i=>({id:i.id,selected:i.sharedBy.includes("mira")||i.id==="dumplings"}));
  const sent=await fetch(invite.url+"/response",{method:"POST",headers:{"content-type":"application/json","origin":origin},body:JSON.stringify({items})});assert.equal(sent.status,200);
  assert.equal((await sent.json() as {received:boolean}).received,true);
  assert.deepEqual((await service.state()).bill,before.bill);
  const preview=await service.reviewGuestResponse(links.response("legacy",invite.id));assert.equal(preview.changes.length,1);assert.ok(links.list("legacy",0)[0].submittedAt);
  assert.throws(()=>links.response("other-table",invite.id),/expired or was stopped/);
  const received=links.response("legacy",invite.id);
  const originalReview=service.reviewGuestResponse.bind(service);
  let release!:()=>void,entered!:()=>void;
  const waiting=new Promise<void>(resolve=>{entered=resolve;});
  const gate=new Promise<void>(resolve=>{release=resolve;});
  service.reviewGuestResponse=async (response,accept)=>{entered();await gate;return originalReview(response,accept);};
  const inFlight=fetch(invite.url+"/response",{method:"POST",headers:{"content-type":"application/json",origin},body:JSON.stringify({items})});
  await waiting;
  links.stopInvitations();
  release();
  assert.equal((await inFlight).status,409,"a request already reading the bill cannot overwrite a retained reply after Stop");
  assert.deepEqual(links.response("legacy",invite.id),received);
  assert.equal((await fetch(invite.url)).status,410);
  await assert.rejects(links.create(service,"mira"),/Start guest invitations/);
  await links.revoke("legacy",invite.id);assert.equal((await fetch(invite.url)).status,410);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});
test("guest links stop accepting choices after a saved receipt changes",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"tabloom-stale-test-"));let links:TabloomGuestLinks;
 const server=createServer((req,res)=>void links.handle(req,res));await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const origin="http://127.0.0.1:"+(server.address() as {port:number}).port;links=new TabloomGuestLinks(origin);
 const service=new TabloomService(join(dir,"bill.json"),fetch,"legacy",links);
 try{
  const invite=await links.create(service,"mira"),state=await service.state();
  await service.updateDraft({...state.bill,title:"Changed dinner"},state.bill.revision);
  const changed=await service.state(),page=await fetch(invite.url,{headers:{accept:"text/html"}});assert.equal(page.status,409);
  const html=await page.text(),packet=JSON.parse(html.match(/<script id="review-data" type="application\/json">(.*?)<\/script>/s)![1]);
  assert.equal(packet.receiptChanged,true);assert.equal(packet.guestId,"mira");assert.equal(packet.checkoutUrl,null);
  assert.equal(packet.title,state.bill.title);assert.equal(packet.note,undefined);
  const items=state.bill.items.map(item=>({id:item.id,selected:item.sharedBy.includes("mira")}));
  for(const action of ["preview","response"]){
   const result=await fetch(invite.url+"/"+action,{method:"POST",headers:{"content-type":"application/json",origin},body:JSON.stringify({items})});
   assert.equal(result.status,409,"stale choices remain non-submittable while their reference view is recoverable");
  }
  assert.equal((await fetch(invite.checkoutUrl)).status,409);
  assert.deepEqual((await service.state()).bill,changed.bill);assert.equal(links.list("legacy",1)[0].stale,true);
  await links.revoke("legacy",invite.id);assert.equal((await fetch(invite.url)).status,410);
 }
 finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});
test("guest network opt-in accepts private numeric interfaces and rejects public or ambiguous addresses",()=>{
 assert.equal(guestAddress("http://192.168.1.20:3001").host,"192.168.1.20");
 assert.equal(guestAddress("http://100.96.9.235:19919").port,19919);
 for(const value of ["http://8.8.8.8:3001","http://0.0.0.0:3001","http://example.com:3001","https://192.168.1.20:3001","http://192.168.1.20:3001/path","http://u:p@192.168.1.20:3001","http://127.0.0.1:0"])assert.throws(()=>guestAddress(value));
});

test("guest preview returns only the guest's exact proposed share without submitting or saving choices",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"tabloom-share-preview-"));let links:TabloomGuestLinks;
 const server=createServer((req,res)=>void links.handle(req,res));await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const origin="http://127.0.0.1:"+(server.address() as {port:number}).port;links=new TabloomGuestLinks(origin);
 const service=new TabloomService(join(dir,"bill.json"),fetch,"legacy",links);
 try{
  await service.updateDraft({title:"After the exhibition",note:"PRIVATE organizer detail",guests:[{id:"amira",name:"Amira"},{id:"bo",name:"Bo"},{id:"dev",name:"Dev"}],items:[
   {id:"soba",name:"Soba noodles",cents:1800,sharedBy:["amira"]},
   {id:"katsu",name:"Katsu curry",cents:1400,sharedBy:["bo"]},
   {id:"mochi",name:"Mochi",cents:800,sharedBy:["dev"]},
   {id:"tea",name:"Tea pot",cents:400,sharedBy:["bo","dev"]}
  ],taxCents:440,tipCents:880},0);
  const before=(await service.state()).bill,invite=await links.create(service,"dev");
  const items=before.items.map(item=>({id:item.id,selected:item.sharedBy.includes("dev")||item.id==="katsu"}));
  const response=await fetch(invite.url+"/preview",{method:"POST",headers:{"content-type":"application/json",origin},body:JSON.stringify({items})});
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{revision:1,share:{itemsCents:1700,discountCents:0,taxCents:170,tipCents:340,totalCents:2210,lineItems:[{itemId:"katsu",name:"Katsu curry",fullCents:1400,sharedCount:2,shareCents:700},...[{itemId:"mochi",name:"Mochi",fullCents:800,sharedCount:1,shareCents:800},{itemId:"tea",name:"Tea pot",fullCents:400,sharedCount:2,shareCents:200}]]},unresolved:[]});
  assert.equal(links.list("legacy",1)[0].submittedAt,null);
  assert.throws(()=>links.response("legacy",invite.id),/has not sent/);
  assert.deepEqual((await service.state()).bill,before);
  const send=await fetch(invite.url+"/response",{method:"POST",headers:{"content-type":"application/json",origin},body:JSON.stringify({items})});
  assert.equal(send.status,200);
  const sentAt=links.list("legacy",1)[0].submittedAt,submitted=links.response("legacy",invite.id);
  items.find(item=>item.id==="katsu")!.selected=false;
  const afterSend=await fetch(invite.url+"/preview",{method:"POST",headers:{"content-type":"application/json",origin},body:JSON.stringify({items})});
  assert.equal(afterSend.status,200);
  assert.deepEqual((await afterSend.json() as any).share,{itemsCents:1000,discountCents:0,taxCents:100,tipCents:200,totalCents:1300,lineItems:[{itemId:"mochi",name:"Mochi",fullCents:800,sharedCount:1,shareCents:800},{itemId:"tea",name:"Tea pot",fullCents:400,sharedCount:2,shareCents:200}]});
  assert.equal(links.list("legacy",1)[0].submittedAt,sentAt);
  assert.deepEqual(links.response("legacy",invite.id),submitted);
  assert.deepEqual((await service.state()).bill,before);
  await service.updateDraft({...before,discountCents:88},1);
  const couponBefore=(await service.state()).bill,couponInvite=await links.create(service,"dev");
  const couponPreview=await fetch(couponInvite.url+"/preview",{method:"POST",headers:{"content-type":"application/json",origin},body:JSON.stringify({items})});
  assert.equal(couponPreview.status,200);
  assert.deepEqual((await couponPreview.json() as any).share,{itemsCents:1000,discountCents:20,taxCents:100,tipCents:200,totalCents:1280,lineItems:[{itemId:"mochi",name:"Mochi",fullCents:800,sharedCount:1,shareCents:800},{itemId:"tea",name:"Tea pot",fullCents:400,sharedCount:2,shareCents:200}]});
  assert.deepEqual((await service.state()).bill,couponBefore);
  assert.equal(links.list("legacy",2).find(link=>link.id===couponInvite.id)?.submittedAt,null);

 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});
test("guest preview names unassigned items instead of inventing a final amount and refuses stale or stopped links",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"tabloom-unassigned-preview-"));let links:TabloomGuestLinks;
 const server=createServer((req,res)=>void links.handle(req,res));await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const origin="http://127.0.0.1:"+(server.address() as {port:number}).port;links=new TabloomGuestLinks(origin);
 const service=new TabloomService(join(dir,"bill.json"),fetch,"legacy",links);
 try{
  const before=await service.state(),invite=await links.create(service,"mira");
  const items=before.bill.items.map(item=>({id:item.id,selected:item.sharedBy.includes("mira")&&item.id!=="udon"}));
  const post=()=>fetch(invite.url+"/preview",{method:"POST",headers:{"content-type":"application/json",origin},body:JSON.stringify({items})});
  const response=await post();assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{revision:0,share:null,unresolved:[{id:"udon",name:"Miso udon"}]});
  assert.throws(()=>links.response("legacy",invite.id),/has not sent/);
  await service.updateDraft({...before.bill,title:"Organizer changed the receipt"},0);
  assert.equal((await post()).status,409);
  await links.revoke("legacy",invite.id);assert.equal((await post()).status,410);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});

test("shared table entry opens review-only diners and preserves that boundary through durable restore",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"tabloom-table-entry-"));let links:TabloomGuestLinks;
 const server=createServer((req,res)=>void links.handle(req,res));await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const origin="http://127.0.0.1:"+(server.address() as {port:number}).port;links=new TabloomGuestLinks(origin);
 const service=new TabloomService(join(dir,"bill.json"),fetch,"legacy",links);
 try{
  const before=await service.state(),group=await links.createGroup(service);
  const png=PNG.sync.read(Buffer.from(group.qr.split(",")[1],"base64"));assert.equal(jsQR(new Uint8ClampedArray(png.data),png.width,png.height)?.data,group.url);
  const page=await fetch(group.url);assert.equal(page.status,200);const html=await page.text();
  for(const guest of before.bill.guests)assert.ok(html.includes(guest.name));
  assert.ok(!html.includes(before.bill.note));assert.ok(!html.includes("/checkout"));
  const child=links.list("legacy",before.bill.revision).find(s=>s.guestId==="mira")!;
  assert.equal(child.reviewOnly,true);assert.equal(child.checkoutUrl,null);
  const personal=await links.create(service,"mira");assert.notEqual(personal.id,child.id);assert.equal(personal.reviewOnly,false);
  let financialCalls=0;service.createOrder=async()=>{financialCalls++;throw Error("Unexpected payment action");};
  for(const suffix of ["checkout","checkout/state","checkout/order","checkout/capture","checkout/reconcile"]){
   const response=await fetch(child.url+"/"+suffix,{method:suffix==="checkout"||suffix.endsWith("/state")?"GET":"POST",headers:{"content-type":"application/json",origin},body:suffix==="checkout"||suffix.endsWith("/state")?undefined:"{}"});
   assert.equal(response.status,404);
  }
  assert.equal(financialCalls,0);
  const childHtml=await(await fetch(child.url)).text();const packet=JSON.parse(childHtml.match(/<script id="review-data" type="application\/json">(.*?)<\/script>/s)![1]);assert.equal(packet.checkoutUrl,null);assert.equal(packet.tableJoinUrl,group.url);
  const items=before.bill.items.map(i=>({id:i.id,selected:i.sharedBy.includes("mira")||i.id==="dumplings"}));
  const sent=await fetch(child.url+"/response",{method:"POST",headers:{"content-type":"application/json",origin},body:JSON.stringify({items})});assert.equal(sent.status,200);
  assert.deepEqual((await service.state()).bill,before.bill);
  const rows=links.snapshot() as any[];
  const stored=rows.find(row=>row.id===child.id);assert.equal(stored.kind,"table-review-child");assert.equal(stored.packet,undefined);assert.equal(stored.reviewPacket.guestId,"mira");
  links=new TabloomGuestLinks(origin);await links.restore(rows,async()=>service);service.setGuestLinks(links);
  assert.equal((await fetch(group.url)).status,200);assert.equal((await fetch(child.url+"/checkout")).status,404);
  assert.deepEqual((links.response("legacy",child.id) as any).items,items);
  const joss=links.list("legacy",before.bill.revision).find(s=>s.guestId==="joss")!;
  await links.revoke("legacy",joss.id);
  const partial=links.snapshot();links=new TabloomGuestLinks(origin);await links.restore(partial,async()=>service);service.setGuestLinks(links);
  const remaining=await fetch(group.url);assert.equal(remaining.status,200);assert.ok(!(await remaining.text()).includes(">Joss<"));assert.equal(links.groupList("legacy")[0].guestCount,2);
  await links.revokeGroup("legacy",group.id);
  assert.equal((await fetch(group.url)).status,410);assert.equal((await fetch(child.url)).status,410);
  assert.deepEqual((links.response("legacy",child.id) as any).items,items);
  assert.equal((await fetch(personal.url)).status,200,"stopping a table entry preserves the separate personal invitation");
  await assert.rejects(links.createGroup(service),/Review or dismiss retained/);
  assert.equal(financialCalls,0);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});
test("table entry creation has no visible partial result on storage failure and closes on receipt change",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"tabloom-table-entry-store-"));let links:TabloomGuestLinks;
 const server=createServer((req,res)=>void links.handle(req,res));await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const origin="http://127.0.0.1:"+(server.address() as {port:number}).port;links=new TabloomGuestLinks(origin);
 const service=new TabloomService(join(dir,"bill.json"),fetch,"legacy",links);
 try{
  const before=await service.state();links.setOnChange(async()=>{throw Error("disk unavailable");});
  await assert.rejects(links.createGroup(service),/disk unavailable/);assert.deepEqual(links.snapshot(),[]);assert.deepEqual(links.groupList("legacy"),[]);
  links.setOnChange(async()=>{});const group=await links.createGroup(service);
  assert.equal((await links.createGroup(service)).id,group.id);
  await service.updateDraft({...before.bill,title:"New reviewed dinner"},before.bill.revision);
  assert.equal((await fetch(group.url,{headers:{accept:"text/html"}})).status,409);
  links.stopInvitations();assert.equal((await fetch(group.url)).status,410);
  assert.equal(links.snapshot().some((row:any)=>row.kind==="table-review-entry"),false);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});

test("explicit same-diner re-share keeps the posted entry and lifetime without replacing prior replies",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"tabloom-reshare-"));let links:TabloomGuestLinks;
 const server=createServer((req,res)=>void links.handle(req,res));await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const origin="http://127.0.0.1:"+(server.address() as {port:number}).port;links=new TabloomGuestLinks(origin);
 const service=new TabloomService(join(dir,"bill.json"),fetch,"legacy",links);
 try{
  const before=await service.state(),group=await links.createGroup(service),oldRows=links.snapshot();
  const oldChild=links.list("legacy",before.bill.revision).find(s=>s.guestId==="mira")!;
  await service.updateDraft({...before.bill,title:"Same diners, corrected meal"},before.bill.revision);
  assert.equal((await fetch(group.url)).status,409);
  links.setOnChange(async()=>{throw Error("disk unavailable");});
  await assert.rejects(links.createGroup(service),/disk unavailable/);
  assert.deepEqual(links.snapshot(),oldRows);assert.equal((await fetch(group.url)).status,409);
  links.setOnChange(async()=>{});
  const refreshed=await links.createGroup(service);
  assert.equal(refreshed.url,group.url);assert.equal(refreshed.qr,group.qr);assert.equal(refreshed.expiresAt,group.expiresAt);
  assert.equal((await fetch(group.url)).status,200);
  assert.deepEqual(links.snapshot().find(row=>row.id===oldChild.id),oldRows.find(row=>row.id===oldChild.id));
  const current=await service.state(),newChild=links.list("legacy",current.bill.revision).find(s=>s.guestId==="mira"&&s.revision===current.bill.revision)!;
  assert.notEqual(newChild.id,oldChild.id);assert.equal(newChild.checkoutUrl,null);
  const snapshot=links.snapshot();links=new TabloomGuestLinks(origin);await links.restore(snapshot,async()=>service);service.setGuestLinks(links);
  assert.equal((await fetch(group.url)).status,200);
  const next=await service.state();await service.updateDraft({...next.bill,title:"Another current correction"},next.bill.revision);
  let entered!:()=>void,release!:()=>void;
  const writing=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>release=resolve);
  let calls=0;links.setOnChange(async()=>{if(calls++===0){entered();await held;}});
  const reopening=links.createGroup(service);await writing;
  const stopped=links.revokeGroup("legacy",group.id);release();
  await assert.rejects(reopening,/stopped/);await stopped;
  assert.equal((await fetch(group.url)).status,410);
  links.setOnChange(async()=>{});
  const afterStop=await links.createGroup(service);assert.notEqual(afterStop.id,group.id);
  assert.equal((await fetch(group.url)).status,410);
  const roster=await service.state();roster.bill.guests.push({id:"late-new",name:"New diner"});await service.updateDraft(roster.bill,roster.bill.revision);
  const afterRoster=await links.createGroup(service);assert.notEqual(afterRoster.id,afterStop.id);
  assert.equal((await fetch(afterStop.url)).status,410);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});

test("shared invitation requires recognizable distinct names while personal invitations remain available",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"tabloom-distinct-names-"));
 const links=new TabloomGuestLinks("http://127.0.0.1:3001"),service=new TabloomService(join(dir,"bill.json"),fetch,"legacy",links);
 try{
  for(const names of [["Alex","Alex"],["Alex","alex"],["Alex Smith"," Alex   Smith "],["Alex","Ａｌｅｘ"]]){
   const state=await service.state();state.bill.guests[0].name=names[0];state.bill.guests[1].name=names[1];
   await service.updateDraft(state.bill,state.bill.revision);
   await assert.rejects(links.createGroup(service),/distinct name.*surname or nickname/);
   assert.equal(links.groupList("legacy").length,0);
  }
  const state=await service.state();const personal=await links.create(service,state.bill.guests[0].id);assert.equal(personal.reviewOnly,false);
  state.bill.guests[0].name="Alex Rivera";state.bill.guests[1].name="Alex Chen";await service.updateDraft(state.bill,state.bill.revision);
  const group=await links.createGroup(service);assert.equal(group.guestCount,state.bill.guests.length);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test("an older shared invitation with duplicate names offers recovery instead of indistinguishable choices",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"tabloom-old-names-"));let links:TabloomGuestLinks;
 const server=createServer((req,res)=>void links.handle(req,res));await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const origin="http://127.0.0.1:"+(server.address() as {port:number}).port;links=new TabloomGuestLinks(origin);
 const service=new TabloomService(join(dir,"bill.json"),fetch,"legacy",links);
 try{
  const state=await service.state();state.bill.guests[0].name="Alex";state.bill.guests[1].name="Alex";await service.updateDraft(state.bill,state.bill.revision);
  const rows:any[]=[],expiresAt=Date.now()+60000;
  for(let i=0;i<state.bill.guests.length;i++){const packet=await service.guestInvitation(state.bill.guests[i].id);rows.push({id:String(i+1).padStart(48,"0"),kind:"table-review-child",reviewPacket:packet,tableId:"legacy",expiresAt,reviewOnly:true});}
  const id="f".repeat(48);rows.push({id,kind:"table-review-entry",tableId:"legacy",title:state.bill.title,fingerprint:rows[0].reviewPacket.fingerprint,expiresAt,members:rows.map(row=>row.id)});
  await links.restore(rows,async()=>service);
  const response=await fetch(origin+"/join/"+id),html=await response.text();assert.equal(response.status,409);assert.match(html,/surname or nickname/);assert.ok(!html.includes('<nav'));assert.ok(!html.includes('Alex'));
  assert.equal(links.snapshot().length,rows.length);
  const personal=await links.create(service,state.bill.guests[0].id);assert.equal((await fetch(personal.url)).status,200);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});
