import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,readFile,stat,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createServer} from "node:http";
import {TabloomService,handleTabloom} from "../src/tabloom-service.js";
import {fixtureBill,validateDraft} from "../src/tabloom.js";
const photo=Buffer.from([255,216,255,224,1,2,3,4]);
test("original receipt survives saved dinner restart with exact private bytes and no guest disclosure",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"tabloom-source-"));const path=join(dir,"bill.json");
 try{
  const service=new TabloomService(path);const source=await service.stageReceiptSource(photo,"image/jpeg");
  assert.equal((await service.state()).bill.revision,0);
  await assert.rejects(()=>service.receiptSource(source.id),/not found/);
  const saved=await service.updateDraft({...fixtureBill(),receiptSources:[source]},0);
  const restarted=new TabloomService(path);
  assert.deepEqual((await restarted.receiptSource(source.id)).data,photo);
  assert.deepEqual((await restarted.state()).bill.receiptSources,[source]);
  assert.equal((await stat(path+".receipts/"+source.id)).mode&0o777,0o600);
  assert.equal(JSON.stringify(await restarted.guestReview("mira")).includes(source.id),false);
  assert.equal(JSON.stringify(await restarted.guestCheckout("mira")).includes(source.id),false);
  const second=await service.stageReceiptSource(Buffer.concat([photo,Buffer.from([5])]),"image/jpeg");
  await service.updateDraft({...saved.bill,receiptSources:[source,second]},1);
  assert.deepEqual((await restarted.receiptSource(second.id)).data,Buffer.concat([photo,Buffer.from([5])]));
  await service.updateDraft({...saved.bill,receiptSources:[second]},2);
  await assert.rejects(()=>restarted.receiptSource(source.id),/not found/);
  assert.deepEqual(await readFile(path+".receipts/"+source.id),photo);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test("source validation and missing bytes never change the saved dinner",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"tabloom-source-invalid-"));const path=join(dir,"bill.json");
 try{
  const service=new TabloomService(path);const source=await service.stageReceiptSource(photo,"image/jpeg");
  await service.updateDraft(fixtureBill(),0);const before=await readFile(path,"utf8");
  await assert.rejects(()=>service.stageReceiptSource(photo,"image/png"),/Choose/);
  await assert.rejects(()=>service.stageReceiptSource(Buffer.alloc(21*1024*1024),"image/jpeg"),/Choose/);
  assert.throws(()=>validateDraft({...fixtureBill(),receiptSources:[{...source,id:"../bill.json"}]},1,{}),/Invalid original/);
  await assert.rejects(()=>service.updateDraft({...fixtureBill(),receiptSources:[{...source,id:"a".repeat(64)}]},1),/missing/);
  await assert.rejects(()=>service.updateDraft({...fixtureBill(),receiptSources:[source]},0),/Reload/);
  await assert.rejects(()=>service.updateDraft({...fixtureBill(),items:[{...fixtureBill().items[0],sharedBy:[]}],receiptSources:[source]},1),/at least/);
  assert.equal(await readFile(path,"utf8"),before);
  const locked=JSON.parse(before);locked.payments.mira={requestId:"retained",status:"awaiting_approval",amountCents:1};
  await writeFile(path,JSON.stringify(locked));
  await assert.rejects(()=>service.stageReceiptSource(photo,"image/jpeg"),/locked/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test("organizer HTTP source retains original bytes only for its saved dinner",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"tabloom-source-http-"));const service=new TabloomService(join(dir,"bill.json"));
 const server=createServer((req,res)=>void handleTabloom(req,res,service));
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const origin="http://127.0.0.1:"+(server.address() as {port:number}).port;
 try{
  const staged=await fetch(origin+"/tabloom/api/receipt-source",{method:"POST",headers:{"content-type":"image/jpeg",origin},body:photo});
  assert.equal(staged.status,200);const source=await staged.json() as {id:string};
  const url=origin+"/tabloom/api/receipt-source?id="+source.id;
  assert.equal((await fetch(url)).status,404);
  await service.updateDraft({...fixtureBill(),receiptSources:[source]},0);
  const reopened=await fetch(url);assert.equal(reopened.status,200);assert.equal(reopened.headers.get("content-type"),"image/jpeg");
  assert.deepEqual(Buffer.from(await reopened.arrayBuffer()),photo);
  const table="table-"+"a".repeat(32);
  await service.createTable(table,{title:"Another dinner",guests:["A","B"]});
  assert.equal((await fetch(url+"&table="+table)).status,404);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});
