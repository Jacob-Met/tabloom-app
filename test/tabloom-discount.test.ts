import test from "node:test";
import assert from "node:assert/strict";
import {fixtureBill,validateDraft,calculateBill} from "../src/tabloom.js";
test("receipt-wide coupon preserves original lines and discounts each guest proportionally",()=>{
 const bill=validateDraft({...fixtureBill(),discountCents:500},1,{});
 const result=calculateBill(bill);
 assert.equal(result.subtotalCents,3800);assert.equal(result.totalCents,4375);
 assert.deepEqual(result.dues.map(d=>d.discountCents),[250,125,125]);
 assert.deepEqual(result.dues.map(d=>d.totalCents),[2187,1094,1094]);
 assert.equal(bill.items[0].cents,1650);
 assert.deepEqual(calculateBill(validateDraft(JSON.parse(JSON.stringify(bill)),1,{})),result);
});
test("odd-cent coupon reconciles exactly and never exceeds a guest's items",()=>{
 const bill=fixtureBill();bill.guests=bill.guests.slice(0,2);bill.items=[{id:"tea",name:"Two teas",cents:1001,sharedBy:["mira","joss"]}];bill.taxCents=0;bill.tipCents=0;
 const result=calculateBill(validateDraft({...bill,discountCents:101},1,{}));
 assert.equal(result.totalCents,900);
 assert.equal(result.dues.reduce((sum,d)=>sum+(d.discountCents||0),0),101);
 assert.deepEqual(result.dues.map(d=>d.totalCents),[450,450]);
});
test("discount bounds and full-coupon receipt retain reviewed tax and tip",()=>{
 for(const discountCents of [-1,1.5,3801])assert.throws(()=>validateDraft({...fixtureBill(),discountCents},1,{}),/discount/i);
 const result=calculateBill(validateDraft({...fixtureBill(),discountCents:3800},1,{}));
 assert.equal(result.totalCents,1075);
 assert.deepEqual(result.dues.map(d=>d.totalCents),[537,269,269]);
 const original=fixtureBill();assert.deepEqual(validateDraft(original,0,{}),original);
});

// Simulated transport: verify the actual service constructs the discounted order.
test("saved coupon binds the Sandbox order to the discounted guest amount",async()=>{
 const {mkdtemp,rm}=await import("node:fs/promises");const {tmpdir}=await import("node:os");const {join}=await import("node:path");
 const {TabloomService}=await import("../src/tabloom-service.js");
 const dir=await mkdtemp(join(tmpdir(),"tabloom-discount-order-"));
 const keys=["TABLOOM_PAYPAL_CLIENT_ID","TABLOOM_PAYPAL_CLIENT_SECRET"];
 const before=keys.map(k=>process.env[k]);keys.forEach(k=>process.env[k]="synthetic-discount-test");
 let creates=0;
 try{
  const responder:typeof fetch=async(input,init)=>{
   if(String(input).endsWith("/v1/oauth2/token"))return new Response(JSON.stringify({access_token:"synthetic-token"}));
   assert.equal(String(input),"https://api-m.sandbox.paypal.com/v2/checkout/orders");
   const body=JSON.parse(String(init?.body));assert.equal(body.purchase_units[0].amount.value,"21.87");assert.equal(body.purchase_units[0].amount.currency_code,"USD");creates++;
   return new Response(JSON.stringify({id:"2DISCOUNT12345",links:[{rel:"approve",href:"https://www.sandbox.paypal.com/checkoutnow?token=2DISCOUNT12345"}]}));
  };
  const path=join(dir,"table.json"),svc=new TabloomService(path,responder);
  await svc.updateDraft({...fixtureBill(),discountCents:500},0);
  const order=await svc.createOrder("mira",1);assert.equal(order.payment.amountCents,2187);assert.equal(creates,1);
  assert.equal((await new TabloomService(path).state()).bill.discountCents,500);
  await assert.rejects(()=>svc.updateDraft({...fixtureBill(),discountCents:600},1),/locked/);
 }finally{keys.forEach((k,i)=>{if(before[i]===undefined)delete process.env[k];else process.env[k]=before[i];});await rm(dir,{recursive:true,force:true});}
});
