const amount=cents=>Number.isSafeInteger(cents)?(cents/100).toFixed(2):"";
const text=value=>value==null?"":String(value);
export function earlierDraft(record,bill){
  if(!record?.draft)return null;
  return record.base!==JSON.stringify(bill)?record:record.earlier||null;
}
export function draftComparisonRows(record,bill){
  if(!record?.draft||!Array.isArray(record.draft.items)||!Array.isArray(record.draft.guests))return [];
  const rows=[],add=(label,current,earlier)=>{current=text(current);earlier=text(earlier);if(current!==earlier)rows.push({label,current:current||"Empty",earlier:earlier||"Empty"});};
  for(const [key,label] of [["title","Dinner name"],["note","Split note"],["discount","Discount (USD)"],["tax","Tax (USD)"],["tip","Tip (USD)"]]){
    const current=["discount","tax","tip"].includes(key)?amount(bill[key+"Cents"]||0):bill[key];
    add(label,current,record.fields?.[key]??(["discount","tax","tip"].includes(key)?amount(record.draft[key+"Cents"]||0):record.draft[key]));
  }
  const names=guests=>guests.map(g=>g.name).join(", ");
  add("People",names(bill.guests),names(record.draft.guests));
  const itemText=(item,guests,raw,showName=true)=>{
    if(!item)return "Not in this receipt";
    const value=raw?.prices?.[item.id]??amount(item.cents);
    return [showName?item.name:null,value?"$"+value:"Empty amount",item.sharedBy.length?item.sharedBy.map(id=>{
      const name=guests.find(g=>g.id===id)?.name||id;
      return item.portions?name+" × "+(raw?.portions?.[item.id+":"+id]??item.portions[id]??1):name;
    }).join(" · "):"Unassigned"].filter(value=>value!==null).join("\n");
  };
  for(const id of new Set([...record.draft.items.map(i=>i.id),...bill.items.map(i=>i.id)])){
    const prior=record.draft.items.find(i=>i.id===id),current=bill.items.find(i=>i.id===id);
    const showName=prior?.name!==current?.name;
    add(prior?.name||current?.name||"Item",itemText(current,bill.guests,null,showName),itemText(prior,record.draft.guests,record,showName));
  }
  for(const proposal of record.noteReview?.proposal?.suggestions||[]){
    const item=record.draft.items.find(i=>i.id===proposal.itemId);if(!item)continue;
    const prior=(proposal.guestIds||[]).map(id=>record.draft.guests.find(g=>g.id===id)?.name||id).join(" · ")||"Unassigned";
    rows.push({label:"Pending split · "+item.name,current:"Not applied",earlier:prior+(record.noteReview.confirmed?.includes(proposal.itemId)?" · checked":" · unchecked")});
  }
  return rows;
}
export function renderDraftComparison(element,record,bill){
  const rows=draftComparisonRows(earlierDraft(record,bill),bill);element.replaceChildren();element.hidden=!rows.length;if(!rows.length)return;
  const doc=element.ownerDocument,summary=doc.createElement("summary");summary.textContent="Compare earlier draft · "+rows.length+" differences";element.append(summary);
  for(const row of rows){const section=doc.createElement("section");section.className="draft-comparison-row";const heading=doc.createElement("h3");heading.textContent=row.label;section.append(heading);
    for(const [key,label] of [["current","Saved now"],["earlier","Earlier draft"]]){const cell=doc.createElement("div"),name=doc.createElement("strong"),value=doc.createElement("p");name.textContent=label;value.textContent=row[key];cell.append(name,value);section.append(cell);}element.append(section);
  }
  const back=doc.createElement("button");back.type="button";back.className="outline";back.textContent="Back to receipt";back.addEventListener("click",()=>{element.open=false;doc.getElementById("receipt-workspace")?.scrollIntoView({block:"start"});});element.append(back);
}
