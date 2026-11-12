import {test} from "node:test";
import assert from "node:assert/strict";
import {createGuestDraftStore,readGuestChoices} from "../tabloom/guest-review.js";
function storage(){const values=new Map();return {get length(){return values.size},key:i=>[...values.keys()][i]??null,getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};}
const packet=()=>({live:true,tableId:"dinner-a",guestId:"amal",revision:2,fingerprint:"receipt-a",expiresAt:new Date(61000).toISOString(),submittedAt:null,items:[{id:"rice",selected:true},{id:"bun",selected:false}]});
const changed=[{id:"rice",selected:true},{id:"bun",selected:true}];
test("unsent choices survive reload only for the same invitation and receipt context",()=>{
 const disk=storage(),p=packet();const original=createGuestDraftStore(disk,p,"/guest/a",()=>1000);
 assert.equal(original.save(changed),true);
 assert.deepEqual(createGuestDraftStore(disk,p,"/guest/a",()=>2000).load(),changed);
 assert.equal(createGuestDraftStore(disk,p,"/guest/b",()=>2000).load(),null);
 for(const altered of [{guestId:"bo"},{tableId:"dinner-b"},{revision:3},{fingerprint:"different"},{submittedAt:"new server response"}]){
  original.save(changed);assert.equal(createGuestDraftStore(disk,{...p,...altered},"/guest/a",()=>2000).load(),null);
 }
 original.save(changed);assert.equal(createGuestDraftStore(disk,p,"/guest/a",()=>61001).load(),null);
});
test("returning to server choices and confirmed Send clear the local draft",()=>{
 const disk=storage(),p=packet(),store=createGuestDraftStore(disk,p,"/guest/a",()=>1000);
 store.save(changed);store.save(p.items);assert.equal(store.load(),null);
 store.save(changed);store.clear();assert.equal(store.load(),null);
 const received={...p,submittedAt:"received",responseItems:changed};
 const after=createGuestDraftStore(disk,received,"/guest/a",()=>1000);
 assert.equal(after.save(changed),true);assert.equal(after.load(),null);
});
test("invalid, stale and unavailable browser storage cannot change guest choices",()=>{
 const disk=storage(),p=packet(),store=createGuestDraftStore(disk,p,"/guest/a",()=>1000);
 assert.equal(store.save([{id:"rice",selected:true},{id:"rice",selected:false}]),false);
 assert.equal(store.save([{id:"rice",selected:true},{id:"other",selected:false}]),false);
 assert.equal(store.save([{id:"rice",selected:true},{id:"bun",selected:"yes"}]),false);
 disk.setItem("tabloom-guest-draft-v1:/guest/a","broken");
 assert.equal(store.load(),null);
 const unavailable=createGuestDraftStore({getItem(){throw Error("storage denied")},setItem(){throw Error("storage denied")},removeItem(){throw Error("storage denied")}},p,"/guest/a",()=>1000);
 assert.equal(unavailable.load(),null);assert.equal(unavailable.save(changed),false);
 assert.equal(createGuestDraftStore(undefined,{...p,live:false},"/form.html",()=>1000).save(changed),false);
});
test("draft storage stays bounded without deleting unrelated browser data",()=>{
 const disk=storage();disk.setItem("unrelated","keep");
 for(let index=0;index<25;index++)assert.equal(createGuestDraftStore(disk,packet(),"/guest/"+index,()=>1000+index).save(changed),true);
 assert.equal(disk.length,21);assert.equal(disk.getItem("unrelated"),"keep");
 const raw=JSON.parse(disk.getItem("tabloom-guest-draft-v1:/guest/24"));
 assert.deepEqual(Object.keys(raw.items[0]).sort(),["id","selected"]);assert.equal("totalCents" in raw,false);
});

test("offline choices recover for one day only in the same file and receipt context",()=>{
 const disk=storage(),p={...packet(),live:false};delete p.expiresAt;
 const original=createGuestDraftStore(disk,p,"/mira.html",()=>1000);
 assert.equal(original.save(changed),true);
 assert.deepEqual(createGuestDraftStore(disk,p,"/mira.html",()=>2000).load(),changed);
 assert.equal(createGuestDraftStore(disk,p,"/joss.html",()=>2000).load(),null);
 assert.equal(createGuestDraftStore(disk,{...p,live:true,expiresAt:new Date(61000).toISOString()},"/mira.html",()=>2000).load(),null);
 for(const altered of [{guestId:"other"},{tableId:"other"},{revision:3},{fingerprint:"other"}]){
  original.save(changed);assert.equal(createGuestDraftStore(disk,{...p,...altered},"/mira.html",()=>2000).load(),null);
 }
 original.save(changed);
 assert.equal(createGuestDraftStore(disk,p,"/mira.html",()=>1000+24*60*60*1000).load(),null);
 original.save(changed);original.clear();assert.equal(original.load(),null);
 original.save(changed);original.save(p.items);assert.equal(original.load(),null);
 assert.equal(disk.length,0);
});

test("fresh invitation offers earlier named choices without accepting or loading them as current",()=>{
 const disk=storage(),old={...packet(),items:[{id:"rice",name:"Rice",selected:true},{id:"bun",name:"Buns",selected:false}]};
 const first=createGuestDraftStore(disk,old,"/guest/old",()=>1000);first.save(changed);
 const fresh={...old,revision:3,fingerprint:"new",items:[{id:"rice",name:"Rice",selected:true,cents:1900},{id:"bun",name:"Buns",selected:false,cents:2100,portions:{bo:3}}]};
 const store=createGuestDraftStore(disk,fresh,"/guest/fresh",()=>2000);
 assert.equal(store.load(),null);const before=disk.getItem("tabloom-guest-draft-v1:/guest/old");
 assert.deepEqual(store.earlier().items,changed);assert.equal(store.earlier().revision,2);
 assert.equal(disk.getItem("tabloom-guest-draft-v1:/guest/old"),before);
 assert.equal(disk.getItem("tabloom-guest-draft-v1:/guest/fresh"),null);
 assert.equal("cents" in store.earlier().items[1],false);
});
test("earlier choices skip removed and renamed items and never infer identity from names alone",()=>{
 const disk=storage(),old={...packet(),items:[{id:"rice",name:"Rice",selected:true},{id:"bun",name:"Buns",selected:false},{id:"tea",name:"Tea",selected:true}]};
 createGuestDraftStore(disk,old,"/guest/old",()=>1000).save([{id:"rice",selected:false},{id:"bun",selected:true},{id:"tea",selected:false}]);
 const fresh={...old,revision:3,fingerprint:"new",items:[{id:"rice",name:"Different dish",selected:true},{id:"bun",name:"Buns",selected:false},{id:"new-tea",name:"Tea",selected:true}]};
 const earlier=createGuestDraftStore(disk,fresh,"/guest/fresh",()=>2000).earlier();
 assert.deepEqual(earlier.items,[{id:"bun",selected:true}]);assert.equal(earlier.skipped,2);
});
test("earlier draft reuse excludes other people, tables, expiry, submitted pages and legacy identity",()=>{
 const old={...packet(),items:[{id:"rice",name:"Rice",selected:true},{id:"bun",name:"Buns",selected:false}]};
 for(const difference of [{guestId:"bo"},{tableId:"dinner-b"},{revision:2,fingerprint:"other"},{revision:1},{live:false},{submittedAt:"already received"}]){
  const disk=storage();createGuestDraftStore(disk,old,"/guest/old",()=>1000).save(changed);
  assert.equal(createGuestDraftStore(disk,{...old,revision:3,...difference},"/guest/new",()=>2000).earlier(),null);
 }
 const disk=storage();createGuestDraftStore(disk,old,"/guest/old",()=>1000).save(changed);
 assert.equal(createGuestDraftStore(disk,{...old,revision:3,expiresAt:new Date(999999).toISOString()},"/guest/new",()=>61001).earlier(),null);
 const key="tabloom-guest-draft-v1:/guest/old",record=JSON.parse(disk.getItem(key));delete record.itemNames;disk.setItem(key,JSON.stringify(record));
 assert.equal(createGuestDraftStore(disk,{...old,revision:3},"/guest/new",()=>2000).earlier(),null);
 assert.deepEqual(createGuestDraftStore(disk,old,"/guest/old",()=>2000).load(),changed,"legacy exact-context recovery stays usable");
});

test("a changed received time offers same-invitation local choices without loading or sending them",()=>{
 const disk=storage(),p=packet(),path="/guest/original",old=createGuestDraftStore(disk,p,path,()=>1000);
 const further=[{id:"rice",selected:false},{id:"bun",selected:true}];
 old.save(further);const raw=disk.getItem("tabloom-guest-draft-v1:"+path);
 const received={...p,submittedAt:"2026-11-11T22:00:00.000Z",responseItems:changed};
 const current=createGuestDraftStore(disk,received,path,()=>2000);
 assert.equal(current.load(),null);assert.equal(disk.getItem("tabloom-guest-draft-v1:"+path),raw);
 assert.deepEqual(current.priorReply().items,further);
 assert.equal(current.priorReply().receivedChanged,true);
 current.save(further);assert.deepEqual(current.load(),further);assert.equal(current.priorReply(),null);
});
test("changed-reply recovery stays isolated, expires and ignores choices already received",()=>{
 const p=packet(),path="/guest/original";
 for(const difference of [{tableId:"other"},{guestId:"other"},{revision:3},{fingerprint:"other"},{live:false},{submittedAt:null},{submittedAt:"invalid"},{responseItems:[]}]) {
  const disk=storage();createGuestDraftStore(disk,p,path,()=>1000).save(changed);
  const current=createGuestDraftStore(disk,{...p,submittedAt:"2026-11-11T22:00:00Z",responseItems:p.items,...difference},path,()=>2000);
  assert.equal(current.priorReply(),null);
 }
 const disk=storage();createGuestDraftStore(disk,p,path,()=>1000).save(changed);
 const received={...p,submittedAt:"2026-11-11T22:00:00Z",responseItems:changed};
 assert.equal(createGuestDraftStore(disk,received,path,()=>2000).priorReply(),null);
 assert.equal(createGuestDraftStore(disk,{...received,responseItems:p.items},"/guest/other",()=>2000).priorReply(),null);
 assert.equal(createGuestDraftStore(disk,{...received,responseItems:p.items},path,()=>61001).priorReply(),null);
});

test("replacement invitation offers exact same-receipt choices only after explicit recovery",()=>{
 const disk=storage(),old={...packet(),items:[{id:"rice",name:"Rice",selected:true},{id:"bun",name:"Buns",selected:false}]};
 createGuestDraftStore(disk,old,"/guest/old",()=>1000).save(changed);
 const fresh={...old,expiresAt:new Date(120000).toISOString()};
 const store=createGuestDraftStore(disk,fresh,"/guest/new",()=>2000);
 assert.equal(store.load(),null);
 assert.deepEqual(store.earlier().items,changed);assert.equal(store.earlier().replacement,true);
 assert.equal(disk.getItem("tabloom-guest-draft-v1:/guest/new"),null);
 assert.equal(store.save(store.earlier().items),true);assert.deepEqual(store.load(),changed);
});
test("expired local choices remain bounded and require a fresh authorized same-receipt invitation",()=>{
 const disk=storage(),old={...packet(),items:[{id:"rice",name:"Rice",selected:true},{id:"bun",name:"Buns",selected:false}]};
 createGuestDraftStore(disk,old,"/guest/old",()=>1000).save(changed);
 const key="tabloom-guest-draft-v1:/guest/old",before=disk.getItem(key);
 const expired=createGuestDraftStore(disk,old,"/guest/old",()=>62000);
 assert.equal(expired.load(),null);assert.equal(expired.earlier(),null);assert.equal(expired.save(changed),false);
 assert.equal(disk.getItem(key),before);
 const fresh={...old,expiresAt:new Date(200000).toISOString()};
 assert.deepEqual(createGuestDraftStore(disk,fresh,"/guest/new",()=>62000).earlier().items,changed);
 createGuestDraftStore(disk,{...fresh,guestId:"bo"},"/guest/bo",()=>63000).save(changed);
 assert.equal(disk.getItem(key),before,"another active guest does not purge the bounded recovery");
 assert.equal(createGuestDraftStore(disk,{...fresh,expiresAt:new Date(90000000).toISOString()},"/guest/new",()=>86401000).earlier(),null);
});
test("replacement recovery rejects different context, partial identities and old or future records",()=>{
 const old={...packet(),items:[{id:"rice",name:"Rice",selected:true},{id:"bun",name:"Buns",selected:false}]};
 for(const altered of [{guestId:"bo"},{tableId:"other"},{fingerprint:"different"},{revision:1},{live:false},{submittedAt:"received"},{expiresAt:new Date(1500).toISOString()},{items:[old.items[0]]},{items:[old.items[0],{...old.items[1],name:"Renamed"}]}]){
  const disk=storage();createGuestDraftStore(disk,old,"/guest/old",()=>1000).save(changed);
  assert.equal(createGuestDraftStore(disk,{...old,...altered},"/guest/new",()=>2000).earlier(),null);
 }
 for(const storedAt of [3000,-1,NaN]){
  const disk=storage();createGuestDraftStore(disk,old,"/guest/old",()=>1000).save(changed);
  const key="tabloom-guest-draft-v1:/guest/old",record=JSON.parse(disk.getItem(key));record.storedAt=storedAt;disk.setItem(key,JSON.stringify(record));
  assert.equal(createGuestDraftStore(disk,old,"/guest/new",()=>2000).earlier(),null);
 }
});

test("response-file recovery imports only explicit choices for the current authorized guest",()=>{
 const p=packet(),response={kind:"tabloom-guest-response",version:1,tableId:p.tableId,guestId:p.guestId,revision:p.revision,fingerprint:p.fingerprint,items:changed.map(item=>({...item,cents:999999}))};
 assert.deepEqual(readGuestChoices(JSON.stringify(response),p,()=>1000),changed);
 assert.deepEqual(p.items,[{id:"rice",selected:true},{id:"bun",selected:false}],"loading does not mutate the invitation");
});
test("response-file recovery rejects mismatched context, identities and expired or submitted invitations",()=>{
 const p=packet(),response={kind:"tabloom-guest-response",version:1,tableId:p.tableId,guestId:p.guestId,revision:p.revision,fingerprint:p.fingerprint,items:changed};
 for(const altered of [{kind:"other"},{version:2},{tableId:"other"},{guestId:"bo"},{revision:3},{fingerprint:"other"},{items:[changed[0]]},{items:[changed[0],changed[0]]},{items:[changed[0],{id:"other",selected:true}]},{items:[changed[0],{id:"bun",selected:"true"}]}])
  assert.throws(()=>readGuestChoices(JSON.stringify({...response,...altered}),p,()=>1000),/does not match/);
 for(const altered of [{live:false},{submittedAt:"received"},{receiptChanged:true},{expiresAt:"bad"},{expiresAt:new Date(999).toISOString()}])
  assert.throws(()=>readGuestChoices(JSON.stringify(response),{...p,...altered},()=>1000),/does not match/);
 assert.throws(()=>readGuestChoices("broken",p,()=>1000),/downloaded/);
 assert.throws(()=>readGuestChoices(" ".repeat(16001),p,()=>1000),/16 KB/);
});
