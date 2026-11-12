import test from "node:test";
import assert from "node:assert/strict";
import { receiptDraftContext, validateReceiptDraft, createReceiptDraftStore } from "../tabloom/receipt-draft-store.js";
const snapshot=()=>({version:1,sourceText:"Tea 2.00",text:"Tea 2.",parsed:true,manual:false,model:true,visible:true,rows:[{name:"Tea",price:"2."}],amounts:{discount:"0.00",tax:"",tip:"0",printed:"2.00","printed-subtotal":""},excluded:["Card ending 1234"],remainingText:"Card ending 1234",inline:[{index:0,value:"Tea $2.",open:true}],rotation:90,mode:"replace",sourceOpen:false,optionsOpen:true});
test("receipt correction retains raw blank zero and incomplete fields",()=>{const value=snapshot();assert.equal(validateReceiptDraft(value),value);assert.equal(value.rows[0].price,"2.");assert.equal(value.amounts.tax,"");assert.equal(value.amounts.tip,"0");});
test("receipt recovery context is explicit and bounded",()=>{assert.deepEqual(receiptDraftContext({table:"table-a",base:"revision1"}),{table:"table-a",base:"revision1"});for(const value of [null,{}, {table:"",base:"x"},{table:"a",base:null}])assert.throws(()=>receiptDraftContext(value));});
test("unrecognized or malformed recovery cannot become an importable receipt",()=>{for(const mutation of [{version:2},{rotation:45},{rows:[{name:"Tea",price:2}]},{inline:[{index:-1,value:"x"}]},{amounts:{tax:"0"}},{visible:"yes"}])assert.throws(()=>validateReceiptDraft({...snapshot(),...mutation}));});
test("recovery bounds source and row count before rendering",()=>{assert.throws(()=>validateReceiptDraft({...snapshot(),text:"x".repeat(20001)}));assert.throws(()=>validateReceiptDraft({...snapshot(),rows:Array.from({length:61},()=>({name:"x",price:"1"}))}));});
test("unavailable durable storage is reported rather than claiming saved",async()=>{await assert.rejects(createReceiptDraftStore(null).read({table:"a",base:"b"}),/unavailable/);});

test("older correction snapshots keep compatible reading options",()=>{const value=snapshot();assert.equal(validateReceiptDraft(value),value);value.optionsSummary=true;assert.equal(validateReceiptDraft(value),value);value.optionsSummary="hidden";assert.throws(()=>validateReceiptDraft(value));});
