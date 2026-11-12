import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {promises as fs} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {TabloomService,handleTabloom} from "../src/tabloom-service.js";
import {receiptVisionReader} from "../src/tabloom-receipt-vision.js";
test("actual HTTP reader boundaries leave saved dinner and ordinary body limit unchanged",async()=>{
 const directory=await fs.mkdtemp(join(tmpdir(),"tabloom-vision-http-"));
 const previous={dir:process.env.TABLOOM_RECEIPT_REFERENCE_DIR,assets:process.env.TABLOOM_RECEIPT_REFERENCE_ASSETS};
 delete process.env.TABLOOM_RECEIPT_REFERENCE_DIR;delete process.env.TABLOOM_RECEIPT_REFERENCE_ASSETS;
 const service=new TabloomService(join(directory,"dinner.json"));
 const server=createServer((req,res)=>{void handleTabloom(req,res,service).then(handled=>{if(!handled){res.writeHead(404);res.end();}});});
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const address=server.address();assert(address&&typeof address!=="string");
 const origin="http://127.0.0.1:"+address.port;
 const photo="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
 const post=(path:string,body:unknown,from=origin)=>fetch(origin+path,{method:"POST",headers:{"content-type":"application/json",origin:from},body:JSON.stringify(body)});
 try{
  const before=await service.state();
  const status=await fetch(origin+"/tabloom/api/receipt-reader");assert.equal(status.status,200);
  const capability=await status.json() as {available:boolean;defaultReader:string};assert.equal(capability.available,false);assert.equal(capability.defaultReader,"browser");
  const disabled=await post("/tabloom/api/receipt-reader",{image:photo,padding:"x".repeat(150*1024)});
  assert.equal(disabled.status,503);assert.match((await disabled.json() as {error:string}).error,/not configured/);
  assert.equal((await post("/tabloom/api/receipt-reader",{image:"https://example.invalid/photo.png"})).status,400);
  assert.equal((await post("/tabloom/api/receipt-reader",{image:photo},"http://other.invalid")).status,403);
  assert.equal((await post("/tabloom/api/bill",{padding:"x".repeat(150*1024)})).status,413);
  // Actual HTTP disconnect -> route AbortSignal. Child cleanup is separately
  // received by the controlled process test and the real maintained CLI course.
  const originalRead=receiptVisionReader.read;
  let began!:()=>void,observed!:()=>void;
  const started=new Promise<void>(resolve=>{began=resolve;}),aborted=new Promise<void>(resolve=>{observed=resolve;});
  receiptVisionReader.read=async(_image,signal)=>new Promise<never>((_resolve,reject)=>{
    assert(signal);
    signal.addEventListener("abort",()=>{observed();reject(new DOMException("Stopped","AbortError"));},{once:true});
    began();
  });
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    const controller=new AbortController();
    const request=fetch(origin+"/tabloom/api/receipt-reader",{method:"POST",headers:{"content-type":"application/json",origin},body:JSON.stringify({image:photo}),signal:controller.signal});
    const stopped=assert.rejects(request,e=>e instanceof DOMException&&e.name==="AbortError");
    const deadline=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error("HTTP cancellation was not propagated")),2000);});
    await Promise.race([started,deadline]);controller.abort();
    await stopped;await Promise.race([aborted,deadline]);
  }finally{if(timer)clearTimeout(timer);receiptVisionReader.read=originalRead;}
  assert.deepEqual(await service.state(),before);
 }finally{
  server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  if(previous.dir===undefined)delete process.env.TABLOOM_RECEIPT_REFERENCE_DIR;else process.env.TABLOOM_RECEIPT_REFERENCE_DIR=previous.dir;
  if(previous.assets===undefined)delete process.env.TABLOOM_RECEIPT_REFERENCE_ASSETS;else process.env.TABLOOM_RECEIPT_REFERENCE_ASSETS=previous.assets;
  await fs.rm(directory,{recursive:true,force:true});
 }
});
