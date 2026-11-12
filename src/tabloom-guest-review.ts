import { createHash } from "node:crypto";
import { Bill, calculateBill, proportionalCents } from "./tabloom.js";
import { ValidationError } from "./errors.js";

export function guestReviewFingerprint(bill: Bill, tableId: string) {
  return createHash("sha256").update(JSON.stringify({tableId, revision:bill.revision,title:bill.title,guests:bill.guests,items:bill.items,discountCents:bill.discountCents||0,taxCents:bill.taxCents,tipCents:bill.tipCents})).digest("hex");
}
export function guestReviewPacket(bill: Bill, tableId: string, guestId: unknown, allowPaymentRequests = false) {
  if (!allowPaymentRequests && Object.keys(bill.payments).length) throw new ValidationError("Payment requests already exist. This receipt cannot accept item corrections.");
  const guest=bill.guests.find(g=>g.id===guestId);
  if (!guest || !bill.items.length) throw new ValidationError("Choose a guest on a saved receipt with items.");
  const due=calculateBill(bill).dues.find(d=>d.guestId===guest.id)!;
  // Only anonymous allocation positions leave the organizer; no other guest names,
  // notes, payment records, or receipt photo references are needed for the estimate.
  const ordered=bill.guests.map(g=>g.id).sort((a,b)=>a.localeCompare(b));
  const offlineEstimate=allowPaymentRequests?undefined:{
    guestCount:ordered.length,guestIndex:ordered.indexOf(guest.id),
    discountCents:bill.discountCents||0,taxCents:bill.taxCents,tipCents:bill.tipCents,
    items:bill.items.map(item=>{
      const allocation=(selected:boolean)=>{
        const unchanged=selected===item.sharedBy.includes(guest.id);
        const ids=item.sharedBy.filter(id=>id!==guest.id);if(selected)ids.push(guest.id);
        if(!ids.length)return null;
        const shares=proportionalCents(item.cents,ids.map(id=>({id,weight:unchanged?(item.portions?.[id]??1):1})));
        return ordered.map(id=>shares[id]||0);
      };
      return {id:item.id,selected:allocation(true),unselected:allocation(false)};
    })
  };
  return {kind:"tabloom-guest-review",version:1,...(offlineEstimate?{offlineEstimate}:{}),tableId,revision:bill.revision,fingerprint:guestReviewFingerprint(bill,tableId),guestId:guest.id,guestName:guest.name,title:bill.title,totalCents:due.totalCents,discountCents:due.discountCents||0,itemsCents:due.itemsCents,taxCents:due.taxCents,tipCents:due.tipCents,
    items:bill.items.map(item=>({id:item.id,name:item.name,cents:item.cents,selected:item.sharedBy.includes(guest.id),shareCents:due.lineItems.find(line=>line.itemId===item.id)?.shareCents??0,sharedCount:item.sharedBy.length,...(item.portions?{portionCount:item.portions[guest.id]??0,totalPortions:Object.values(item.portions).reduce((sum,n)=>sum+n,0)}:{})}))};
}
export function previewGuestReview(bill: Bill, tableId: string, raw: unknown) {
  if (Object.keys(bill.payments).length) throw new ValidationError("Payment requests already exist. This receipt cannot accept item corrections.");
  if (!raw || typeof raw!=="object" || Array.isArray(raw)) throw new ValidationError("Choose a Tabloom guest response JSON file.");
  const r=raw as Record<string, any>;
  if(r.kind!=="tabloom-guest-response" || r.version!==1)throw new ValidationError("Choose a Tabloom guest response JSON file.");
  if(r.tableId!==tableId)throw new ValidationError("This response belongs to another table. Open that table before importing it.");
  if(r.revision!==bill.revision || r.fingerprint!==guestReviewFingerprint(bill,tableId))throw new ValidationError("This response describes an older or different receipt. Export a fresh review for the guest.");
  const guest=bill.guests.find(g=>g.id===r.guestId);
  if(!guest)throw new ValidationError("The guest is not on this receipt.");
  if(!Array.isArray(r.items)||r.items.length!==bill.items.length||new Set(r.items.map((i:any)=>i?.id)).size!==bill.items.length)throw new ValidationError("The response must answer every receipt item exactly once.");
  if(r.items.some((i:any)=>!i||typeof i.selected!=="boolean"||!bill.items.some(item=>item.id===i.id)))throw new ValidationError("The response has an unknown item or incomplete choice.");
  const proposed=structuredClone(bill);
  const changes:{itemId:string;name:string;selected:boolean}[]=[];
  for(const item of proposed.items){
    const selected=r.items.find((i:any)=>i.id===item.id).selected;
    if(selected!==item.sharedBy.includes(guest.id)){changes.push({itemId:item.id,name:item.name,selected});delete item.portions;}
    item.sharedBy=item.sharedBy.filter(id=>id!==guest.id);
    if(selected)item.sharedBy.push(guest.id);
  }
  const unresolved=proposed.items.filter(i=>!i.sharedBy.length).map(i=>({id:i.id,name:i.name}));
  return {guest:guest.name,revision:bill.revision,changes,unresolved,bill:proposed,calculated:unresolved.length?null:calculateBill(proposed)};
}
