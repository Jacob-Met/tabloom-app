/** Shared exact-cent largest remainder rule; callers validate inputs. */
export function allocateExactCents(total,weights){
  const denominator=weights.reduce((sum,w)=>sum+BigInt(w.weight),0n);
  const allocations=weights.map(w=>{const numerator=BigInt(total)*BigInt(w.weight);return {id:w.id,base:Number(numerator/denominator),remainder:numerator%denominator};});
  let remaining=total-allocations.reduce((sum,w)=>sum+w.base,0);
  const ranked=[...allocations].sort((a,b)=>a.remainder===b.remainder?a.id.localeCompare(b.id):a.remainder>b.remainder?-1:1);
  for(const w of ranked){if(remaining--<=0)break;w.base++;}
  return Object.fromEntries(allocations.map(w=>[w.id,w.base]));
}
/** Recalculate this guest's choices against the exported receipt, never a live bill. */
export function estimateOfflineChoices(packet,choices){
  const basis=packet.offlineEstimate;
  if(!basis)return null;
  const subtotals=Array(basis.guestCount).fill(0),lineItems=[],unresolved=[];
  for(const item of packet.items){
    const selected=choices.find(choice=>choice.id===item.id)?.selected;
    if(typeof selected!=="boolean")throw Error("Every receipt item needs a choice.");
    const entry=basis.items.find(entry=>entry.id===item.id);
    const allocation=selected?entry.selected:entry.unselected;
    if(!allocation){unresolved.push({id:item.id,name:item.name});continue;}
    allocation.forEach((value,index)=>subtotals[index]+=value);
    if(selected)lineItems.push({itemId:item.id,name:item.name,shareCents:allocation[basis.guestIndex],sharedCount:item.sharedCount+(item.selected?0:1),...(item.selected&&item.portionCount?{portionCount:item.portionCount,totalPortions:item.totalPortions}:{})});
  }
  if(unresolved.length)return {share:null,unresolved};
  const weights=subtotals.map((weight,index)=>({id:String(index).padStart(2,"0"),weight}));
  const id=String(basis.guestIndex).padStart(2,"0");
  const discountCents=allocateExactCents(basis.discountCents,weights)[id],taxCents=allocateExactCents(basis.taxCents,weights)[id],tipCents=allocateExactCents(basis.tipCents,weights)[id];
  const itemsCents=subtotals[basis.guestIndex];
  return {share:{itemsCents,discountCents,taxCents,tipCents,totalCents:itemsCents-discountCents+taxCents+tipCents,lineItems},unresolved:[]};
}
