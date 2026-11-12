import test from "node:test";
import assert from "node:assert/strict";
import { fixtureBill, validateDraft, proportionalCents, calculateBill, parseSuggestions } from "../src/tabloom.js";
test("the receipt reconciles to an exact cent and tax/tip are proportional",()=>{
  const bill=fixtureBill();
  const r=calculateBill(bill);
  assert.equal(r.subtotalCents,3800);
  assert.equal(r.totalCents,4875);
  assert.equal(r.dues.reduce((n,g)=>n+g.totalCents,0),4875);
  assert.deepEqual(r.dues.map(g=>g.itemsCents),[1900,950,950]);
  assert.deepEqual(r.dues.map(g=>g.totalCents),[2437,1219,1219]);
});
test("largest remainder is deterministic even at extreme safe weights",()=>{
  assert.deepEqual(proportionalCents(2,[{id:"z",weight:1},{id:"a",weight:1},{id:"m",weight:1}]),{z:0,a:1,m:1});
  assert.equal(Object.values(proportionalCents(9999999,[{id:"a",weight:9000000},{id:"b",weight:8000000}])).reduce((a,b)=>a+b,0),9999999);
});
test("bad or ambiguous drafts never enter the settlement",()=>{
  const original=fixtureBill();
  for (const input of [{...original,items:[{...original.items[0],sharedBy:["unknown"]}]},{...original,items:[{...original.items[0],cents:9.5}]},{...original,guests:[original.guests[0],original.guests[0]]},{...original,tipCents:-1}]) assert.throws(()=>validateDraft(input,1,{}));
  assert.equal(validateDraft(original,1,{}).revision,1);
});
test("model must cover known items with known guests; no money authority",()=>{
  const bill=fixtureBill();
  const raw=JSON.stringify({assignments:bill.items.map(i=>({itemId:i.id,guestIds:[bill.guests[0].id],reason:"note"}))});
  assert.equal(parseSuggestions(raw,bill).length,3);
  assert.throws(()=>parseSuggestions(JSON.stringify({assignments:[{itemId:"udon",guestIds:["bad"],reason:"?"}]}),bill));
  assert.throws(()=>parseSuggestions(JSON.stringify({assignments:bill.items.map(i=>({itemId:i.id,guestIds:[],reason:""}))}),bill));
  assert.throws(()=>parseSuggestions("not json",bill));
});


test("partial model proposals retain useful choices but unresolved items cannot apply",()=>{
  const bill=fixtureBill();const first={itemId:bill.items[0].id,guestIds:[bill.guests[0].id],reason:"Explicit note"};
  const proposals=parseSuggestions(JSON.stringify({assignments:[first]}),bill,true);
  assert.equal(proposals.length,bill.items.length);assert.deepEqual(proposals[0],first);
  assert.deepEqual(proposals[1].guestIds,[]);
  assert.throws(()=>parseSuggestions(JSON.stringify({assignments:proposals}),bill),/at least one/);
  assert.throws(()=>parseSuggestions(JSON.stringify({assignments:[first,first]}),bill,true),/duplicate/);
  assert.throws(()=>parseSuggestions(JSON.stringify({assignments:[{...first,guestIds:["invented"]}]}),bill,true),/unknown/);
});
