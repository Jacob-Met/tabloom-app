import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {TabloomService} from "../src/tabloom-service.js";
import {fixtureBill} from "../src/tabloom.js";

// Local provider doubles exercise accounting decisions, never a PayPal transaction.
test("capture completion belongs to the saved order and diner, then survives restart",async t=>{
 const dir=await mkdtemp(join(tmpdir(),"capture-identity-"));
 const keys=["TABLOOM_PAYPAL_CLIENT_ID","TABLOOM_PAYPAL_CLIENT_SECRET"];
 const old=keys.map(k=>process.env[k]);keys.forEach(k=>process.env[k]="synthetic");
 const complete=()=>({id:"ORIGINALORDER",status:"COMPLETED",purchase_units:[{reference_id:"mira",amount:{currency_code:"USD",value:"24.37"},payments:{captures:[{id:"COMPLETEDCAPTURE",status:"COMPLETED",amount:{currency_code:"USD",value:"24.37"}}]}}]});
 const cases=[
  {name:"matching completed representation",http:201,change:(r:any)=>{},paid:true},
  {name:"matching replay representation",http:200,change:(r:any)=>{},paid:true},
  {name:"absent order identity",http:201,change:(r:any)=>{delete r.id},paid:false},
  {name:"different order identity",http:201,change:(r:any)=>{r.id="DIFFERENTORDER"},paid:false},
  {name:"absent diner reference",http:201,change:(r:any)=>{delete r.purchase_units[0].reference_id},paid:false},
  {name:"different diner reference",http:201,change:(r:any)=>{r.purchase_units[0].reference_id="joss"},paid:false},
  {name:"pending capture",http:201,change:(r:any)=>{r.purchase_units[0].payments.captures[0].status="PENDING"},paid:false},
  {name:"accepted processing",http:202,change:(r:any)=>{},paid:false},
  {name:"mixed outcomes",http:207,change:(r:any)=>{},paid:false}
 ];
 try{for(const [index,c] of cases.entries())await t.test(c.name,async()=>{
  const path=join(dir,index+".json"),bill=fixtureBill();
  bill.payments.mira={status:"awaiting_approval",amountCents:2437,requestId:"original-create",orderId:"ORIGINALORDER"};
  await writeFile(path,JSON.stringify(bill));let posts=0;
  const provider:typeof fetch=async(input,init)=>{
   if(String(input).endsWith("/token"))return Response.json({access_token:"synthetic"});
   if(init?.method==="GET")return Response.json({...complete(),status:"APPROVED"});
   posts++;assert.equal((init?.headers as Record<string,string>)["Prefer"],"return=representation");
   const response=complete();c.change(response);return Response.json(response,{status:c.http});
  };
  const service=new TabloomService(path,provider),result=await service.capture("mira");
  assert.equal(result.payment.status,c.paid?"captured":"pending");
  assert.equal(result.payment.orderId,"ORIGINALORDER");assert.equal(result.payment.requestId,"original-create");
  assert.ok(result.payment.captureRequestId);assert.equal(posts,1);
  const restored=new TabloomService(path,provider),state=await restored.state();
  assert.equal(state.calculated.dues.find(d=>d.guestId==="mira")?.paidCents,c.paid?2437:0);
  if(c.paid)await restored.capture("mira");else await assert.rejects(()=>restored.capture("mira"),/Reconcile/);
  assert.equal(posts,1);
  if(!c.paid){
   const reconciled=await restored.reconcile("mira");
   assert.equal(reconciled.payment.status,"captured");
   assert.equal(reconciled.payment.captureRequestId,result.payment.captureRequestId);
   assert.equal((await restored.state()).calculated.dues.find(d=>d.guestId==="mira")?.paidCents,2437);
   assert.equal(posts,1);
  }
 });}finally{keys.forEach((k,i)=>{if(old[i]===undefined)delete process.env[k];else process.env[k]=old[i]});await rm(dir,{recursive:true,force:true});}
});
