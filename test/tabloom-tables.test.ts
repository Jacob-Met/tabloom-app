import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createServer} from "node:http";
import {TabloomService, handleTabloom} from "../src/tabloom-service.js";
import {fixtureBill} from "../src/tabloom.js";

const dinnerA="table-"+"a".repeat(32), dinnerB="table-"+"b".repeat(32);
const fill=(bill:any,title:string,cents:number)=>({...bill,title,items:[{id:"meal",name:"Shared dinner",cents,sharedBy:bill.guests.map((g:any)=>g.id)}]});

test("new dinners preserve the original bill and independently survive a server restart",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"tabloom-tables-"));const path=join(dir,"table.json");
  try{
    const svc=new TabloomService(path);
    await svc.updateDraft({...fixtureBill(),title:"Tuesday noodle dinner"},0);
    const before=await readFile(path,"utf8");
    const first=await svc.createTable(dinnerA,{title:"Wednesday pizza",guests:["Ada","Ben"]});
    assert.deepEqual(first.bill.items,[]);assert.equal(first.calculated.totalCents,0);
    assert.deepEqual(first.bill.payments,{});
    const second=await svc.createTable(dinnerB,{title:"Thursday lunch",guests:["Cleo","Dev"]});
    const a=await svc.table(dinnerA),b=await svc.table(dinnerB);
    await Promise.all([a.updateDraft(fill(first.bill,"Wednesday pizza",5501),0),b.updateDraft(fill(second.bill,"Thursday lunch",3317),0)]);
    assert.equal(await readFile(path,"utf8"),before,"the legacy dinner must not be overwritten");
    const restarted=new TabloomService(path);
    assert.equal((await (await restarted.table(dinnerA)).state()).calculated.totalCents,5501);
    assert.equal((await (await restarted.table(dinnerB)).state()).calculated.totalCents,3317);
    const tables=(await restarted.tableList()).tables;
    assert.equal(tables.length,3);
    assert.equal(tables.find(t=>t.id==="legacy")?.title,"Tuesday noodle dinner");
    assert.equal(tables.find(t=>t.id===dinnerB)?.itemCount,1);
    await assert.rejects(()=>a.updateDraft(fill(first.bill,"Stale edit",1000),0),/Reload/);
    assert.equal((await b.state()).calculated.totalCents,3317);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("repeating an uncertain create opens its original table without resetting later edits",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"tabloom-create-retry-"));
  try{
    const svc=new TabloomService(join(dir,"table.json"));
    const first=await svc.createTable(dinnerA,{title:"Lunch",guests:["Ada","Ben"]});
    const a=await svc.table(dinnerA);
    await a.updateDraft(fill(first.bill,"Lunch reviewed",1273),0);
    const replay=await svc.createTable(dinnerA,{title:"Lunch",guests:["Ada","Ben"]});
    assert.equal(replay.bill.title,"Lunch reviewed");assert.equal(replay.calculated.totalCents,1273);
    assert.equal((await svc.tableList()).tables.length,2);
    await assert.rejects(()=>svc.table(dinnerB),/could not be found/);
    await assert.rejects(()=>svc.table("../table"),/Choose a saved table/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("empty tables owe nothing and cannot gain tax, tip, or an invented payment",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"tabloom-empty-"));
  try{
    const svc=new TabloomService(join(dir,"table.json"));
    const first=await svc.createTable(dinnerA,{title:"New dinner",guests:["Ada","Ben"]});
    assert.ok(first.calculated.dues.every(d=>d.totalCents===0&&d.paidCents===0));
    const a=await svc.table(dinnerA);
    await assert.rejects(()=>a.updateDraft({...first.bill,taxCents:200},0),/Add receipt items/);
    await assert.rejects(()=>a.suggest(),/Add receipt items/);
    assert.equal((await a.state()).bill.revision,0);
    assert.deepEqual((await a.state()).bill.payments,{});
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("actual HTTP routes bind state and writes to the chosen table and never fall back to the example",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"tabloom-route-"));
  const svc=new TabloomService(join(dir,"table.json"));
  const server=createServer(async(req,res)=>{if(!await handleTabloom(req,res,svc)){res.writeHead(404);res.end();}});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const port=(server.address() as {port:number}).port;
  const call=(path:string,body?:unknown)=>fetch("http://127.0.0.1:"+port+"/tabloom/api/"+path,{method:body===undefined?"GET":"POST",headers:body===undefined?{}:{"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});
  try{
    const created=await call("tables",{tableId:dinnerA,details:{title:"One dinner",guests:["Ada","Ben"]}});assert.equal(created.status,200);
    const body=await created.json() as any;
    const save=await call("bill?table="+dinnerA,{bill:fill(body.bill,"One dinner",3041),revision:0});assert.equal(save.status,200);
    const selected=await (await call("state?table="+dinnerA)).json() as any;
    assert.equal(selected.tableId,dinnerA);assert.equal(selected.calculated.totalCents,3041);
    const legacy=await (await call("state")).json() as any;
    assert.equal(legacy.bill.title,fixtureBill().title);assert.equal(legacy.bill.revision,0);
    const missing=await call("state?table="+dinnerB);assert.equal(missing.status,404);
    assert.match((await missing.json() as any).error,/could not be found/);
    const wrongWrite=await call("bill?table="+dinnerB,{bill:fixtureBill(),revision:0});assert.equal(wrongWrite.status,404);
    assert.equal((await svc.state()).bill.revision,0);
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await rm(dir,{recursive:true,force:true});}
});

test("provider return and payment history remain attached to the dinner that requested them",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"tabloom-table-payment-"));
  const keys=["TABLOOM_PAYPAL_CLIENT_ID","TABLOOM_PAYPAL_CLIENT_SECRET"] as const;
  const old=keys.map(key=>process.env[key]);keys.forEach(key=>process.env[key]="synthetic-test-only");
  let creates=0;
  const fetcher=async(input:URL|string|Request,init?:RequestInit):Promise<Response>=>{
    const url=String(input);
    if(url.endsWith("/token"))return new Response(JSON.stringify({access_token:"test-only"}));
    assert.ok(url.endsWith("/orders"));
    creates++;
    const body=JSON.parse(String(init?.body));
    assert.ok(body.payment_source.paypal.experience_context.return_url.includes("table="+dinnerA));
    assert.equal(body.purchase_units[0].amount.value,"15.00");
    return new Response(JSON.stringify({id:"ORDER123456",links:[{rel:"approve",href:"https://www.sandbox.paypal.com/checkoutnow?token=ORDER123456"}]}));
  };
  try{
    const svc=new TabloomService(join(dir,"table.json"),fetcher as typeof fetch);
    const first=await svc.createTable(dinnerA,{title:"Paid dinner",guests:["Ada","Ben"]});
    const a=await svc.table(dinnerA);
    await a.updateDraft(fill(first.bill,"Paid dinner",3000),0);
    await a.createOrder("guest-1",1);
    const before=(await a.state()).bill;
    await svc.createTable(dinnerB,{title:"Next dinner",guests:["Ada","Ben"]});
    assert.deepEqual((await a.state()).bill,before);
    assert.deepEqual((await (await svc.table(dinnerB)).state()).bill.payments,{});
    await assert.rejects(()=>a.updateDraft(fill(before,"Changed paid dinner",4000),1),/locked/);
    assert.equal(creates,1);
    const summary=(await svc.tableList()).tables.find(t=>t.id===dinnerA)!;
    assert.equal(summary.unresolvedPayments,1);assert.equal(summary.capturedCents,0);
    assert.equal((await svc.state()).bill.payments["guest-1"],undefined);
  }finally{keys.forEach((key,i)=>{if(old[i]===undefined)delete process.env[key];else process.env[key]=old[i];});await rm(dir,{recursive:true,force:true});}
});
