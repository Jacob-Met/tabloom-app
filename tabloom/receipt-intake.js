import {reconcileReceiptAmounts} from "./receipt-reconciliation.js";
const money = raw => {const [whole,fraction]=raw.replace(/[$,\s]/g,"").split("."); return Number(whole)*100+Number(fraction);};
export function parseReceiptText(text) {
  if(typeof text!=="string"||text.length>20000)throw Error("Use a receipt of 20,000 characters or fewer.");
  const result={items:[],taxCents:0,tipCents:0,discountCents:0,ignored:[],issues:[]};
  if(text.split(/\r?\n/).length>200)throw Error("Use at most 200 receipt lines.");
  const seen=new Set(), quantityLines=[];
  let suggestedTips=false, cashTender=null;
  const fields={subtotal:"printedSubtotalCents",total:"printedTotalCents",tax:"taxCents",tip:"tipCents",discount:"discountCents"};
  const sourceLines=text.split(/\r?\n/);
  for(const [index,raw] of sourceLines.entries()){
    const line=raw.trim(); if(!line)continue;
    const issue=(message,suggestion)=>result.issues.push({line:index+1,text:line,message,...(suggestion?{suggestion}:{})});
    if(/[€£¥₹₩₽฿₱]|\b(?:EUR|GBP|CAD|AUD|JPY|NZD|SGD|HKD|MYR|IDR|INR|CNY|RMB|PHP|THB|VND|KRW|CHF|ZAR|MXN|BRL|RM)\b|\bRM(?=\d)/i.test(line)){issue("Use a USD receipt.");continue;}
    if(/^(?:tip suggestions?|suggested (?:tips?|gratuity)|suggested tip amounts?)\s*:?$/i.test(line)){suggestedTips=true;result.ignored.push(line);continue;}
    if(suggestedTips && /^\d+(?:\.\d+)?\s*%\s*:?\s*\$?\s*\d+\.\d{2}\s*$/.test(line)){result.ignored.push(line);continue;}
    suggestedTips=false;
    if(/\bcard\b.*\b(?:balance|ending)\b/i.test(line)){result.ignored.push(line);continue;}
    const quantity=line.match(/^(\d{1,3})\s*[x×]\s+(.+?)\s+@\s*\$?(\d+\.\d{2})\s+\$?(\d+\.\d{2})$/i);
    if(quantity){
      const count=Number(quantity[1]),unit=money(quantity[3]),cents=money(quantity[4]),name=count+" × "+quantity[2];
      if(!count||count*unit!==cents||cents<=0||cents>10000000||name.length>96){issue("Quantity × unit price does not match a valid printed line total.");continue;}
      result.items.push({name,cents,sourceLine:index+1});continue;
    }
    if(/^\$?\s*(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}$/.test(line)){
      const previous=sourceLines[index-1]?.trim();
      const isItemLabel=previous&&previous.length<=96&&/[a-z]/i.test(previous)&&!/\$|\d+[.,]\d{2}/.test(previous)
        &&! /^(?:sub\s*total|total|tax|tip|gratuity|discount|coupon|cash|change|paid|payment|card|suggested|tel|phone|date|time|order|table|check|server|cashier|receipt|invoice|merchant)\b/i.test(previous)
        &&result.ignored.includes(previous);
      if(isItemLabel&&money(line)>0&&money(line)<=10000000){
        issue("This price is on a separate line. Check which item it belongs to.",{
          action:"replace",label:"Use previous line as item name",text:previous+" "+line,
          context:{line:index,text:previous,consume:true}
        });
        continue;
      }
    }
    const match=line.match(/^(.*?)\s+(-?\$?\s*(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})\s*$/);
    if(!match){
      const metadata=/^\s*(?:tel|phone|date|time|order|table|check|server|cashier|receipt|invoice|merchant|cash|change|paid|payment|visa|mastercard|amex|card|tendered|amount tendered)\b/i.test(line);
      if(!metadata&&/\$/.test(line))issue("Check this price: include dollars and two decimal places, or remove this non-item line.");
      else if(!metadata&&/[\d][.,]\d{1,2}\b/.test(line))issue("Check this amount or remove this non-item line.");
      else result.ignored.push(line);
      continue;
    }
    let name=match[1].trim().replace(/[:.]$/,"").trim(), amount=money(match[2].replace("-",""));
    if(!name||!Number.isSafeInteger(amount)||amount>10000000){issue("Check the item name and amount.");continue;}
    const key=name.toLowerCase().replace(/\s+/g," ");
    const borderedSummary=key.match(/^\|\s+(sub\s*total|tax)$/);
    if(borderedSummary){
      const label=/^sub/.test(borderedSummary[1])?"Subtotal":"Tax";
      issue("Check this summary label against the receipt.",{action:"replace",label:"Read label as "+label,text:line.replace(/^\|\s+/,"")});
      continue;
    }
    let kind=/^(?:sub\s*total|food (?:and|&) drinks)$/.test(key)?"subtotal":/^(?:grand total|total|amount due|balance due)$/.test(key)?"total":/^(?:sales tax|tax|tax total|total tax)(?:\s+\(?\d+(?:\.\d+)?%\)?)?$/.test(key)?"tax":/^(?:tip|gratuity)(?:\s+\(?\d+(?:\.\d+)?%\)?)?$/.test(key)?"tip":/^(?:discount|coupon|receipt discount)(?:\s+.*)?$/.test(key)?"discount":null;
    if(/^(?:cash|change|paid|payment|visa|mastercard|amex|card|tendered|amount tendered|suggested tip)\b/.test(key)){
      if(/^(?:cash|cash tendered)$/.test(key)&&seen.has("total")&&!match[2].startsWith("-"))cashTender={line:index+1,text:line,cents:amount};
      result.ignored.push(line);continue;
    }
    const cashFooter=cashTender&&sourceLines.slice(cashTender.line,index).every(raw=>!raw.trim())&&!match[2].startsWith("-");
    if(cashFooter&&key==="cg"&&cashTender.cents-amount===result.printedTotalCents){
      issue("Check that this is cash change, not a purchased item.",{action:"exclude",label:"Exclude cash change",context:{line:cashTender.line,text:cashTender.text}});
      continue;
    }
    if(cashFooter&&key==="balance"&&amount===0&&cashTender.cents===result.printedTotalCents){
      issue("Check that this is the remaining balance after payment, not a receipt charge.",{action:"exclude",label:"Exclude paid balance",context:{line:cashTender.line,text:cashTender.text}});
      continue;
    }
    if(!kind&&/^sublotal$/.test(key)){issue("Check this summary label against the receipt.",{action:"replace",label:"Read label as Subtotal",text:line.replace(/^sublotal/i,"Subtotal")});continue;}
    if(!kind&&/^(?:(?:sales )?tax|tip|gratuity)\b/.test(key)){issue("Check this summary label; use Subtotal, Tax or Tip with its printed amount.");continue;}
    if(!kind&&/\bcard$/.test(key)){issue("Check this card tender line against the receipt.",{action:"exclude",label:"Exclude card payment"});continue;}
    if(kind){
      if(seen.has(kind)){issue("More than one "+kind+" amount: keep the final receipt amount.");continue;}
      seen.add(kind);result[fields[kind]]=amount;
      if(match[2].startsWith("-")&&kind!=="discount")issue("Check the negative "+kind+".");
      continue;
    }
    if(match[2].startsWith("-")){issue("Name receipt-wide reductions Discount or Coupon.");continue;}
    if(/\d+\.\d{2}/.test(name)){
      const unitFragment=name.match(/^(.*?)\s+\(([1-9]\d{0,2})\s+@?\s*\$?\s*(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}\)$/);
      const itemName=unitFragment?unitFragment[1].trim()+" ("+unitFragment[2]+")":null;
      const excluded=unitFragment&&(/\d+\.\d{2}/.test(unitFragment[1])||/^(?:sub\s*total|total|amount|balance|tax|tip|gratuity|discount|coupon|cash|change|paid|payment|card|service|delivery|processing|convenience|vat|gst|hst)\b|^\d+\s*[x×]\s/i.test(unitFragment[1]));
      const suggestion=itemName&&itemName.length<=96&&!excluded&&amount>0?{action:"replace",label:"Use $"+(amount/100).toFixed(2)+" as line total",text:itemName+" "+match[2].trim()}:undefined;
      issue(suggestion?"Check the final printed amount for this whole line. Choosing it removes the unit-price fragment.":"Keep one final line amount; remove the unit-price column.",suggestion);continue;
    }
    if(name.length>96||amount===0){issue("Use an item name up to 96 characters and a positive amount.");continue;}
    if(/^(?:service|delivery|processing|convenience)\s+(?:charge|fee)|^vat\b|^gst\b|^hst\b/i.test(name)){issue("Review this charge; enter its final amount as Tax or Tip if appropriate.");continue;}
    if(/^\d+\s*[x×]\s/i.test(name)&&!/\b(?:line )?total$/i.test(name))quantityLines.push({line:index+1,text:line});
    name=name.replace(/\s+(?:line )?total$/i,"");
    result.items.push({name,cents:amount,sourceLine:index+1});
  }
  if(!result.items.length)result.issues.push({message:"No receipt items found. Put each item and its final price on one line."});
  if(result.items.length>60)result.issues.push({message:"Use at most 60 receipt items."});
  result.reconciliation=reconcileReceiptAmounts(result);
  if(result.reconciliation.status==="invalid"||result.reconciliation.status==="mismatch")result.issues.push(...result.reconciliation.issues);
  if(result.reconciliation.totalCents>10000000)result.issues.push({message:"Receipt total exceeds $100,000."});
  if(quantityLines.length&&(result.printedTotalCents===undefined||result.reconciliation.totalCents!==result.printedTotalCents)){
    result.issues.push(...quantityLines.map(line=>({...line,message:"A quantity with one price could mean a unit price. Add an explicit line total, or include @ unit price and printed line total."})));
  }
  result.printedCharges=Object.fromEntries(["tax","tip","discount"].map(kind=>[kind,seen.has(kind)]));
  result.ready=result.issues.length===0;
  return result;
}
