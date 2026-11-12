import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureBill, calculateBill } from "../dist/src/tabloom.js";
import { renderGuestReceipt } from "../tabloom/guest-receipt.js";

test("guest copy itemizes server exact-cent shares and reconciles with saved total", () => {
  const bill = fixtureBill();
  const due = calculateBill(bill).dues.find(d=>d.guestId==="mira");
  assert.equal(due.totalCents,2437);
  assert.deepEqual(due.lineItems.map(i=>i.shareCents),[1650,250]);
  assert.equal(due.lineItems.reduce((sum,i)=>sum+i.shareCents,0),due.itemsCents);
  const html=renderGuestReceipt(bill,due,undefined,new Date("2026-11-10T16:00:00Z"));
  for(const text of ["$24.37","$16.50","$2.50","Miso udon","Sparkling water","Shared 3 ways","REV 0","personal payment invitation"]) assert.ok(html.includes(text),text);
  assert.ok(!html.includes("Mira had udon"),"private discussion note is excluded");
  assert.ok(!html.includes("Joss"),"other guest names are excluded");
  assert.ok(!html.includes("<script"),"offline receipt has no running JavaScript");
});

test("receipt safely escapes adversarial labels and does not expose non-Sandbox links", () => {
  const bill=fixtureBill();bill.title='<img src=x onerror=alert(1)>';
  bill.guests[0].name='<script>alert("steal")</script>';
  bill.items[0].name='Soup & <bad>';
  const due=calculateBill(bill).dues[0];
  const html=renderGuestReceipt(bill,due,{status:"awaiting_approval",approvalUrl:"https://evil.example/login"});
  assert.ok(html.includes("&lt;img"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("Soup &amp; &lt;bad&gt;"));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes("https://evil.example"));
});

test("only a trusted awaiting-approval Sandbox order emits a buyer link; unknown capture cannot", () => {
  const bill=fixtureBill(), due=calculateBill(bill).dues[0];
  const link="https://www.sandbox.paypal.com/checkoutnow?token=FAKEORDER123";
  const awaiting=renderGuestReceipt(bill,due,{status:"awaiting_approval",approvalUrl:link});
  assert.ok(awaiting.includes('href="'+link+'"'));
  assert.match(awaiting,/approval alone is not payment/i);
  for(const status of ["capture_unknown","pending","captured"]) {
    const html=renderGuestReceipt(bill,due,{status,approvalUrl:link});
    assert.ok(!html.includes('href="'+link+'"'),status);
  }
  assert.throws(()=>renderGuestReceipt(bill,{...due,totalCents:due.totalCents+1}),/does not reconcile/);
  assert.throws(()=>renderGuestReceipt(bill,{...due,lineItems:[]}),/does not reconcile/);
});


test("offline handoff names distinguish dinners and diners while remaining portable",async()=>{
 const {guestFileName}=await import("../tabloom/guest-identity.js");
 const packet={title:"Gallery supper",guestName:"Nora",guestId:"guest-1",revision:1};
 assert.equal(guestFileName(packet,"review","html"),"tabloom-review-gallery-supper-nora-guest-1-rev1.html");
 assert.notEqual(guestFileName(packet,"response","json"),guestFileName({...packet,title:"Garden supper"},"response","json"));
 assert.notEqual(guestFileName(packet,"response","json"),guestFileName({...packet,guestId:"guest-2"},"response","json"));
 const name=guestFileName({...packet,title:"../晚餐 / Café: supper? "+"x".repeat(180),guestName:"Élodie / 李"},"choices","txt");
 assert.match(name,/晚餐/);assert.match(name,/élodie-李/);assert.doesNotMatch(name,/[\\/:?<>|]/);assert.ok(name.length<130);
 assert.ok(Buffer.byteLength(guestFileName({...packet,title:"晚餐".repeat(80),guestName:"来宾".repeat(80)},"response","json"))<255);
});


test("zero-share copy states no payment due while unresolved requests retain their status",()=>{
 const bill=fixtureBill();bill.guests.push({id:"zero",name:"Elias"});
 const due=calculateBill(bill).dues.find(d=>d.guestId==="zero");
 assert.equal(due.totalCents,0);
 const html=renderGuestReceipt(bill,due);
 assert.match(html,/NO PAYMENT DUE/);assert.match(html,/Nothing to pay for this saved share/);
 assert.doesNotMatch(html,/personal payment invitation|<a /);
 const unresolved=renderGuestReceipt(bill,due,{status:"capture_unknown"});
 assert.match(unresolved,/prior Sandbox capture is unresolved/);assert.doesNotMatch(unresolved,/NO PAYMENT DUE|Nothing to pay/);
});
