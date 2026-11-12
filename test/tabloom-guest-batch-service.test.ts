import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TabloomService, handleTabloom } from "../src/tabloom-service.js";
import { TabloomGuestLinks } from "../src/tabloom-guest-links.js";

async function course(run:(service:TabloomService,links:TabloomGuestLinks,post:(path:string,body:unknown)=>Promise<{status:number;data:any}>,origin:string)=>Promise<void>){
  const dir=await mkdtemp(join(tmpdir(),"tabloom-combined-review-"));
  let links:TabloomGuestLinks;
  const guestServer=createServer((req,res)=>void links.handle(req,res));
  await new Promise<void>(resolve=>guestServer.listen(0,"127.0.0.1",resolve));
  const origin="http://127.0.0.1:"+(guestServer.address() as {port:number}).port;
  links=new TabloomGuestLinks(origin);
  const service=new TabloomService(join(dir,"bill.json"),fetch,"legacy",links);
  const organizerServer=createServer((req,res)=>void handleTabloom(req,res,service));
  await new Promise<void>(resolve=>organizerServer.listen(0,"127.0.0.1",resolve));
  const organizer="http://127.0.0.1:"+(organizerServer.address() as {port:number}).port;
  const post=async(path:string,body:unknown)=>{
    const response=await fetch(organizer+"/tabloom/api/"+path,{method:"POST",headers:{"content-type":"application/json",origin:organizer},body:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  try{
    const initial=await service.state(),bill=structuredClone(initial.bill);
    bill.title="Friday supper";bill.note="Private organizer note";
    bill.guests.forEach((guest,index)=>{guest.name=["Rosa","Nikhil","Elin"][index];});
    bill.items.forEach((item,index)=>{item.cents=[1983,1207,541][index];});
    bill.taxCents=261;bill.tipCents=509;
    assert.equal((await post("bill",{bill,revision:initial.bill.revision})).status,200);
    await run(service,links,post,origin);
  }finally{
    await Promise.all([new Promise<void>(resolve=>guestServer.close(()=>resolve())),new Promise<void>(resolve=>organizerServer.close(()=>resolve()))]);
    await rm(dir,{recursive:true,force:true});
  }
}
async function send(url:string,origin:string,items:unknown){
  const response=await fetch(url+"/response",{method:"POST",headers:{"content-type":"application/json",origin},body:JSON.stringify({items})});
  assert.equal(response.status,200,await response.text());
}

test("two real guest responses become one saved receipt and both links show that saved result",async()=>course(async(service,links,post,origin)=>{
  const before=await service.state();
  const rosa=(await post("guest-links/create",{guestId:"mira"})).data;
  const nikhil=(await post("guest-links/create",{guestId:"joss"})).data;
  await send(rosa.url,origin,before.bill.items.map(item=>({id:item.id,selected:item.sharedBy.includes("mira")||item.id==="dumplings"})));
  await send(nikhil.url,origin,before.bill.items.map(item=>({id:item.id,selected:item.id!=="dumplings"})));
  const collected=await post("guest-links/responses",{ids:[rosa.id,nikhil.id]});assert.equal(collected.status,200);
  const proposed=await post("guest-review/preview-many",{responses:collected.data.responses});assert.equal(proposed.status,200);
  assert.deepEqual(proposed.data.calculated.dues.map((due:any)=>due.totalCents),[2141,1415,945]);
  assert.deepEqual((await service.state()).bill,before.bill);
  const saved=await post("bill",{bill:proposed.data.bill,revision:before.bill.revision,guestResponses:collected.data.identities});
  assert.equal(saved.status,200,JSON.stringify(saved.data));
  assert.equal(saved.data.bill.revision,before.bill.revision+1);
  assert.deepEqual(saved.data.bill.items.map((item:any)=>item.sharedBy),[["mira","joss"],["mira","petra"],["mira","joss","petra"]]);
  assert.equal(Object.keys(saved.data.bill.payments).length,0);
  for(const [invite,amount] of [[rosa,"21.41"],[nikhil,"14.15"]] as const){
    const response=await fetch(invite.url),html=await response.text();
    assert.equal(response.status,200);assert.ok(html.includes("$"+amount));assert.match(html,/Saved by your organizer/);
    assert.ok(!html.includes('id="download-response"'));assert.ok(!html.includes(before.bill.note));
  }
  assert.ok(links.list("legacy",saved.data.bill.revision).every(link=>link.savedRevision===saved.data.bill.revision&&link.savedAt));
}));

test("one diner resubmitting refuses the whole earlier batch without saving or accepting either response",async()=>course(async(service,links,post,origin)=>{
  const before=await service.state(),invites=[];
  for(const guestId of ["mira","joss"]){
    const invite=(await post("guest-links/create",{guestId})).data;invites.push(invite);
    await send(invite.url,origin,before.bill.items.map(item=>({id:item.id,selected:item.sharedBy.includes(guestId)||item.id==="dumplings"})));
  }
  const collected=(await post("guest-links/responses",{ids:invites.map(invite=>invite.id)})).data;
  const proposed=(await post("guest-review/preview-many",{responses:collected.responses})).data;
  await send(invites[1].url,origin,before.bill.items.map(item=>({id:item.id,selected:item.id!=="dumplings"})));
  const refused=await post("bill",{bill:proposed.bill,revision:before.bill.revision,guestResponses:collected.identities});
  assert.notEqual(refused.status,200);assert.match(refused.data.error,/response changed/);
  assert.deepEqual((await service.state()).bill,before.bill);
  assert.ok(links.list("legacy",before.bill.revision).every(link=>!link.savedAt));
  for(const invite of invites){const response=await fetch(invite.url);assert.equal(response.status,200);assert.match(await response.text(),/Send choices to organizer/);}
}));

test("selected unchanged responses can be acknowledged without accepting an excluded guest",async()=>course(async(service,links,post,origin)=>{
  const before=await service.state(),invites=[];
  for(const guestId of ["mira","joss","petra"]){
    const invite=(await post("guest-links/create",{guestId})).data;invites.push(invite);
    await send(invite.url,origin,before.bill.items.map(item=>({id:item.id,selected:item.sharedBy.includes(guestId)})));
  }
  const selected=invites.slice(0,2),collected=(await post("guest-links/responses",{ids:selected.map(invite=>invite.id)})).data;
  const proposed=(await post("guest-review/preview-many",{responses:collected.responses})).data;
  assert.deepEqual(proposed.changes,[]);assert.deepEqual(proposed.bill,before.bill);
  const saved=await post("bill",{bill:proposed.bill,revision:before.bill.revision,guestResponses:collected.identities});
  assert.equal(saved.status,200);assert.deepEqual(saved.data.calculated,before.calculated);
  for(const invite of selected)assert.equal((await fetch(invite.url)).status,200);
  assert.equal((await fetch(invites[2].url)).status,200);
  assert.deepEqual((await service.state()).bill,before.bill);
  assert.deepEqual(await(await fetch(invites[2].url+"/review-state")).json(),{state:"pending"});
  assert.equal(links.list("legacy",saved.data.bill.revision).filter(link=>link.savedAt).length,2);
}));

test("weighted items retain untouched portions and reset changed membership before both guest outcomes",async()=>course(async(service,links,post,origin)=>{
  const original=await service.state(),weighted=structuredClone(original.bill);
  weighted.items[0].portions={mira:3};
  weighted.items[1].portions={joss:2,petra:1};
  weighted.items[2].portions={mira:3,joss:1,petra:2};
  assert.equal((await post("bill",{bill:weighted,revision:original.bill.revision})).status,200);
  const before=await service.state();
  const rosa=(await post("guest-links/create",{guestId:"mira"})).data;
  const nikhil=(await post("guest-links/create",{guestId:"joss"})).data;
  assert.match(rosa.qr,/^data:image\/png;base64,/);
  await send(rosa.url,origin,before.bill.items.map(item=>({id:item.id,selected:item.sharedBy.includes("mira")||item.id==="dumplings"})));
  await send(nikhil.url,origin,before.bill.items.map(item=>({id:item.id,selected:item.id!=="dumplings"})));
  const collected=(await post("guest-links/responses",{ids:[rosa.id,nikhil.id]})).data;
  const proposed=await post("guest-review/preview-many",{responses:collected.responses});
  assert.equal(proposed.status,200,JSON.stringify(proposed.data));
  assert.equal(proposed.data.bill.items[0].portions,undefined);
  assert.equal(proposed.data.bill.items[1].portions,undefined);
  assert.deepEqual(proposed.data.bill.items[2].portions,{mira:3,joss:1,petra:2});
  assert.deepEqual(proposed.data.calculated.dues.map((due:any)=>due.totalCents),[2250,1306,945]);
  assert.deepEqual((await service.state()).bill,before.bill);
  const saved=await post("bill",{bill:proposed.data.bill,revision:before.bill.revision,guestResponses:collected.identities});
  assert.equal(saved.status,200,JSON.stringify(saved.data));
  assert.deepEqual(saved.data.bill.items[2].portions,before.bill.items[2].portions);
  assert.equal(saved.data.calculated.totalCents,4501);assert.equal(Object.keys(saved.data.bill.payments).length,0);
  for(const [invite,amount,portions] of [[rosa,"22.50","3 of 6 portions"],[nikhil,"13.06","1 of 6 portions"]] as const){
    const response=await fetch(invite.url),html=await response.text();
    assert.equal(response.status,200);assert.ok(html.includes("$"+amount));assert.ok(html.includes(portions));
    assert.ok(!html.includes('id="download-response"'));assert.ok(!html.includes(before.bill.note));
    assert.match(html,/View my payment status/);
    const checkout=await fetch(invite.checkoutUrl+"/state");assert.equal(checkout.status,200);
    const personal=await checkout.json() as {totalCents:number;payment:unknown};assert.equal(personal.totalCents,Math.round(Number(amount)*100));
    assert.equal(personal.payment,null);assert.ok(!JSON.stringify(personal).includes(before.bill.note));
  }
  // The accepted old invitation keeps its historical allocation but cannot check out a changed bill.
  const edited=structuredClone(saved.data.bill);edited.title="Another saved correction";
  assert.equal((await post("bill",{bill:edited,revision:edited.revision})).status,200);
  const historical=await fetch(rosa.url);assert.equal(historical.status,200);
  const oldHtml=await historical.text();assert.match(oldHtml,/The receipt has changed/);assert.ok(oldHtml.includes("$22.50"));
  assert.ok(!oldHtml.includes("View my payment status"));
  assert.equal((await fetch(rosa.checkoutUrl+"/state")).status,409);
  assert.equal((await fetch(rosa.checkoutUrl)).status,409);
}));


test("combined guest corrections keep the receipt coupon visible in saved outcomes and checkout",async()=>course(async(service,links,post,origin)=>{
  const original=await service.state(),discounted=structuredClone(original.bill);discounted.discountCents=375;
  assert.equal((await post("bill",{bill:discounted,revision:original.bill.revision})).status,200);
  const before=await service.state();
  const rosa=(await post("guest-links/create",{guestId:"mira"})).data,nikhil=(await post("guest-links/create",{guestId:"joss"})).data;
  await send(rosa.url,origin,before.bill.items.map(item=>({id:item.id,selected:item.sharedBy.includes("mira")||item.id==="dumplings"})));
  await send(nikhil.url,origin,before.bill.items.map(item=>({id:item.id,selected:item.id!=="dumplings"})));
  const collected=(await post("guest-links/responses",{ids:[rosa.id,nikhil.id]})).data;
  const proposed=(await post("guest-review/preview-many",{responses:collected.responses})).data;
  assert.equal(proposed.bill.discountCents,375);assert.equal(proposed.calculated.totalCents,4126);
  // The equal soda remainder goes to joss before mira by the established guest-id tie rule.
  // Gross item shares 1775/1173/783 less discounts 178/118/79, plus the exact charges below.
  assert.deepEqual(proposed.calculated.dues.map((due:any)=>due.itemsCents),[1775,1173,783]);
  assert.deepEqual(proposed.calculated.dues.map((due:any)=>due.discountCents),[178,118,79]);
  assert.deepEqual(proposed.calculated.dues.map((due:any)=>due.taxCents),[124,82,55]);
  assert.deepEqual(proposed.calculated.dues.map((due:any)=>due.tipCents),[242,160,107]);
  assert.deepEqual(proposed.calculated.dues.map((due:any)=>due.totalCents),[1963,1297,866]);
  assert.deepEqual((await service.state()).bill,before.bill);
  const saved=await post("bill",{bill:proposed.bill,revision:before.bill.revision,guestResponses:collected.identities});
  assert.equal(saved.status,200,JSON.stringify(saved.data));assert.equal(Object.keys(saved.data.bill.payments).length,0);
  for(const [invite,amount,discount] of [[rosa,1963,178],[nikhil,1297,118]] as const){
    const response=await fetch(invite.url),html=await response.text();assert.equal(response.status,200);
    assert.ok(html.includes("$"+(amount/100).toFixed(2)));assert.match(html,/<dt>Receipt discount<\/dt>/);
    assert.ok(html.includes("−$"+(discount/100).toFixed(2)));assert.ok(!html.includes(before.bill.note));
    const checkout=await fetch(invite.checkoutUrl+"/state");assert.equal(checkout.status,200);
    const own=await checkout.json() as {totalCents:number;discountCents:number;payment:unknown};
    assert.equal(own.totalCents,amount);assert.equal(own.discountCents,discount);assert.equal(own.payment,null);
  }
}));
