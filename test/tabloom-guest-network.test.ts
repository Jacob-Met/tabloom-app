import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {connect} from "node:net";
import {once} from "node:events";
import {randomUUID} from "node:crypto";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {TabloomService} from "../src/tabloom-service.js";
import {TabloomGuestNetwork,privateGuestAddresses} from "../src/tabloom-guest-network.js";

async function promptly<T>(promise:Promise<T>,message:string):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),1000);})]);}
 finally{clearTimeout(timer);}
}

test("network setup rejects unassigned and public addresses without enabling sharing",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"tabloom-network-denied-"));
 const service=new TabloomService(join(dir,"bill.json"));
 const network=new TabloomGuestNetwork(service,{preferredPort:0});
 try{
  const before=(await service.state()).bill;
  assert.equal(network.status().enabled,false);
  for(const address of ["8.8.8.8","0.0.0.0","example.com","http://192.168.1.2",null,{}, "192.0.2.1"]){
   await assert.rejects(()=>network.start(address));
   assert.equal(network.status().enabled,false);
  }
  assert.deepEqual((await service.state()).bill,before);
  assert.equal((await service.state()).guestLinksReady,false);
 }finally{await network.stop();await rm(dir,{recursive:true,force:true});}
});

test("sharing starts on a real assigned interface, preserves cached dinners and revokes old invitations when stopped",async t=>{
 const dir=await mkdtemp(join(tmpdir(),"tabloom-network-life-"));
 let providerCalls=0;
 const service=new TabloomService(join(dir,"bill.json"),async()=>{providerCalls++;throw Error("No provider call expected");});
 const network=new TabloomGuestNetwork(service,{preferredPort:0});
 try{
  const address=network.status().addresses[0]?.address;
  if(!address){t.skip("No assigned private IPv4 interface available for real listener");return;}
  const before=(await service.state()).bill;
  const tableId="table-"+randomUUID().replaceAll("-","");await service.createTable(tableId,{title:"Other dinner",guests:["Asha","Ben"]});
  const other=await service.table(tableId),otherBefore=(await other.state()).bill;
  const started=await network.start(address);assert.equal(started.enabled,true);assert.ok(started.origin);
  assert.equal((await service.state()).guestLinksReady,true);assert.equal((await other.state()).guestLinksReady,true);
  const links=service.links;assert.ok(links);assert.equal(other.links,links);
  const invite=await links.create(service,"mira");
  assert.equal((await fetch(invite.checkoutUrl)).status,200);
  for(const route of ["/mcp","/healthz","/tabloom/","/tabloom/api/state","/tabloom/api/guest-network","/tabloom/api/paypal/check"]){
   assert.equal((await fetch(started.origin+route)).status,404,route);
  }
  const repeated=await network.start(address);assert.equal(repeated.origin,started.origin);assert.equal(service.links,links);
  assert.equal((await fetch(invite.checkoutUrl)).status,200);
  const unused=connect({host:address,port:Number(new URL(started.origin!).port)});
  await once(unused,"connect");
  try{await promptly(network.stop(),"Stop waited for an unused browser connection");}
  finally{unused.destroy();}
  assert.equal(network.status().enabled,false);
  assert.equal((await service.state()).guestLinksReady,false);assert.equal((await other.state()).guestLinksReady,false);
  await assert.rejects(()=>fetch(invite.checkoutUrl,{signal:AbortSignal.timeout(1000)}));
  await network.stop();
  const restarted=await network.start(address);assert.ok(restarted.origin);
  const expired=await fetch(restarted.origin+new URL(invite.checkoutUrl).pathname);
  assert.equal(expired.status,410);assert.match(expired.headers.get("content-type")??"",/text\/html/);
  assert.deepEqual((await service.state()).bill,before);assert.deepEqual((await other.state()).bill,otherBefore);
  assert.equal(providerCalls,0);
 }finally{await network.stop();await rm(dir,{recursive:true,force:true});}
});

test("Stop retires unused connections while an already received guest request completes",async t=>{
 const dir=await mkdtemp(join(tmpdir(),"tabloom-network-drain-"));
 let providerCalls=0;
 const service=new TabloomService(join(dir,"bill.json"),async()=>{providerCalls++;throw Error("No provider call expected");});
 const originalState=service.state.bind(service);
 const network=new TabloomGuestNetwork(service,{preferredPort:0});
 let release!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const requestEntered=new Promise<void>(resolve=>{entered=resolve;});
 let unused:ReturnType<typeof connect>|undefined,response:Promise<Response>|undefined,stopping:Promise<unknown>|undefined;
 try{
  const address=network.status().addresses[0]?.address;
  if(!address){t.skip("No assigned private IPv4 interface available for real listener");return;}
  const before=(await originalState()).bill;
  const started=await network.start(address);
  const invite=await service.links!.create(service,"mira");
  unused=connect({host:address,port:Number(new URL(started.origin!).port)});
  await once(unused,"connect");
  const unusedClosed=once(unused,"close");
  service.state=async()=>{entered();await gate;return originalState();};
  response=fetch(invite.url+"/review-state");
  await promptly(requestEntered,"Guest request never reached its existing handler");
  let stopped=false;
  stopping=network.stop().then(value=>{stopped=true;return value;});
  await promptly(unusedClosed,"Stop left an unused connection open");
  assert.equal(stopped,false,"Stop must wait for the received request to finish");
  release();
  const completed=await promptly(response,"Stop interrupted the received request");
  assert.equal(completed.status,410);
  assert.match(await completed.text(),/stopped/);
  await promptly(stopping,"Stop did not finish after the response drained");
  assert.equal(network.status().enabled,false);
  assert.deepEqual((await originalState()).bill,before);
  assert.equal(providerCalls,0);
 }finally{
  release();unused?.destroy();service.state=originalState;
  await response?.then(reply=>reply.text()).catch(()=>{});
  await stopping?.catch(()=>{});
  await network.stop();await rm(dir,{recursive:true,force:true});
 }
});

test("an occupied preferred guest port falls back without disturbing the existing server",async t=>{
 const dir=await mkdtemp(join(tmpdir(),"tabloom-network-port-"));
 const service=new TabloomService(join(dir,"bill.json"));
 const discover=new TabloomGuestNetwork(service,{preferredPort:0});
 const address=discover.status().addresses[0]?.address;
 if(!address){await rm(dir,{recursive:true,force:true});t.skip("No assigned private IPv4 interface available");return;}
 const occupied=createServer((_req,res)=>res.end("existing listener"));
 await new Promise<void>((resolve,reject)=>{occupied.once("error",reject);occupied.listen(0,address,resolve);});
 const port=(occupied.address() as {port:number}).port;
 const network=new TabloomGuestNetwork(service,{preferredPort:port});
 try{
  const result=await network.start(address);assert.equal(result.enabled,true);assert.ok(result.origin);
  assert.notEqual(Number(new URL(result.origin).port),port);
  assert.equal(await(await fetch("http://"+address+":"+port)).text(),"existing listener");
 }finally{await network.stop();await new Promise<void>(resolve=>occupied.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});

test("a private LAN is offered before shared-address VPN adapters without hiding either",()=>{
 const row=(address:string)=>({address,family:"IPv4" as const,internal:false,netmask:"255.255.255.0",mac:"00:00:00:00:00:01",cidr:address+"/24"});
 const interfaces=()=>({CloudflareWARP:[row("100.96.10.158")],en0:[row("192.168.1.20")],tailscale0:[row("100.67.71.149")]});
 assert.deepEqual(privateGuestAddresses(interfaces).map(item=>item.address),["192.168.1.20","100.96.10.158","100.67.71.149"]);
});
