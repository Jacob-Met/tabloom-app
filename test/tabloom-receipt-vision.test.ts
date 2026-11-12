import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReceiptVisionReader, ReceiptVisionError, reviewReceiptVisionResponse, reviewReceiptVisionTupleResponse, validateReceiptImage } from "../src/tabloom-receipt-vision.js";
const photo="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const fresh={"items":[{"name":"Coffee","printed_price":"2.95"},{"name":"Chicken Parmesan","printed_price":"17.95"},{"name":"Prime Top Sirloin","printed_price":"25.95"},{"name":"The Bacon-Cheese Burger","printed_price":"13.95"},{"name":"Coffee","printed_price":"2.95"}],"printed_subtotal":"63.75","printed_tax":"5.50","printed_tip":"None","printed_discount":"None","printed_total":"69.25"},zero={"items":[{"name":"1 Power Veg Bowl","printed_price":"4.99"},{"name":"No Sour Cream","printed_price":"0.00"},{"name":"No Cheese","printed_price":"0.00"},{"name":"1 Rg Orange Crsh Fz","printed_price":"1.99"}],"printed_subtotal":"6.98","printed_tax":"0.63","printed_tip":null,"printed_discount":null,"printed_total":"7.61"};
test("observed fresh result preserves duplicate rows and literal None as unresolved",()=>{
 const r=reviewReceiptVisionResponse(JSON.stringify(fresh));
 assert.deepEqual(r.items.map(x=>[x.name,x.price.cents]),[["Coffee",295],["Chicken Parmesan",1795],["Prime Top Sirloin",2595],["The Bacon-Cheese Burger",1395],["Coffee",295]]);
 assert.equal(r.printed.printed_subtotal.cents,6375);assert.equal(r.printed.printed_tax.cents,550);assert.equal(r.printed.printed_total.cents,6925);
 assert.equal(r.printed.printed_tip.raw,"None");assert.equal(r.printed.printed_tip.cents,null);assert.equal(r.issues.filter(x=>x.field!=="currency").length,2);assert.equal(r.currency,"unconfirmed");
 assert.equal(r.reviewRequired,true);assert.equal(r.rawResponse,JSON.stringify(fresh));
});
test("zero-price rows remain visible and absent values never become zero",()=>{
 const r=reviewReceiptVisionResponse(JSON.stringify(zero));assert.deepEqual(r.items.map(x=>x.price.cents),[499,0,0,199]);
 assert.equal(r.issues.filter(x=>x.field!=="currency").length,2);assert.equal(r.currency,"unconfirmed");assert.equal(r.printed.printed_tip.cents,null);
});
test("unreadable money remains unresolved and malformed structure is rejected",()=>{
 const r=reviewReceiptVisionResponse(JSON.stringify({...fresh,items:[{name:"Unknown",printed_price:"[unreadable]"}],printed_tax:"£5.50",printed_tip:null}));
 assert.equal(r.items[0].price.cents,null);assert.equal(r.printed.printed_tax.raw,"£5.50");assert.equal(r.printed.printed_tax.cents,null);
 assert.throws(()=>reviewReceiptVisionResponse('{"items":['),ReceiptVisionError);
 assert.throws(()=>reviewReceiptVisionResponse(JSON.stringify({...fresh,unexpected:true})),ReceiptVisionError);
 assert.throws(()=>reviewReceiptVisionResponse(JSON.stringify({...fresh,items:[{name:"Coffee\nTotal",printed_price:"2.95"}]})),ReceiptVisionError);
});
test("PNG boundary rejects remote inputs, wrong format and impossible dimensions",()=>{
 assert.equal(validateReceiptImage(photo).width,1);
 assert.throws(()=>validateReceiptImage("https://example.invalid/photo.png"),ReceiptVisionError);
 assert.throws(()=>validateReceiptImage(photo.replace("image/png","image/jpeg")),ReceiptVisionError);
 const b=Buffer.from(photo.split(",")[1],"base64");b.writeUInt32BE(10000,16);
 assert.throws(()=>validateReceiptImage("data:image/png;base64,"+b.toString("base64")),ReceiptVisionError);
});
test("unconfigured optional reader retains browser default",async()=>{
 const reader=new ReceiptVisionReader({}),s=await reader.status();assert.equal(s.available,false);assert.equal(s.defaultReader,"browser");
 await assert.rejects(reader.read(photo),e=>e instanceof ReceiptVisionError&&e.status===503);
});
test("controlled child is serialized, cancelled, then supports a deliberate next tuple read",async()=>{
 const dir=await fs.mkdtemp(join(tmpdir(),"tabloom-vision-test-"));
 // Controlled process fixture; not model or accuracy evidence.
 const script=[
  'const fs=require("node:fs"),path=require("node:path");',
  'const args=process.argv.slice(2),get=k=>args[args.indexOf(k)+1];',
  'fs.appendFileSync(path.join(__dirname,"started"),"one\\n");',
  'fs.writeFileSync(path.join(__dirname,"arguments.json"),JSON.stringify(args));',
  'const manifest=JSON.parse(fs.readFileSync(get("--manifest"),"utf8"));',
  'const request={response_format:JSON.parse(fs.readFileSync(get("--response-format"),"utf8"))};',
  'setTimeout(()=>{const out=get("--output");fs.mkdirSync(out,{recursive:true});',
  'fs.writeFileSync(path.join(out,"run.json"),JSON.stringify({status:"completed",responses_complete:true,attempted_requests:1,manifest,projector_identity:{sha256:manifest.projector.sha256},source_sha256:"controlled-process-fixture",requests:[{request,response_complete:true,finish_reason:"stop",content:'+JSON.stringify(JSON.stringify(tuple(fresh)))+'}]}));},250);'
 ].join("\n");
 await fs.writeFile(join(dir,"run_reference.py"),script);
 const reader=new ReceiptVisionReader({TABLOOM_RECEIPT_REFERENCE_DIR:dir,TABLOOM_RECEIPT_REFERENCE_ASSETS:dir,TABLOOM_RECEIPT_REFERENCE_PYTHON:process.execPath},async()=>({availableBytes:12*1024**3,cpus:4}));
 try{
  const c=new AbortController(),reading=reader.read(photo,c.signal);
  const stopped=assert.rejects(reading,e=>e instanceof DOMException&&e.name==="AbortError");
  for(let i=0;i<100;i++){try{await fs.access(join(dir,"started"));break;}catch{}await new Promise(r=>setTimeout(r,10));}
  assert.equal((await fs.readFile(join(dir,"started"),"utf8")).trim(),"one");
  const busy=await reader.status();assert.equal(busy.busy,true);assert.equal(busy.available,true);
  await assert.rejects(reader.read(photo),e=>e instanceof ReceiptVisionError&&e.status===409);
  c.abort();await stopped;
  const r=await reader.read(photo);assert.equal(r.reviewRequired,true);assert.equal(r.model.runnerSourceSha256,"controlled-process-fixture");assert.equal(r.model.responseFormat,"tuple-v1");
  assert.deepEqual(r.items.map(x=>[x.name,x.price.cents]),reviewReceiptVisionResponse(JSON.stringify(fresh)).items.map(x=>[x.name,x.price.cents]));
  const args=JSON.parse(await fs.readFile(join(dir,"arguments.json"),"utf8"));
  assert.ok(args.includes("--response-format"));assert.ok(!args.includes("--grammar-file"));assert.ok(!args.includes("--capabilities"));
  assert.equal((await fs.readFile(join(dir,"started"),"utf8")).trim().split("\n").length,2);
  const before=new AbortController();before.abort();
  await assert.rejects(reader.read(photo,before.signal),e=>e instanceof DOMException&&e.name==="AbortError");
  assert.equal((await fs.readFile(join(dir,"started"),"utf8")).trim().split("\n").length,2);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test("insufficient effective memory refuses launch before creating a child",async()=>{
 const reader=new ReceiptVisionReader({TABLOOM_RECEIPT_REFERENCE_DIR:"/does-not-exist",TABLOOM_RECEIPT_REFERENCE_ASSETS:"/does-not-exist"},async()=>({availableBytes:5*1024**3,cpus:4}));
 await assert.rejects(reader.read(photo),e=>e instanceof ReceiptVisionError&&e.status===503&&/10 GiB/.test(e.message));
});

test("observed Napoli dollar-prefixed values prefill exactly while raw source and currency review remain",()=>{
 const raw="{\n  \"items\": [\n    {\n      \"name\": \"Polpette della Nonna\",\n      \"printed_price\": \"$14.00\"\n    },\n    {\n      \"name\": \"Margherita\",\n      \"printed_price\": \"$22.00\"\n    },\n    {\n      \"name\": \"Tiramisu\",\n      \"printed_price\": \"$12.00\"\n    }\n  ],\n  \"printed_subtotal\": \"$48.00\",\n  \"printed_tax\": \"$4.45\",\n  \"printed_tip\": null,\n  \"printed_discount\": null,\n  \"printed_total\": \"$52.45\"\n}";
 const r=reviewReceiptVisionResponse(raw);
 assert.deepEqual(r.items.map(x=>[x.name,x.price.raw,x.price.cents]),[["Polpette della Nonna","$14.00",1400],["Margherita","$22.00",2200],["Tiramisu","$12.00",1200]]);
 assert.deepEqual([r.printed.printed_subtotal.cents,r.printed.printed_tax.cents,r.printed.printed_total.cents],[4800,445,5245]);
 assert.equal(r.printed.printed_tip.cents,null);assert.equal(r.printed.printed_discount.cents,null);
 assert.equal(r.rawResponse,raw);assert.equal(r.currency,"unconfirmed");assert.equal(r.reviewRequired,true);
 assert.deepEqual(r.issues.map(x=>x.field),["currency"]);
});
test("a dollar prefix does not repair malformed, ambiguous or foreign money",()=>{
 for(const value of ["$$14.00","$ 14.00","$14","$14.0","$014.00","$1,400.00","$14,00","$-14.00","$1e2","$None","$[unreadable]","USD14.00","CA$14.00","£14.00","$1000000.00"]){
  const r=reviewReceiptVisionResponse(JSON.stringify({...fresh,items:[{name:"Uncertain",printed_price:value}]}));
  assert.deepEqual(r.items[0].price,{raw:value,cents:null},value);
  assert.ok(r.issues.some(x=>x.field==="items.0.printed_price"),value);
 }
 const r=reviewReceiptVisionResponse(JSON.stringify({...zero,items:[{name:"Possible modifier",printed_price:"$0.00"}]}));
 assert.equal(r.items[0].price.cents,0);assert.ok(r.issues.some(x=>x.field==="items.0.printed_price"&&x.message.includes("zero-price")));
});

const printedKeys=["printed_subtotal","printed_tax","printed_tip","printed_discount","printed_total"] as const;
const tuple=(value: typeof fresh | typeof zero)=>({v:1,items:value.items.map(row=>[row.name,row.printed_price]),printed:printedKeys.map(key=>value[key])});
test("tuple receipt preserves exact duplicates, Unicode, uncertain amounts and raw response",()=>{
 const named={...fresh,items:[...fresh.items,{name:'Sopa "rústica" \\ pan',printed_price:"[unreadable]"}]};
 const raw=JSON.stringify(tuple(named),null,2);
 const observed=reviewReceiptVisionTupleResponse(raw),expected=reviewReceiptVisionResponse(JSON.stringify(named));
 assert.deepEqual({...observed,rawResponse:""}, {...expected,rawResponse:""});
 assert.equal(observed.rawResponse,raw);assert.equal(observed.printed.printed_tip.raw,"None");
 assert.equal(observed.items.at(-1)?.name,'Sopa "rústica" \\ pan');
});
test("each printed tuple slot remains distinct and explicit null never becomes zero",()=>{
 for(let slot=0;slot<printedKeys.length;slot++){
  const values:(string|null)[]=[null,null,null,null,null];values[slot]="1.23";
  const observed=reviewReceiptVisionTupleResponse(JSON.stringify({v:1,items:[["Modifier","0.00"]],printed:values}));
  for(let index=0;index<printedKeys.length;index++){
   assert.deepEqual(observed.printed[printedKeys[index]],index===slot?{raw:"1.23",cents:123}:{raw:null,cents:null});
  }
  assert.equal(observed.items[0].price.cents,0);assert.ok(observed.issues.some(x=>x.field==="items.0.printed_price"));
 }
 const empty=reviewReceiptVisionTupleResponse(JSON.stringify({v:1,items:[],printed:[null,null,null,null,null]}));
 assert.deepEqual(empty.items,[]);assert.ok(empty.issues.some(x=>x.field==="items"));
});
test("tuple receipt rejects other versions, missing or extra slots and non-string money",()=>{
 const good=tuple(zero);
 for(const bad of [
  {...good,v:"1"},{...good,v:2},{...good,unexpected:true},{items:good.items,printed:good.printed},
  {...good,items:[["Coffee"]]},{...good,items:[["Coffee","2.95","extra"]]},
  {...good,items:[[2,"2.95"]]},{...good,items:[["Coffee",2.95]]},
  {...good,items:[["Coffee\nTotal","2.95"]]},{...good,items:Array.from({length:101},()=>["Coffee","2.95"])},
  {...good,printed:good.printed.slice(0,4)},{...good,printed:[...good.printed,null]},
  {...good,printed:[null,null,0,null,null]},fresh,
 ]) assert.throws(()=>reviewReceiptVisionTupleResponse(JSON.stringify(bad)),ReceiptVisionError);
 assert.throws(()=>reviewReceiptVisionTupleResponse('{"v":1,"items":['),ReceiptVisionError);
});
test("tuple result requires the exact requested schema before review",async()=>{
 const dir=await fs.mkdtemp(join(tmpdir(),"tabloom-vision-binding-test-"));
 const script=[
  'const fs=require("node:fs"),path=require("node:path");const args=process.argv.slice(2),get=k=>args[args.indexOf(k)+1];',
  'const manifest=JSON.parse(fs.readFileSync(get("--manifest"),"utf8"));',
  'const out=get("--output");fs.mkdirSync(out,{recursive:true});',
  'fs.writeFileSync(path.join(out,"run.json"),JSON.stringify({status:"completed",responses_complete:true,attempted_requests:1,manifest,projector_identity:{sha256:manifest.projector.sha256},requests:[{request:{response_format:{type:"json_object"}},response_complete:true,finish_reason:"stop",content:'+JSON.stringify(JSON.stringify(tuple(zero)))+'}]}));'
 ].join("\n");
 await fs.writeFile(join(dir,"run_reference.py"),script);
 const reader=new ReceiptVisionReader({TABLOOM_RECEIPT_REFERENCE_DIR:dir,TABLOOM_RECEIPT_REFERENCE_ASSETS:dir,TABLOOM_RECEIPT_REFERENCE_PYTHON:process.execPath},async()=>({availableBytes:12*1024**3,cpus:4}));
 try{await assert.rejects(reader.read(photo),error=>error instanceof ReceiptVisionError&&error.status===502);}
 finally{await fs.rm(dir,{recursive:true,force:true});}
});
