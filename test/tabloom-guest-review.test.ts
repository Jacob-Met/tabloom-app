import {test} from "node:test";
import assert from "node:assert/strict";
import {estimateOfflineChoices} from "../tabloom/share-math.js";
import {fixtureBill} from "../src/tabloom.js";
import {guestReviewPacket,previewGuestReview} from "../src/tabloom-guest-review.js";
function response(bill=fixtureBill(),table="legacy",guest="mira"){const p=guestReviewPacket(bill,table,guest);return {...p,kind:"tabloom-guest-response"};}
test("guest handoff excludes private notes and payment identifiers and previews exact tax/tip totals without saving",()=>{
 const bill=fixtureBill();bill.note="PRIVATE TEST NOTE";const packet=guestReviewPacket(bill,"table-a","mira");
 assert.ok(!JSON.stringify(packet).includes(bill.note));assert.ok(!("payments" in packet));assert.ok(!("guests" in packet));
 const r={...packet,kind:"tabloom-guest-response"};r.items.find(i=>i.id==="dumplings")!.selected=true;
 const preview=previewGuestReview(bill,"table-a",r);assert.equal(preview.changes.length,1);assert.equal(preview.calculated!.dues.reduce((n,d)=>n+d.totalCents,0),4875);
 assert.deepEqual(bill, {...fixtureBill(),note:"PRIVATE TEST NOTE"});assert.deepEqual(preview.bill.items[1].sharedBy,["joss","petra","mira"]);
});
test("opting out of sole-owned food remains visibly unassigned without silently billing someone else",()=>{
 const bill=fixtureBill(),r=response();r.items[0].selected=false;
 const p=previewGuestReview(bill,"legacy",r);assert.equal(p.calculated,null);assert.deepEqual(p.bill.items[0].sharedBy,[]);assert.equal(p.unresolved[0].id,"udon");
});
test("reject other tables, stale receipts, changed same-revision amounts, unknown and repeated answers",()=>{
 const bill=fixtureBill(),r=response();
 assert.throws(()=>previewGuestReview(bill,"other",r),/another table/);
 assert.throws(()=>previewGuestReview({...bill,revision:1},"legacy",r),/older or different/);
 const changed=structuredClone(bill);changed.items[0].cents++;assert.throws(()=>previewGuestReview(changed,"legacy",r),/older or different/);
 for(const items of [r.items.slice(1),[r.items[0],r.items[0],r.items[2]],[{...r.items[0],id:"unknown"},...r.items.slice(1)],[{...r.items[0],selected:"true"},...r.items.slice(1)]])assert.throws(()=>previewGuestReview(bill,"legacy",{...r,items}));
});
test("a guest file never unlocks a bill with payment requests",()=>{
 const bill=fixtureBill(),r=response();bill.payments.mira={requestId:"test",status:"creating",amountCents:1};
 assert.throws(()=>previewGuestReview(bill,"legacy",r),/Payment requests/);assert.throws(()=>guestReviewPacket(bill,"legacy","mira"),/Payment requests/);
});


test("offline estimates match organizer review for every choice, portions, discounts and cent ties",()=>{
  const ordinary=fixtureBill(),weighted=fixtureBill();
  weighted.discountCents=733;weighted.taxCents=117;weighted.tipCents=509;
  weighted.items[1].portions={joss:3,petra:1};weighted.items[2].cents=751;
  const tied=fixtureBill();tied.guests=[{id:"z10",name:"Private Z"},{id:"a2",name:"Private A"},{id:"b1",name:"Private B"}];
  tied.items=tied.items.map((item,index)=>({...item,cents:101+index,sharedBy:tied.guests.map(g=>g.id)}));tied.discountCents=7;tied.taxCents=1;tied.tipCents=2;
  for(const bill of [ordinary,weighted,tied])for(const guest of bill.guests){
    const packet=guestReviewPacket(bill,"offline",guest.id);
    for(let mask=0;mask<2**bill.items.length;mask++){
      const items=packet.items.map((item,index)=>({id:item.id,selected:!!(mask&(1<<index))}));
      const expected=previewGuestReview(bill,"offline",{...packet,kind:"tabloom-guest-response",items});
      const actual=estimateOfflineChoices(packet,items);
      assert.deepEqual(actual.unresolved,expected.unresolved);
      if(!expected.calculated){assert.equal(actual.share,null);continue;}
      const due=expected.calculated.dues.find(d=>d.guestId===guest.id)!;
      for(const key of ["itemsCents","taxCents","tipCents","totalCents"] as const)assert.equal(actual.share[key],due[key]);
      assert.equal(actual.share.discountCents,due.discountCents||0);
      assert.deepEqual(actual.share.lineItems.map((line:any)=>[line.itemId,line.shareCents,line.sharedCount,line.portionCount,line.totalPortions]),due.lineItems.map(line=>[line.itemId,line.shareCents,line.sharedCount,line.portionCount,line.totalPortions]));
    }
    const basis=JSON.stringify(packet.offlineEstimate);
    for(const other of bill.guests){assert.ok(!basis.includes(other.id));assert.ok(!basis.includes(other.name));}
    assert.equal(guestReviewPacket(bill,"offline",guest.id,true).offlineEstimate,undefined);
  }
});
