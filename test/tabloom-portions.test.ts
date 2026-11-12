import test from "node:test";
import assert from "node:assert/strict";
import { fixtureBill, validateDraft, calculateBill } from "../src/tabloom.js";
import { guestReviewPacket, previewGuestReview } from "../src/tabloom-guest-review.js";
function coffeeBill(){
  const bill=fixtureBill();
  return validateDraft({...bill,guests:bill.guests.slice(0,2),items:[{id:"coffee",name:"Three coffees",cents:1501,sharedBy:["mira","joss"],portions:{mira:2,joss:1}}],taxCents:301,tipCents:0},1,{});
}
test("three coffees allocate 2:1 with exact cents and proportional tax",()=>{
  const bill=coffeeBill(), result=calculateBill(bill);
  assert.deepEqual(result.dues.map(d=>d.itemsCents),[1001,500]);
  assert.deepEqual(result.dues.map(d=>d.taxCents),[201,100]);
  assert.deepEqual(result.dues.map(d=>d.totalCents),[1202,600]);
  assert.equal(result.totalCents,1802);
  assert.equal(result.dues[0].lineItems[0].portionCount,2);
  assert.equal(result.dues[0].lineItems[0].totalPortions,3);
  const reloaded=validateDraft(JSON.parse(JSON.stringify(bill)),1,{});
  assert.deepEqual(calculateBill(reloaded),result);
});
test("portion counts cannot silently omit, invent, zero or fraction a payer",()=>{
  const bill=coffeeBill();
  for(const portions of [{mira:2},{mira:2,joss:1,petra:1},{mira:0,joss:1},{mira:1.5,joss:1},{mira:1001,joss:1},null]){
    assert.throws(()=>validateDraft({...bill,items:[{...bill.items[0],portions}]},2,{}),/portion/);
  }
  const equal=validateDraft({...bill,items:[{...bill.items[0],portions:undefined}]},2,{});
  assert.deepEqual(calculateBill(equal).dues.map(d=>d.itemsCents),[750,751]);
});
test("guest review explains portions, preserves unchanged answers and resets changed membership",()=>{
  const bill=coffeeBill(),packet=guestReviewPacket(bill,"dinner","mira");
  assert.equal(packet.items[0].portionCount,2);
  const response={...packet,kind:"tabloom-guest-response",items:packet.items.map(i=>({id:i.id,selected:i.selected}))};
  assert.deepEqual(previewGuestReview(bill,"dinner",response).bill.items[0].portions,{mira:2,joss:1});
  const changed=previewGuestReview(bill,"dinner",{...response,items:[{id:"coffee",selected:false}]});
  assert.equal(changed.bill.items[0].portions,undefined);
  assert.deepEqual(changed.bill.items[0].sharedBy,["joss"]);
  assert.equal(changed.calculated!.dues.find(d=>d.guestId==="joss")!.totalCents,1802);
});
