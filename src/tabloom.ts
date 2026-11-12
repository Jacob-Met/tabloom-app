/**
 * Tabloom — exact-cent group bill allocation.
 * AI may suggest sharedBy sets; it never computes, approves, or moves money.
 */
import { ValidationError } from "./errors.js";
import { allocateExactCents } from "../tabloom/share-math.js";

export interface Guest { id: string; name: string }
export interface BillItem { id: string; name: string; cents: number; sharedBy: string[]; portions?: Record<string, number> }
export interface Payment {
  requestId: string;
  requestStartedAt?: string;
  captureStartedAt?: string;
  status: "creating" | "unknown_order" | "awaiting_approval" | "capture_unknown" | "captured" | "pending";
  amountCents: number;
  orderId?: string;
  approvalUrl?: string;
  captureRequestId?: string;
  captureId?: string;
  providerStatus?: "CREATED" | "SAVED" | "APPROVED" | "VOIDED" | "COMPLETED" | "PAYER_ACTION_REQUIRED";
  providerCheckedAt?: string;
  /** Latest failed observation is separate from the last known settlement state. */
  providerFailure?: {reason:"not_found"|"unavailable"|"order_mismatch"|"connection_changed";checkedAt:string};
  /** Nonsecret app identity recorded before the original request; absent on legacy records. */
  paypalAppFingerprint?: string;
  /** New request only: no order dispatch has begun while this marker remains true. */
  paypalAppBindingPending?: boolean;
  /** Immutable return location used by the original order request. */
  returnUrl?: string;
}
export const PAYPAL_REQUEST_TIMEOUT_MS=20000;
/** Reserve the existing POST timeout inside default retention; do not assume extensions. */
export function paymentRetryAllowed(payment:Payment,now=Date.now()):boolean {
  const value=payment.status==="capture_unknown"?payment.captureStartedAt:payment.requestStartedAt;
  const started=typeof value==="string"?Date.parse(value):NaN;
  return Number.isFinite(started)&&now>=started&&now-started<6*60*60*1000-PAYPAL_REQUEST_TIMEOUT_MS;
}
export interface ReceiptSource { id:string; type:"image/jpeg"|"image/png"|"image/webp"; bytes:number }
export interface Bill {
  receiptSources?: ReceiptSource[];
  revision: number;
  title: string;
  note: string;
  guests: Guest[];
  items: BillItem[];
  discountCents?: number;
  taxCents: number;
  tipCents: number;
  payments: Record<string, Payment>;
}
export interface SuggestedShare { itemId: string; guestIds: string[]; reason: string }
export interface GuestChargeLine { itemId: string; name: string; fullCents: number; sharedCount: number; shareCents: number; portionCount?: number; totalPortions?: number }
export interface BillDues { guestId: string; name: string; itemsCents: number; discountCents?: number; taxCents: number; tipCents: number; totalCents: number; paidCents: number; lineItems: GuestChargeLine[] }

function requireValid(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new ValidationError(reason);
}
function cents(value: unknown, label: string, min: number): number {
  requireValid(Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= 10000000, label + " must be exact integer cents between " + min + " and 10000000");
  return value as number;
}
function id(value: unknown): string {
  requireValid(typeof value === "string" && /^[a-zA-Z0-9_-]{1,48}$/.test(value), "IDs must be 1–48 ASCII letters/digits/-/_");
  return value;
}
function label(value: unknown, name: string, limit: number): string {
  requireValid(typeof value === "string" && value.trim().length > 0 && value.length <= limit, name + " is required and must be at most " + limit + " characters");
  return value.trim();
}
export function fixtureBill(): Bill {
  return {
    revision: 0, title: "Friday after-hours", note: "Mira had udon. Joss and Petra shared dumplings. Everyone shared the sparkling water.",
    guests: [{id:"mira",name:"Mira"},{id:"joss",name:"Joss"},{id:"petra",name:"Petra"}],
    items: [{id:"udon",name:"Miso udon",cents:1650,sharedBy:["mira"]},{id:"dumplings",name:"Pan-fried dumplings",cents:1400,sharedBy:["joss","petra"]},{id:"water",name:"Sparkling water",cents:750,sharedBy:["mira","joss","petra"]}],
    taxCents: 315, tipCents: 760, payments: {},
  };
}
/** Validate browser-proposed draft; payment state is never browser-supplied. */
export function validateDraft(input: unknown, revision: number, payments: Record<string, Payment>, allowUnassigned = false): Bill {
  requireValid(input !== null && typeof input === "object" && !Array.isArray(input), "bill draft must be an object");
  const x = input as Record<string, unknown>;
  requireValid(Array.isArray(x.guests) && x.guests.length >= 2 && x.guests.length <= 12, "bill must have 2–12 guests");
  requireValid(Array.isArray(x.items) && x.items.length <= 60, "bill must have 0–60 items");
  const guests = x.guests.map((raw) => {
    requireValid(raw !== null && typeof raw === "object", "invalid guest");
    const g = raw as Record<string, unknown>;
    return { id: id(g.id), name: label(g.name, "guest name", 48) };
  });
  const ids = guests.map(g => g.id);
  requireValid(new Set(ids).size === ids.length, "duplicate guest ID");
  const items = x.items.map(raw => {
    requireValid(raw !== null && typeof raw === "object", "invalid item");
    const i = raw as Record<string, unknown>;
    requireValid(Array.isArray(i.sharedBy) && (allowUnassigned || i.sharedBy.length > 0), "every item must have at least one guest");
    const sharedBy = i.sharedBy.map(id);
    requireValid(new Set(sharedBy).size === sharedBy.length && sharedBy.every(s => ids.includes(s)), "item has duplicate or unknown guest");
    let portions: Record<string,number> | undefined;
    if(i.portions!==undefined){
      requireValid(i.portions!==null && typeof i.portions==="object" && !Array.isArray(i.portions), "item portions must name each selected guest");
      const values=i.portions as Record<string,unknown>;
      requireValid(sharedBy.length>0 && Object.keys(values).length===sharedBy.length && sharedBy.every(guest=>Object.hasOwn(values,guest)), "item portions must match the selected guests");
      requireValid(Object.values(values).every(value=>Number.isSafeInteger(value) && (value as number)>=1 && (value as number)<=1000), "Use 1–1000 whole portions for each selected guest");
      portions=Object.fromEntries(sharedBy.map(guest=>[guest,values[guest] as number]));
    }
    return { id: id(i.id), name: label(i.name, "item name", 96), cents: cents(i.cents, "item amount", 1), sharedBy, ...(portions?{portions}:{}) };
  });
  requireValid(new Set(items.map(i => i.id)).size === items.length, "duplicate item ID");
  const discountCents = x.discountCents===undefined?0:cents(x.discountCents,"receipt discount",0);
  requireValid(discountCents<=items.reduce((sum,item)=>sum+item.cents,0),"Receipt discount cannot exceed the food and drink subtotal");
  const taxCents = cents(x.taxCents, "tax", 0);
  const tipCents = cents(x.tipCents, "tip", 0);
  requireValid(items.length > 0 || (taxCents === 0 && tipCents === 0), "Add receipt items before adding tax or tip.");
  const sum = items.reduce((n, item) => n + item.cents, taxCents + tipCents);
  requireValid(Number.isSafeInteger(sum) && sum <= 10000000, "bill exceeds $100,000 maximum");
  const title = label(x.title, "bill title", 100);
  requireValid(typeof x.note === "string" && x.note.length <= 2000, "table note must be at most 2,000 characters");
  requireValid(Object.keys(payments).every(k => ids.includes(k)), "cannot remove a guest with payment history");
  let receiptSources:ReceiptSource[]|undefined;
  if(x.receiptSources!==undefined){
    requireValid(Array.isArray(x.receiptSources)&&x.receiptSources.length<=20,"Keep at most 20 original receipt photos.");
    receiptSources=x.receiptSources.map((raw:unknown)=>{
      requireValid(!!raw&&typeof raw==="object","Invalid original receipt photo.");
      const r=raw as Record<string,unknown>;
      requireValid(typeof r.id==="string"&&/^[a-f0-9]{64}$/.test(r.id)&&["image/jpeg","image/png","image/webp"].includes(r.type as string)&&Number.isSafeInteger(r.bytes)&&(r.bytes as number)>0&&(r.bytes as number)<=20*1024*1024,"Invalid original receipt photo.");
      return {id:r.id as string,type:r.type as ReceiptSource["type"],bytes:r.bytes as number};
    });
    requireValid(new Set(receiptSources.map(r=>r.id)).size===receiptSources.length,"Duplicate original receipt photo.");
  }
  return { revision, title, note:x.note as string, guests, items, ...(receiptSources?.length?{receiptSources}:{}), ...(discountCents?{discountCents}:{}), taxCents, tipCents, payments };
}
/** Deterministic largest remainder with exact BigInt multiplication and stable tie breaks. */
export function proportionalCents(total: number, weights: Array<{id:string; weight:number}>): Record<string, number> {
  requireValid(Number.isSafeInteger(total) && total >= 0, "invalid shared total");
  requireValid(weights.length > 0 && weights.every(w => Number.isSafeInteger(w.weight) && w.weight >= 0), "invalid weights");
  const denominator = weights.reduce((n,w) => n + BigInt(w.weight), 0n);
  requireValid(denominator > 0n, "cannot distribute across zero weights");
  return allocateExactCents(total,weights);
}
export function calculateBill(bill: Bill): {subtotalCents:number; totalCents:number; dues:BillDues[]} {
  const guests:BillDues[] = bill.guests.map(g=>({guestId:g.id,name:g.name,itemsCents:0,taxCents:0,tipCents:0,totalCents:0,paidCents:0,lineItems:[] as GuestChargeLine[]}));
  const byId = new Map(guests.map(g => [g.guestId,g]));
  for (const item of bill.items) {
    const split = proportionalCents(item.cents,item.sharedBy.map(id=>({id,weight:item.portions?.[id]??1})));
    for (const [id,value] of Object.entries(split)) {
      const guest=byId.get(id)!;
      guest.itemsCents += value;
      guest.lineItems.push({itemId:item.id,name:item.name,fullCents:item.cents,sharedCount:item.sharedBy.length,shareCents:value,...(item.portions?{portionCount:item.portions[id],totalPortions:Object.values(item.portions).reduce((sum,n)=>sum+n,0)}:{})});
    }
  }
  const subtotalCents = bill.items.reduce((sum,i)=>sum+i.cents,0);
  if (!bill.items.length) return {subtotalCents: 0, totalCents: 0, dues: guests};
  const discount = proportionalCents(bill.discountCents||0,guests.map(g=>({id:g.guestId,weight:g.itemsCents})));
  const tax = proportionalCents(bill.taxCents,guests.map(g=>({id:g.guestId,weight:g.itemsCents})));
  const tip = proportionalCents(bill.tipCents,guests.map(g=>({id:g.guestId,weight:g.itemsCents})));
  for (const g of guests) {
    g.taxCents=tax[g.guestId];g.tipCents=tip[g.guestId];g.totalCents=g.itemsCents-discount[g.guestId]+g.taxCents+g.tipCents;
    if(bill.discountCents)g.discountCents=discount[g.guestId];
    const p=bill.payments[g.guestId];g.paidCents=p?.status==="captured"?p.amountCents:0;
  }
  return {subtotalCents,totalCents:subtotalCents-(bill.discountCents||0)+bill.taxCents+bill.tipCents,dues:guests};
}
export function parseSuggestions(response: string, bill: Bill, allowUnresolved = false): SuggestedShare[] {
  requireValid(response.length <= 32768, "model response exceeded bounded size");
  let result: unknown;
  try { result = JSON.parse(response); } catch { throw new ValidationError("model response is not valid JSON"); }
  requireValid(result!==null && typeof result==="object" && Array.isArray((result as Record<string,unknown>).assignments), "model response needs assignments array");
  const assignments = (result as { assignments: unknown[] }).assignments;
  requireValid(allowUnresolved ? assignments.length<=bill.items.length : assignments.length===bill.items.length, "model must propose each item exactly once");
  const known = new Set(bill.guests.map(g=>g.id));
  const itemIds = new Set(bill.items.map(i=>i.id));
  const used = new Set<string>();
  const parsed: SuggestedShare[] = [];
  for (const raw of assignments) {
    requireValid(raw!==null && typeof raw==="object", "invalid model assignment");
    const r=raw as Record<string,unknown>;
    const itemId=id(r.itemId);
    if(allowUnresolved && !itemIds.has(itemId)) continue;
    requireValid(itemIds.has(itemId) && !used.has(itemId), "model used unknown/duplicate item");
    requireValid(Array.isArray(r.guestIds) && r.guestIds.length>=(allowUnresolved ? 0 : 1) && r.guestIds.length<=bill.guests.length, "model must name at least one guest per item");
    const guestIds=(r.guestIds as unknown[]).map(id);
    requireValid(new Set(guestIds).size===guestIds.length && guestIds.every(g=>known.has(g)), "model used unknown or duplicate guest");
    requireValid(typeof r.reason==="string" && r.reason.length<=240, "model reason must be 240 characters or less");
    parsed.push({itemId,guestIds,reason:r.reason as string});
    used.add(itemId);
  }
  if(allowUnresolved) for(const item of bill.items) if(!used.has(item.id)) parsed.push({itemId:item.id,guestIds:[],reason:"The model did not assign this item. Choose who shared it before applying."});
  return bill.items.map(item=>parsed.find(s=>s.itemId===item.id)!);
}

