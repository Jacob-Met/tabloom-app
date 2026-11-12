import test from "node:test";
import assert from "node:assert/strict";
import {parseReceiptText} from "../tabloom/receipt-intake.js";
test("receipt text retains final quantity lines, coupon and printed total",()=>{
 const p=parseReceiptText("GARDEN TABLE\n2 Flat whites 9.50\nRoast squash toast 13.75\nSubtotal 23.25\nCoupon -2.00\nTax 1.86\nTip 4.00\nTotal 27.11\nVisa 27.11");
 assert.equal(p.ready,true);assert.equal(p.items.length,2);assert.equal(p.items[0].cents,950);
 assert.equal(p.reconciliation.totalCents,2711);assert.equal(p.discountCents,200);
});
test("one OCR digit error is an exact visible discrepancy",()=>{
 const p=parseReceiptText("Soup 8.50\nBread 4.00\nTotal 17.50");
 assert.equal(p.ready,false);assert.equal(p.reconciliation.comparisons[0].differenceCents,-500);
});
test("unit-price ambiguity, duplicate totals and incomplete amounts cannot apply",()=>{
 for(const s of ["2 Coffee 3.50 7.00","Soup 8.50\nTotal 8.50\nTotal 9.50","Soup 8.50\nTea 3.5"])assert.equal(parseReceiptText(s).ready,false,s);
});
test("missing printed total stays unknown, not a successful reconciliation",()=>{
 const p=parseReceiptText("Soup 8.50\nBread 4.00");assert.equal(p.ready,true);assert.equal(p.reconciliation.status,"unverified");
});
test("foreign currency and negative item lines stay for review",()=>{
 for(const s of ["Soup €8.50","Soup 8.50\nCredit -2.00","Soup 8.50\nCAD"])assert.equal(parseReceiptText(s).ready,false,s);
});
test("receipts retain names and quantity text without multiplying a line total again",()=>{
 const p=parseReceiptText("CAFÉ\n3 x Café au lait $12.60\nCrème brûlée 7.40\nTOTAL $20.00");
 assert.equal(p.ready,true);assert.equal(p.items[0].name,"3 x Café au lait");assert.equal(p.items[0].cents,1260);
});

test("explicit foreign codes block USD import even when all amounts match",()=>{
 for(const code of ["EUR","GBP","CAD","AUD","MYR","IDR","RM","SGD","NZD","INR"]){
  const p=parseReceiptText(code+"\nCoffee 4.95\nTotal 4.95");
  assert.equal(p.ready,false,code);assert.ok(p.issues.some(i=>i.message.includes("USD")));
 }
 assert.equal(parseReceiptText("Coffee RM4.95\nTotal RM4.95").ready,false);
 assert.equal(parseReceiptText("USD\nCoffee $4.95\nTotal $4.95").ready,true);
});
test("explicit quantity unit-price columns are checked before using printed line totals",()=>{
 const p=parseReceiptText("2 x Coffee @ 3.50 7.00\nTotal 7.00");
 assert.equal(p.ready,true);assert.equal(p.items[0].cents,700);
 assert.equal(parseReceiptText("2 x Coffee @ 3.50 3.50").ready,false);
});
test("percentage tax and tip remain charges, unusual labels need correction",()=>{
 const p=parseReceiptText("Udon 12.00\nTax 10% 1.20\nTip 20% 2.40\nTotal 15.60");
 assert.equal(p.ready,true);assert.equal(p.items.length,1);assert.equal(p.tipCents,240);
 assert.equal(parseReceiptText("Udon 12.00\nTax state 1.20").ready,false);
});
test("discount must not exceed items even when tax masks negative net items",()=>{
 const p=parseReceiptText("Soup 5.00\nDiscount -6.00\nTax 2.00\nTotal 1.00");
 assert.equal(p.ready,false);assert.equal(p.reconciliation.status,"invalid");
});
test("printed subtotal can explicitly reconcile before or after the receipt discount",()=>{
 for(const subtotal of ["12.00","10.00"]){
  const p=parseReceiptText("Lunch 12.00\nDiscount -2.00\nSubtotal "+subtotal+"\nTax 1.00\nTotal 11.00");
  assert.equal(p.ready,true);assert.equal(p.reconciliation.totalCents,1100);
  assert.equal(p.reconciliation.subtotalBasis,subtotal==="12.00"?"before_discount":"after_discount");
 }
});
test("observed Starbucks OCR errors do not import tender or a misspelled subtotal as items",()=>{
 const p=parseReceiptText("YT Pep Mocha 4.65\nShux Card 4.95\nSublotal $4.95\nTotal $4.95\nSUX Card 3228 New Balance: 37.4%");
 assert.equal(p.ready,false);assert.deepEqual(p.items.map(i=>i.cents),[465]);
 assert.ok(p.issues.some(i=>i.message.includes("card tender")));
 assert.ok(p.issues.some(i=>i.message.includes("summary label")));
 assert.equal(p.reconciliation.comparisons.find(c=>c.kind==="total").differenceCents,-30);
});

test("quantity ambiguity remains structural rather than an editable sum mismatch",()=>{
 for(const text of ["2 x Coffee 3.50\nTotal 7.00","2 x Coffee 3.50"]){
  const p=parseReceiptText(text);
  assert.equal(p.ready,false);assert.ok(p.issues.some(i=>!i.kind&&i.message.includes("unit price")));
 }
 assert.equal(parseReceiptText("2 x Coffee total 7.00\nTotal 7.00").ready,true);
});

const capturedStarbucksOcr="STARBUCKS Store #10208\n11302 Euclid Avenue\nCleveland, OH (216) 229-0749\n\nCHK 664250\n12/07/2014 06:43 PM\n1912003 Drawer: 2. Reg: 2\n\nYT Pep Mocha             4.65\n\nShux Card               4.95\n\nKXKXKRXRXRAX: 3228\n\nSublotal               $4.95\n\nTotal                  $4.95\nChange Due        H.C\n\n- Check Closed -\n07/2004 06:43 wo\n\nSUX Card 3228 New Balance: 37.4%\nCard is registers\n";

test("captured photo text offers explicit label actions while retaining the thirty-cent discrepancy",()=>{
 const first=parseReceiptText(capturedStarbucksOcr);
 assert.equal(first.ready,false);assert.deepEqual(first.items.map(item=>item.cents),[465]);
 const suggestions=first.issues.filter(issue=>issue.suggestion);
 assert.equal(suggestions.length,2);
 assert.deepEqual(suggestions.map(issue=>issue.suggestion.action),["exclude","replace"]);
 const lines=capturedStarbucksOcr.split(/\r?\n/);
 for(const issue of suggestions){
  assert.equal(lines[issue.line-1].trim(),issue.text);
  if(issue.suggestion.action==="replace"){
   assert.equal(issue.text.replace(/^Sublotal/,"Subtotal"),issue.suggestion.text);
   assert.equal(issue.suggestion.text.match(/\$?\d+\.\d{2}$/)[0],issue.text.match(/\$?\d+\.\d{2}$/)[0]);
   lines[issue.line-1]=issue.suggestion.text;
  }else lines[issue.line-1]="";
 }
 const reviewed=parseReceiptText(lines.join("\n"));
 assert.equal(reviewed.ready,false);assert.deepEqual(reviewed.items.map(item=>item.cents),[465]);
 assert.equal(reviewed.printedSubtotalCents,495);assert.equal(reviewed.printedTotalCents,495);
 assert.ok(reviewed.issues.every(issue=>["subtotal","total"].includes(issue.kind)));
 assert.ok(reviewed.reconciliation.comparisons.every(c=>c.differenceCents===-30));
 assert.equal(capturedStarbucksOcr.includes("Sublotal"),true,"parser never changes original source");
});
test("currency and ambiguous quantity issues never offer automatic-looking source suggestions",()=>{
 for(const text of ["EUR\nCoffee 4.95\nTotal 4.95","2 x Coffee 3.50\nTotal 7.00"]){
  const p=parseReceiptText(text);
  assert.equal(p.ready,false);assert.equal(p.issues.some(issue=>issue.suggestion),false);
 }
});
test("photographed Dona Mercedes suggested tips are not purchased items",()=>{
 const p=parseReceiptText("Dona Mercedes Restaurant\n1 CHicharon $2.25\n3 Pupusa Queso $6.75\n1 Platanos Orden $7.75\n1 Diet coke $1.50\n2 Quesadilla salvadorena $4.00\nSUBTOTAL: $22.25\nTAX: $2.22\nTOTAL: $24.47\nTIP SUGGESTIONS\n18%: $4.40\n20%: $4.89\n25%: $6.12\nThank You!");
 assert.equal(p.ready,true);assert.equal(p.items.length,5);assert.equal(p.tipCents,0);assert.equal(p.reconciliation.totalCents,2447);
});
test("suggestion block ends before a charged tip",()=>{
 const p=parseReceiptText("Soup 10.00\nTIP SUGGESTIONS\n20% $2.00\nTip 3.00\nTotal 13.00");
 assert.equal(p.ready,true);assert.equal(p.tipCents,300);assert.equal(p.items.length,1);
});

test("explicit-dollar OCR fragments cannot silently disappear from a partial receipt",()=>{
 const result=parseReceiptText("Sushi Deluxe 20.75\nNoodle $2\nGlenmont Roll $1588");
 assert.equal(result.ready,false);
 assert.equal(result.items.length,1);
 assert.deepEqual(result.issues.map(issue=>issue.line),[2,3]);
 assert(result.issues.every(issue=>issue.message.includes("two decimal places")));
 assert.equal(result.ignored.length,0);
 const corrected=parseReceiptText("Sushi Deluxe 20.75\nNoodle $2.00\nGlenmont Roll $15.95\nTotal $38.70");
 assert.equal(corrected.ready,true);
 assert.equal(corrected.reconciliation.totalCents,3870);
});
test("explicit dollar tender and metadata lines stay outside the charged items",()=>{
 const result=parseReceiptText("Soup 8.00\nCash $10\nChange $2\nMerchant $DINER\nTotal 8.00");
 assert.equal(result.ready,true);
 assert.equal(result.items.length,1);
 assert.equal(result.ignored.length,3);
});

const capturedKatanaOcr="\u2014\u2014\u2014\u2014\n\nKatana Sushi\n2818 Hewitt Ave\nEverett, WA 98201\n425-512-9361\nHAHAH HK\n\nServer: Michael C\n05/11/18 8:47 PH\n\nCheck #93             Table D2\nHamachi Collar          \u00a312.00\nMega Poke Boul          $17.00\nHamachi - Sashimi       \u00a312.00\nMaguro - Sashimi        $11.00\nSalmon - Sashimi        $10.00\n3 Sockeye Salmon - Sashimi\n$36.00\nHamachi Japapeno        $12.00\nSalmon Collar           $10.00\nEscolar - Sashimi       $11.00\nSubtotal               $131.00\nTax                     \u00a39 2u7\nTotal                      $143.71\n\nKK KKK KK      157, 4\n\nThank You for vour visit.\n";

test("captured Katana wrapped price offers only an explicit context-bound item-label repair",()=>{
 const original=parseReceiptText(capturedKatanaOcr);
 const issue=original.issues.find(i=>i.suggestion?.context);
 assert.ok(issue);assert.equal(issue.text,"$36.00");
 assert.equal(issue.suggestion.context.text,"3 Sockeye Salmon - Sashimi");
 assert.equal(issue.suggestion.text,"3 Sockeye Salmon - Sashimi $36.00");
 const lines=capturedKatanaOcr.split(/\r?\n/);
 assert.equal(lines[issue.line-1].trim(),issue.text);
 assert.equal(lines[issue.suggestion.context.line-1].trim(),issue.suggestion.context.text);
 assert.equal(issue.suggestion.context.line,issue.line-1);
 assert.equal(issue.suggestion.context.consume,true);
 assert.ok(!original.items.some(item=>item.cents===3600),"no automatic joining");
 lines[issue.line-1]=issue.suggestion.text;
 lines.splice(issue.suggestion.context.line-1,1);
 const reviewed=parseReceiptText(lines.join("\n"));
 assert.equal(reviewed.ignored.includes("3 Sockeye Salmon - Sashimi"),false,"joined label is used, not left as an excluded line");
 assert.equal(reviewed.items.find(item=>item.name==="3 Sockeye Salmon - Sashimi").cents,3600);
 assert.equal(reviewed.items.filter(item=>item.name.includes("Sockeye")).length,1);
 assert.equal(reviewed.ready,false);
 assert.equal(reviewed.taxCents,0,"unreadable tax is never inferred from totals");
 assert.equal(reviewed.issues.filter(i=>i.message==="Use a USD receipt.").length,3);
 assert.equal(reviewed.issues.some(i=>i.message==="Use a USD receipt."&&i.suggestion),false);
 assert.equal(capturedKatanaOcr.includes("Sashimi\n$36.00"),true);
});
test("joining a wrapped price consumes only its adjacent name, preserving an earlier identical line",()=>{
 const text="Soup\nSoup\n$5.00\nTax 0.00\nTotal 5.00";
 const result=parseReceiptText(text),issue=result.issues.find(i=>i.suggestion?.context?.consume);
 assert.ok(issue);assert.equal(issue.suggestion.context.line,2);
 const lines=text.split("\n");lines[issue.line-1]=issue.suggestion.text;lines.splice(issue.suggestion.context.line-1,1);
 const reviewed=parseReceiptText(lines.join("\n"));
 assert.deepEqual(reviewed.items.map(i=>[i.name,i.cents]),[["Soup",500]]);
 assert.equal(reviewed.ignored.filter(line=>line==="Soup").length,1);
 assert.equal(lines[0],"Soup");assert.equal(text,"Soup\nSoup\n$5.00\nTax 0.00\nTotal 5.00");
});
test("wrapped price offers no item suggestion after a summary, priced item, currency issue or blank line",()=>{
 for(const text of ["Tax\n$1.00","Soup 4.00\n$1.00","EUR\n$1.00","Soup\n\n$1.00"]){
  assert.equal(parseReceiptText(text).issues.some(i=>i.suggestion?.context),false,text);
 }
});


test("observed cash change and paid balance require an explicit reversible exclusion",()=>{
 for(const [text,label,prices,total] of [
  ["1 Miller Lite 5.00\nSUB TOTAL: 5.00\nSales Tax: 0.35\nTOTAL: $5.35\nCash Tendered: 5.35\nBalance: $0.00","Exclude paid balance",[500],535],
  ["1 #1 CHKN PLATE $9.39\n1 + AVOCADO $1.95\n1 MD. DRINK $2.29\nTAX $1.40\nTOTAL $15.03\nCASH $20.00\nCG $4.97","Exclude cash change",[939,195,229],1503]
 ]){
  const original=parseReceiptText(text);
  assert.equal(original.ready,false,"matching arithmetic does not consent to excluding a footer");
  assert.deepEqual(original.items.map(item=>item.cents),prices);
  const issue=original.issues.find(issue=>issue.suggestion?.label===label);
  assert.ok(issue);assert.equal(issue.suggestion.action,"exclude");
  assert.equal(issue.suggestion.context.consume,undefined,"cash context is supporting evidence, not consumed");
  const lines=text.split("\n");
  assert.equal(lines[issue.line-1],issue.text);
  assert.equal(lines[issue.suggestion.context.line-1],issue.suggestion.context.text);
  const excluded=lines.splice(issue.line-1,1)[0];
  const reviewed=parseReceiptText(lines.join("\n"));
  assert.equal(reviewed.ready,true);
  assert.equal(reviewed.reconciliation.totalCents,total);
  lines.splice(issue.line-1,0,excluded);
  assert.equal(lines.join("\n"),text,"undo retains every original price and source line");
  assert.equal(parseReceiptText(lines.join("\n")).ready,false);
 }
});
test("cash footer suggestions need the observed payment context, not just the CG or Balance name",()=>{
 const unrelated=parseReceiptText("CG 4.97\nTotal 4.97");
 assert.equal(unrelated.ready,true);assert.equal(unrelated.items[0].name,"CG");
 for(const text of [
  "Soup 10.00\nTotal 10.00\nCG 4.97",
  "Soup 10.00\nTotal 10.00\nCash 20.00\nCG 4.97",
  "Soup 10.00\nTotal 10.00\nCash 20.00\nBalance 0.00",
  "Soup 10.00\nCash 20.00\nTotal 10.00\nCG 10.00",
  "Soup 10.00\nTotal 10.00\nCash 20.00\nOther item 1.00\nCG 10.00"
 ])assert.equal(parseReceiptText(text).issues.some(issue=>issue.suggestion?.label.startsWith("Exclude cash")||issue.suggestion?.label==="Exclude paid balance"),false,text);
});

test("observed photo border marks offer explicit summary repairs without fixing a misread price",()=>{
 const captured="=             L’0ro Di Napoli               y\n]               629 4th Street\n\n]             Santa Rosa, CA 95404            |\n\n:\n\nJ   Server: Francesco D                      |\n§ Check #2                          Table 2 '§\n\n1   Ordered:     ;            1/4/25 12:12 PH 9\n\n|\n18 Polpette della Nonna              $14.00\n\n   1 Margherita                     $22.00\n\n:   1 Tiramisu                      512.00\n|                                   i\n\n|   Subtotal                            $48.00\n\n| Tax                                  $4.45\n   Total                 $52.45\n\n|                    Grazie!                   :\ni                                    i\nCe CR ST\n\nel de     a EN\n";

 const first=parseReceiptText(captured);
 assert.equal(first.ready,false);
 assert.deepEqual(first.items.map(item=>item.cents),[1400,2200,51200]);
 const repairs=first.issues.filter(issue=>issue.suggestion);
 assert.deepEqual(repairs.map(issue=>issue.suggestion.label),["Read label as Subtotal","Read label as Tax"]);
 const lines=captured.split("\n");
 for(const issue of repairs){
  assert.equal(lines[issue.line-1].trim(),issue.text);
  assert.equal(issue.suggestion.action,"replace");
  assert.equal(issue.suggestion.text,issue.text.replace(/^\|\s+/,""));
  assert.equal(issue.suggestion.text.match(/\$?\d+\.\d{2}$/)[0],issue.text.match(/\$?\d+\.\d{2}$/)[0]);
  lines[issue.line-1]=issue.suggestion.text;
 }
 const repaired=parseReceiptText(lines.join("\n"));
 assert.equal(repaired.ready,false);
 assert.deepEqual(repaired.items.map(item=>item.cents),[1400,2200,51200]);
 assert.equal(repaired.printedSubtotalCents,4800);assert.equal(repaired.taxCents,445);
 assert.equal(repaired.printedTotalCents,5245);
 assert.ok(repaired.reconciliation.comparisons.every(item=>item.differenceCents===50000));
 const corrected=parseReceiptText(lines.join("\n").replace("512.00","12.00"));
 assert.equal(corrected.ready,true);assert.equal(corrected.reconciliation.totalCents,5245);
 for(const issue of repairs)lines[issue.line-1]=issue.text;
 assert.equal(parseReceiptText(lines.join("\n")).issues.filter(issue=>issue.suggestion).length,2,"Undo restores the explicit review requirement");
 assert.equal(captured.includes("512.00"),true,"original observed money is preserved");
});
test("border repair is restricted to observed summary labels and never normalizes currency",()=>{
 for(const input of ["| Tax special 4.45","| Pasta 14.00","| Tax £4.45"]){
  assert.equal(parseReceiptText(input).issues.some(issue=>issue.suggestion?.label==="Read label as Tax"),false);
 }
});

import {reconcileReceiptAmounts} from "../tabloom/receipt-reconciliation.js";
import {validateReceiptDraft} from "../tabloom/receipt-draft-store.js";
test("a printed pre-tip total requires an explicit choice and still checks every other cent",()=>{
 const receipt={items:[{cents:225},{cents:675},{cents:775},{cents:150},{cents:400}],discountCents:0,taxCents:222,tipCents:489,printedSubtotalCents:2225,printedTotalCents:2447};
 assert.equal(reconcileReceiptAmounts(receipt).status,"mismatch");
 const reviewed=reconcileReceiptAmounts({...receipt,printedTotalBeforeTip:true});
 assert.equal(reviewed.status,"matched");assert.equal(reviewed.totalCents,2936);
 assert.equal(reviewed.comparisons.find(c=>c.kind==="total").printedCents,2447);
 for(const changed of [{taxCents:223},{discountCents:1},{items:[{cents:226},...receipt.items.slice(1)]}]) assert.equal(reconcileReceiptAmounts({...receipt,...changed,printedTotalBeforeTip:true}).status,"mismatch");
 assert.equal(reconcileReceiptAmounts({...receipt,printedTotalCents:2936}).status,"matched");
 assert.equal(reconcileReceiptAmounts({...receipt,printedTotalCents:2936,printedTotalBeforeTip:true}).status,"mismatch");
 assert.equal(reconcileReceiptAmounts({...receipt,printedTotalBeforeTip:"true"}).status,"invalid");
 assert.equal(reconcileReceiptAmounts({...receipt,printedTotalCents:null,printedSubtotalCents:null}).status,"unverified");
});
test("saved printed-total interpretation is an optional strict boolean",()=>{
 const saved={version:1,sourceText:"",text:"",rows:[],amounts:{discount:"",tax:"",tip:"4.89",printed:"24.47","printed-subtotal":""},remainingText:"",excluded:[],inline:[],rotation:0,mode:"replace",parsed:true,manual:false,model:true,visible:true,sourceOpen:false,optionsOpen:false};
 assert.equal(validateReceiptDraft(saved),saved);
 for(const value of [true,false])assert.equal(validateReceiptDraft({...saved,printedTotalBeforeTip:value}).printedTotalBeforeTip,value);
 for(const value of ["true",1,null])assert.throws(()=>validateReceiptDraft({...saved,printedTotalBeforeTip:value}),/printed-total choice/);
});

test("observed parenthesized unit-price fragments offer only an explicit final-total choice",()=>{
 const raw="CK Manhattan (2 65.00) 10.00\nWhistle Pig Rye 10yr (2 620.00) 40.00\nSubtotal 50.00\nTax 4.00\nTotal 54.00";
 const first=parseReceiptText(raw);assert.equal(first.ready,false);assert.deepEqual(first.items,[]);
 const choices=first.issues.filter(i=>i.suggestion);assert.equal(choices.length,2);
 assert.deepEqual(choices.map(i=>i.suggestion.text),["CK Manhattan (2) 10.00","Whistle Pig Rye 10yr (2) 40.00"]);
 assert.deepEqual(choices.map(i=>i.suggestion.label),["Use $10.00 as line total","Use $40.00 as line total"]);
 const lines=raw.split("\n");for(const issue of choices){assert.equal(lines[issue.line-1],issue.text);lines[issue.line-1]=issue.suggestion.text;}
 const accepted=parseReceiptText(lines.join("\n"));assert.equal(accepted.ready,true);
 assert.deepEqual(accepted.items.map(i=>i.cents),[1000,4000]);assert.equal(accepted.reconciliation.totalCents,5400);
 assert.equal(raw.split("\n")[0],"CK Manhattan (2 65.00) 10.00");
});
test("unit-total choice stays bounded to a positive parenthesized quantity and final amount",()=>{
 for(const line of ["2 Coffee 3.50 7.00","Coffee (0 3.50) 7.00","Coffee (two 3.50) 7.00","Coffee (2 3.50) 0.00","Coffee (2 3.50) -7.00","Tax (2 3.50) 7.00","Service charge (2 3.50) 7.00","Coffee €(2 3.50) 7.00","Coffee 1.50 (2 3.50) 7.00","2 x Coffee (2 3.50) 7.00", "A".repeat(95)+" (2 3.50) 7.00"]){
  const p=parseReceiptText(line);assert.equal(p.ready,false,line);assert.equal(p.issues.some(i=>i.suggestion?.label.includes("as line total")),false,line);
 }
 const p=parseReceiptText("Coffee (2 @3.50) $7.00\nTotal 7.00");assert.equal(p.ready,false);assert.equal(p.issues[0].suggestion.text,"Coffee (2) $7.00");
});
