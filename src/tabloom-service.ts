import { receiptVisionReader, ReceiptVisionError, RECEIPT_VISION_BODY_LIMIT } from "./tabloom-receipt-vision.js";
import { constrainNoteExclusions } from "./tabloom-note-constraints.js";
import { randomUUID, createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Bill, ReceiptSource, Payment, SuggestedShare, PAYPAL_REQUEST_TIMEOUT_MS, paymentRetryAllowed, calculateBill, fixtureBill, parseSuggestions, validateDraft } from "./tabloom.js";
import { ValidationError } from "./errors.js";
import { LEGACY_TABLE, createStoredTable, storedTableIds, tableFile } from "./tabloom-tables.js";

import { guestReviewPacket, previewGuestReview } from "./tabloom-guest-review.js";
import { previewGuestReviews } from "./tabloom-guest-batch.js";
import { guestCheckoutPacket } from "./tabloom-guest-checkout.js";
import { handleVoice, VOICE_ASSETS } from "./tabloom-voice.js"; // voice intake
import { checkPayPalSandboxConnection } from "./tabloom-paypal-setup.js";

import type { TabloomGuestLinks } from "./tabloom-guest-links.js";
import type { TabloomGuestNetwork } from "./tabloom-guest-network.js";

type RequestFetch = typeof fetch;
type State = Bill;
type HttpError = Error & { statusCode?: number; providerFailureReason?: NonNullable<Payment["providerFailure"]>["reason"] };
const isValidHost = (host: string) => /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host);
const here = dirname(fileURLToPath(import.meta.url));

function fail(message: string, code = 400): never {
  const e = new ValidationError(message) as HttpError;
  e.statusCode = code;
  throw e;
}
function money(cents: number): string {
  return (cents / 100).toFixed(2);
}
function verifiedCapture(body: unknown, payment: Payment, guestId: string): {id:string;status:string}|null {
  if (!body || typeof body !== "object") return null;
  const raw = body as Record<string, any>;
  if (raw.id !== payment.orderId || (raw.status !== "COMPLETED" && raw.status !== "APPROVED")) return null;
  const units = raw.purchase_units;
  if (!Array.isArray(units) || units.length !== 1 || units[0]?.reference_id !== guestId) return null;
  const captures = units[0]?.payments?.captures;
  if (!Array.isArray(captures) || captures.length === 0) return null;
  const matching = captures.filter((c:any)=>c?.status==="COMPLETED" && c?.amount?.currency_code==="USD" && c?.amount?.value===money(payment.amountCents));
  if (matching.length !== 1 || captures.length !== 1 || typeof matching[0].id !== "string" || matching[0].id.length < 4) return null;
  return {id:matching[0].id,status:"COMPLETED"};
}
export class TabloomService {
  private tail: Promise<void> = Promise.resolve();
  private readonly tables = new Map<string, TabloomService>();
  public guestNetwork?: TabloomGuestNetwork;
  setGuestLinks(links:TabloomGuestLinks|undefined){this.links=links;for(const service of this.tables.values())service.links=links;}
  constructor(readonly path: string, private readonly fetcher: RequestFetch = fetch, readonly tableId = LEGACY_TABLE, public links?: TabloomGuestLinks) {}
  async table(tableId: string): Promise<TabloomService> {
    if (tableId === LEGACY_TABLE) return this;
    const path = tableFile(this.path, tableId);
    try { await fs.access(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") fail("This saved table could not be found. Choose another table.", 404);
      throw error;
    }
    let service = this.tables.get(tableId);
    if (!service) { service = new TabloomService(path, this.fetcher, tableId, this.links); this.tables.set(tableId, service); }
    service.links=this.links;
    return service;
  }
  async tableList() {
    const ids = await storedTableIds(this.path);
    const tables = await Promise.all(ids.map(async tableId => {
      const service = await this.table(tableId);
      const {bill, calculated} = await service.state();
      const stat = await fs.stat(service.path).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && tableId === LEGACY_TABLE) return null;
        throw error;
      });
      const payments = Object.values(bill.payments);
      return {
        id: tableId, title: bill.title, revision: bill.revision, guestCount: bill.guests.length, guestNames: bill.guests.map(guest=>guest.name),
        itemCount: bill.items.length, totalCents: calculated.totalCents,
        capturedCents: calculated.dues.reduce((sum, due) => sum + due.paidCents, 0),
        unresolvedPayments: payments.filter(payment => payment.status !== "captured").length,
        paymentCount: payments.length, sample: stat === null, updatedAt: stat?.mtime.toISOString() ?? null
      };
    }));
    tables.sort((a,b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.id.localeCompare(b.id));
    return {tables};
  }
  async createTable(tableId: unknown, details: unknown) {
    const id = await createStoredTable(this.path, tableId, details);
    const service = await this.table(id);
    return {tableId: id, ...await service.state()};
  }
  private async exclusive<T>(fn:()=>Promise<T>):Promise<T> {
    const previous=this.tail;let release!:()=>void;
    const next=new Promise<void>(resolve=>{release=resolve;});
    this.tail=previous.then(()=>next);
    await previous;
    try {return await fn();}finally{release();}
  }
  private async read(): Promise<State> {
    let input: string;
    try {input=await fs.readFile(this.path,"utf8");}
    catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return fixtureBill();throw e;}
    const raw=JSON.parse(input) as State;
    if (!raw || typeof raw!=="object" || !Number.isSafeInteger(raw.revision) || raw.revision<0 || !raw.payments || typeof raw.payments!=="object" || Array.isArray(raw.payments)) fail("invalid saved bill state",500);
    const bill=validateDraft(raw,raw.revision,raw.payments);
    for(const [guest,payment] of Object.entries(raw.payments)){
      if(!bill.guests.some(g=>g.id===guest) || !payment || typeof payment!=="object" || !Number.isSafeInteger(payment.amountCents) || !["creating","unknown_order","awaiting_approval","capture_unknown","captured","pending"].includes(payment.status) || typeof payment.requestId!=="string") fail("invalid saved payment",500);
    }
    return bill;
  }
  private async save(bill: State):Promise<void>{
    const dir=dirname(this.path);await fs.mkdir(dir,{recursive:true,mode:0o700});
    const temp=join(dir,"."+randomUUID()+".tmp");
    try{
      await fs.writeFile(temp,JSON.stringify(bill,null,2)+"\n",{encoding:"utf8",mode:0o600,flag:"wx"});
      await fs.rename(temp,this.path);
    }finally{await fs.rm(temp,{force:true}).catch(()=>{});}
  }
  async stageReceiptSource(data:Buffer,type:string):Promise<ReceiptSource>{
    return this.exclusive(async()=>{
      const bill=await this.read();
      if(Object.keys(bill.payments).length)fail("Payment requests exist. This receipt is locked.",409);
      const actual=data.subarray(0,3).equals(Buffer.from([255,216,255]))?"image/jpeg":
        data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?"image/png":
        data.toString("ascii",0,4)==="RIFF"&&data.toString("ascii",8,12)==="WEBP"?"image/webp":null;
      if(!actual||type!==actual||!data.length||data.length>20*1024*1024)fail("Choose a JPEG, PNG or WebP photo up to 20 MiB.");
      const id=createHash("sha256").update(data).digest("hex");
      const dir=this.path+".receipts";await fs.mkdir(dir,{recursive:true,mode:0o700});
      const temp=join(dir,"."+randomUUID()+".tmp");
      try{
        await fs.writeFile(temp,data,{mode:0o600,flag:"wx"});
        try{await fs.link(temp,join(dir,id));}catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;}
      }finally{await fs.rm(temp,{force:true});}
      return {id,type:actual,bytes:data.length};
    });
  }
  private async sourceBytes(source:ReceiptSource){
    let data:Buffer;try{data=await fs.readFile(join(this.path+".receipts",source.id));}catch{fail("Original receipt photo is missing. Import the photo again before saving.",409);}
    if(data.length!==source.bytes||createHash("sha256").update(data).digest("hex")!==source.id)fail("Original receipt photo could not be verified.",409);
    return data;
  }
  async receiptSource(id:string){
    return this.exclusive(async()=>{
      const bill=await this.read();const source=bill.receiptSources?.find(source=>source.id===id);
      if(!source)fail("Original receipt photo not found on this saved dinner.",404);
      return {source,data:await this.sourceBytes(source)};
    });
  }
  async state() {return this.exclusive(async()=>{const bill=await this.read();return {bill,paymentRetries:Object.fromEntries(Object.entries(bill.payments).map(([id,p])=>[id,paymentRetryAllowed(p)])),calculated:calculateBill(bill),aiReady:!!(process.env.TABLOOM_AI_MODEL&&process.env.TABLOOM_AI_URL),paypalReady:!!(process.env.TABLOOM_PAYPAL_CLIENT_ID&&process.env.TABLOOM_PAYPAL_CLIENT_SECRET),guestLinksReady:!!this.links?.acceptingInvitations,mode:"PayPal Sandbox only"};});}
  async updateDraft(raw:unknown,revision:unknown,guestResponse?:unknown,guestResponses?:unknown,guestFileResponses?:unknown){
    return this.exclusive(async()=>{
      const old=await this.read();
      if(revision!==old.revision) fail("Someone changed the table. Reload before saving.",409);
      if(Object.keys(old.payments).length) fail("Payment requests exist. Editing this bill is locked to prevent wrong-amount checkout.",409);
      let bill=validateDraft(raw,old.revision+1,{});
      if(guestResponse!==undefined&&guestResponses!==undefined)fail("Choose one guest review before saving.",409);
      if(guestFileResponses!==undefined&&(guestResponse!==undefined||guestResponses!==undefined))fail("Choose one guest review before saving.",409);
      const combined=guestResponses!==undefined;
      if(combined&&(!Array.isArray(guestResponses)||!guestResponses.length||guestResponses.length>old.guests.length)){
        fail("Choose received responses from one or more guests on this receipt.",409);
      }
      const identities:unknown[]=combined?guestResponses as unknown[]:guestResponse===undefined?[]:[guestResponse];
      const reviewed:{identity:unknown;guestId:string}[]=[];
      let unchangedConfirmation=false;
      if(identities.length){
        if(!this.links)fail("Guest links are not available. Review the receipt again.",409);
        const responses=identities.map(identity=>this.links!.reviewedForSave(this.tableId,identity));
        const preview=combined?previewGuestReviews(old,this.tableId,responses):previewGuestReview(old,this.tableId,responses[0]);
        const expected=validateDraft(preview.bill,old.revision+1,{});
        if(JSON.stringify(expected)!==JSON.stringify(bill))fail("The draft differs from the reviewed guest choices. Review the response again or save it as a separate receipt change.",409);
        unchangedConfirmation=preview.changes.length===0;
        responses.forEach((response,index)=>reviewed.push({identity:identities[index],guestId:(response as {guestId:string}).guestId}));
      }
      if(guestFileResponses!==undefined){
        if(!Array.isArray(guestFileResponses)||!guestFileResponses.length||guestFileResponses.length>old.guests.length)fail("Choose responses from this receipt.",409);
        const preview=guestFileResponses.length===1?previewGuestReview(old,this.tableId,guestFileResponses[0]):previewGuestReviews(old,this.tableId,guestFileResponses);
        const expected=validateDraft(preview.bill,old.revision+1,{});
        if(JSON.stringify(expected)!==JSON.stringify(bill))fail("The draft differs from the reviewed guest choices. Review the response again or save it as a separate receipt change.",409);
        unchangedConfirmation=preview.changes.length===0;
      }
      // Accepting unchanged reviewed choices does not create a new receipt.
      // Preserve other diners' current invitations only after the exact response
      // identities and reviewed draft have passed the checks above.
      if(unchangedConfirmation)bill=old;
      for(const source of bill.receiptSources??[])await this.sourceBytes(source);
      if(!unchangedConfirmation)await this.save(bill);
      for(const review of reviewed)await this.links!.recordSaved(this.tableId,review.identity,guestReviewPacket(bill,this.tableId,review.guestId));
      return {bill,calculated:calculateBill(bill)};
    });
  }
  async previewDraft(raw:unknown,revision:unknown){
    return this.exclusive(async()=>{
      const old=await this.read();
      if(revision!==old.revision)fail("The saved table changed. Reload before reviewing these totals.",409);
      const bill=validateDraft(raw,old.revision,{});
      return {revision:old.revision,calculated:calculateBill(bill)};
    });
  }
  async guestReview(guestId: unknown) { return this.exclusive(async()=>guestReviewPacket(await this.read(),this.tableId,guestId)); }
  async guestInvitation(guestId: unknown) { return this.exclusive(async()=>guestReviewPacket(await this.read(),this.tableId,guestId,true)); }
  async guestCheckout(guestId: unknown) { return this.exclusive(async()=>({...guestCheckoutPacket(await this.read(),this.tableId,guestId),paypalReady:!!(process.env.TABLOOM_PAYPAL_CLIENT_ID&&process.env.TABLOOM_PAYPAL_CLIENT_SECRET)})); }
  async reviewGuestResponse(response: unknown, accept?:()=>Promise<void>) {
    return this.exclusive(async()=>{
      const reviewed=previewGuestReview(await this.read(),this.tableId,response);
      // Commit a received reply before releasing the same lock used by new orders.
      await accept?.();
      return reviewed;
    });
  }
  async reviewGuestResponses(responses: unknown) { return this.exclusive(async()=>previewGuestReviews(await this.read(),this.tableId,responses)); }
  async suggest(rawDraft?:unknown,revision?:unknown,requestSignal?:AbortSignal){
    const bill=await this.exclusive(async()=>{
      const saved=await this.read();
      if(rawDraft===undefined)return saved;
      if(revision!==saved.revision)fail("The saved table changed. Reload before reviewing this draft.",409);
      if(Object.keys(saved.payments).length)fail("Payment requests exist. Draft review is locked.",409);
      return validateDraft(rawDraft,saved.revision,{},true);
    });
    if(!bill.items.length)fail("Add receipt items before asking for assignments.");
    const url=process.env.TABLOOM_AI_URL;
    const model=process.env.TABLOOM_AI_MODEL;
    const unresolved:SuggestedShare[]=bill.items.map(item=>({itemId:item.id,guestIds:[],reason:"Choose who shared this item."}));
    const grounded=constrainNoteExclusions(bill,unresolved);
    // Complete source facts need no model call; unresolved source facts remain editable.
    if(grounded.every((suggestion,index)=>suggestion!==unresolved[index]))return {revision:bill.revision,suggestions:grounded};
    if(!url||!model){
      if(grounded.some((suggestion,index)=>suggestion!==unresolved[index]))return {revision:bill.revision,suggestions:grounded};
      fail("Could not match these notes to the receipt. Use the exact dish and guest names, or choose who shared each item.",503);
    }
    let address:URL;
    try{address=new URL(url);}catch{fail("Invalid local AI URL",503);}
    if(address.protocol!=="http:"||!["localhost","127.0.0.1","[::1]"].includes(address.hostname))fail("AI must be a loopback Ollama-compatible service",503);
    if(address.pathname!=="/api/chat")fail("AI URL must end in /api/chat",503);
    const messages=[{role:"system",content:"You suggest which diner shared each receipt item. Use ONLY exact supplied guest IDs and item IDs. Never invent a person, item, amount or payment. Output JSON with one assignments entry for every item, each {itemId, guestIds, reason}. A shared item may have multiple guests. If ownership is unknown or uncertain, return an empty guestIds array and explain the uncertainty in the reason; never guess a payer; this is human-reviewed, not payment authority."},{role:"user",content:JSON.stringify({tableNote:bill.note,guests:bill.guests,items:bill.items.map(({id,name})=>({id,name}))})}];
    const format={type:"object",properties:{assignments:{type:"array",items:{type:"object",properties:{itemId:{type:"string",enum:bill.items.map(i=>i.id)},guestIds:{type:"array",items:{type:"string",enum:bill.guests.map(g=>g.id)}},reason:{type:"string",maxLength:240}},required:["itemId","guestIds","reason"],additionalProperties:false}}},required:["assignments"],additionalProperties:false};
    const controller=new AbortController();
    const signal=controller.signal;
    const stop=()=>controller.abort(new DOMException("Receipt review stopped","AbortError"));
    const deadline=setTimeout(()=>controller.abort(new DOMException("Receipt review timed out","TimeoutError")),90000);
    requestSignal?.addEventListener("abort",stop,{once:true});
    if(requestSignal?.aborted)stop();
    let raw:string;
    try{
      if(signal.aborted)throw signal.reason;
      const response=await this.fetcher(address.toString(),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({model,messages,format,stream:false,options:{temperature:0}}),signal});
      if(!response.ok)fail("The local model could not answer this time (HTTP "+response.status+").",502);
      raw=await response.text();
    }catch(error){
      if(requestSignal?.aborted)fail("Receipt review stopped.",499);
      if(signal.aborted || (error instanceof Error && error.name==="TimeoutError"))fail("Receipt review timed out. Try again or choose people yourself.",504);
      if(error instanceof ValidationError)throw error;
      fail("The local model could not be reached or its connection stopped.",502);
    }finally{
      clearTimeout(deadline);
      requestSignal?.removeEventListener("abort",stop);
    }
    if(raw.length>100000)fail("The local model returned a response too large to review.",502);
    let result:Record<string,any>;try{result=JSON.parse(raw);}catch{fail("The local model returned an unreadable response.",502);}
    const content=result.message?.content;
    if(typeof content!=="string")fail("The local model returned no assignments to review.",502);
    try{return {revision:bill.revision,suggestions:constrainNoteExclusions(bill,parseSuggestions(content,bill,true))};}
    catch(error){
      if(!(error instanceof ValidationError))throw error;
      if(error.message==="model used unknown/duplicate item" || error.message==="model must propose each item exactly once")
        fail("The local model repeated or mismatched receipt items, so its suggestions were not used.",502);
      fail("The local model returned assignments that could not be checked against this receipt.",502);
    }
  }
  async applySuggestions(revision:unknown,suggestions:SuggestedShare[],reviewedItemIds?:unknown) {
    return this.exclusive(async()=>{
      const old=await this.read();if(old.revision!==revision)fail("Bill changed. Recalculate your suggestions.",409);
      if(Object.keys(old.payments).length)fail("Bill already has payment requests",409);
      if(!Array.isArray(reviewedItemIds)||reviewedItemIds.length!==old.items.length||new Set(reviewedItemIds).size!==old.items.length||!old.items.every(i=>reviewedItemIds.includes(i.id)))fail("Review and confirm every item before applying suggestions.",400);
      const parsed=parseSuggestions(JSON.stringify({assignments:suggestions?.map(s=>({itemId:s.itemId,guestIds:s.guestIds,reason:s.reason}))}),old);
      const updated=structuredClone(old);
      for(const s of parsed){
        const item=updated.items.find(i=>i.id===s.itemId)!;
        if(item.sharedBy.length!==s.guestIds.length||item.sharedBy.some(id=>!s.guestIds.includes(id)))delete item.portions;
        item.sharedBy=s.guestIds;
      }
      updated.revision++;
      await this.save(updated);
      return {bill:updated,calculated:calculateBill(updated)};
    });
  }
  async checkPayPalConnection() { return checkPayPalSandboxConnection({fetch:this.fetcher}); }
  private credentials() {
    const key=process.env.TABLOOM_PAYPAL_CLIENT_ID?.trim(),secret=process.env.TABLOOM_PAYPAL_CLIENT_SECRET?.trim();
    if(!key||!secret)fail("PayPal Sandbox credentials are not configured",503);
    return {key,secret};
  }
  private async paypal(method:string,path:string,body?:unknown,requestId?:string,retryPayment?:Payment,beforeDispatch?:(appFingerprint:string)=>Promise<void>):Promise<any> {
    const {key,secret}=this.credentials();
    const base="https://api-m.sandbox.paypal.com";
    const tokenResp=await this.fetcher(base+"/v1/oauth2/token",{method:"POST",headers:{"authorization":"Basic "+Buffer.from(key+":"+secret).toString("base64"),"content-type":"application/x-www-form-urlencoded"},body:"grant_type=client_credentials",signal:AbortSignal.timeout(15000)});
    if(!tokenResp.ok)fail("PayPal Sandbox OAuth failed (HTTP "+tokenResp.status+")",502);
    const oauth=await tokenResp.json() as {access_token?:string};
    if(typeof oauth.access_token!=="string")fail("PayPal returned no access token",502);
    const headers:Record<string,string>={"authorization":"Bearer "+oauth.access_token,"content-type":"application/json"};
    // PayPal capture defaults to minimal output: request details before counting a guest paid.
    if(method==="POST" && path.endsWith("/capture"))headers["Prefer"]="return=representation";
    if(requestId)headers["PayPal-Request-Id"]=requestId;
    // OAuth consumes time too: eligibility at the button/API entry is not enough.
    if(retryPayment&&!paymentRetryAllowed(retryPayment))fail("The original payment request now needs organizer review before another attempt. Its history has been preserved.",409);
    if(beforeDispatch)await beforeDispatch(createHash("sha256").update("paypal-sandbox:"+key).digest("hex"));
    if(retryPayment&&!paymentRetryAllowed(retryPayment))fail("The original payment request now needs organizer review before another attempt. Its history has been preserved.",409);
    const result=await this.fetcher(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(PAYPAL_REQUEST_TIMEOUT_MS)});
    const raw=await result.text();if(raw.length>100000)fail("PayPal response too large",502);
    let data:any;try{data=JSON.parse(raw);}catch{fail("PayPal returned invalid JSON",502);}
    if(!result.ok&&method==="GET"&&/^\/v2\/checkout\/orders\/[^/]+$/.test(path)&&result.status===404&&data?.name==="RESOURCE_NOT_FOUND"){
      const error=new ValidationError("PayPal could not find this payment request. The organizer needs to review the original request and PayPal connection.") as HttpError;
      error.statusCode=502;error.providerFailureReason="not_found";throw error;
    }
    if(!result.ok)fail("PayPal Sandbox "+method+" failed (HTTP "+result.status+"; "+String(data?.name??"provider_error").slice(0,80)+")",502);
    // Accepted and mixed outcomes do not establish completion of this single-diner order.
    if(method==="POST" && path.endsWith("/capture") && result.status!==200 && result.status!==201)return {};
    return data;
  }
  private appFingerprint() {
    return createHash("sha256").update("paypal-sandbox:"+this.credentials().key).digest("hex");
  }
  private async assertPaymentContext(bill:Bill,guestId:string,payment:Payment) {
    if(payment.paypalAppFingerprint&&payment.paypalAppFingerprint!==this.appFingerprint()){
      payment.providerFailure={reason:"connection_changed",checkedAt:new Date().toISOString()};
      bill.payments[guestId]=payment;await this.save(bill);
      fail("The PayPal connection differs from this request's original app. Reconnect the original Sandbox app and check the original payment status.",409);
    }
    if(payment.paypalAppFingerprint&&!payment.orderId&&payment.providerFailure?.reason==="connection_changed"){
      // No order identity is available to GET. Restoring the original app permits
      // only the existing request's bounded idempotent retry, never a replacement.
      delete payment.providerFailure;bill.payments[guestId]=payment;await this.save(bill);
    }
  }
  private async observeOrder(bill:Bill,guestId:string,payment:Payment) {
    await this.assertPaymentContext(bill,guestId,payment);
    try{
      const order=await this.paypal("GET","/v2/checkout/orders/"+encodeURIComponent(payment.orderId!));
      const units=order?.purchase_units;
      if(order?.id!==payment.orderId || !Array.isArray(units) || units.length!==1 ||
        units[0]?.reference_id!==guestId || units[0]?.amount?.currency_code!=="USD" ||
        units[0]?.amount?.value!==money(payment.amountCents) ||
        !["CREATED","SAVED","APPROVED","VOIDED","COMPLETED","PAYER_ACTION_REQUIRED"].includes(order?.status)){
        const error=new ValidationError("PayPal returned a different or unreadable order. The original payment history is preserved.") as HttpError;
        error.statusCode=502;error.providerFailureReason="order_mismatch";throw error;
      }
      payment.providerStatus=order.status;payment.providerCheckedAt=new Date().toISOString();
      delete payment.providerFailure;
      // Save the verified observation and settlement decision together.
      bill.payments[guestId]=payment;
      return order;
    }catch(error){
      payment.providerFailure={reason:(error as HttpError).providerFailureReason??"unavailable",checkedAt:new Date().toISOString()};
      bill.payments[guestId]=payment;await this.save(bill);throw error;
    }
  }
  private due(bill:Bill,guestId:string):number{
    const due=calculateBill(bill).dues.find(d=>d.guestId===guestId);
    if(!due)fail("Unknown table guest");
    if(!due.totalCents)fail("This guest has no amount due");
    return due.totalCents;
  }
  async createOrder(guestId:string,revision:unknown,guestReturnUrl?:string) {
    return this.exclusive(async()=>{
      this.credentials();
      const bill=await this.read();if(bill.revision!==revision)fail("Bill changed; reload before requesting payment",409);
      const due=this.due(bill,guestId);
      let payment=bill.payments[guestId];
      if(!payment&&this.links?.hasPendingResponseChanges(this.tableId,bill.revision))
        fail("Review and save or dismiss the received guest replies before requesting payment.",409);
      if(payment?.status==="captured")return {payment};
      if(payment)await this.assertPaymentContext(bill,guestId,payment);
      if(payment?.providerFailure)fail("Check the original payment status before continuing. Its history has been preserved.",409);
      if(payment?.status==="awaiting_approval"||payment?.status==="pending"||payment?.status==="capture_unknown")return {payment};
      if(payment&&(payment.orderId||!paymentRetryAllowed(payment)))fail("This unresolved payment request needs organizer review before another attempt. Its original history has been preserved.",409);
      if(payment && payment.amountCents!==due)fail("Payment amount changed after request",409);
      const port=process.env.TABLOOM_PORT??"3000";
      const defaultReturnUrl="http://127.0.0.1:"+port+"/tabloom/?returned=1&table="+encodeURIComponent(this.tableId);
      if(!payment){payment={requestId:randomUUID(),paypalAppBindingPending:true,requestStartedAt:new Date().toISOString(),status:"creating",amountCents:due,returnUrl:guestReturnUrl??defaultReturnUrl};bill.payments[guestId]=payment;await this.save(bill);}
      // An uncertain create retries the original payload, even when a new guest link is opened.
      const returnUrl=payment.returnUrl??defaultReturnUrl;
      const request={intent:"CAPTURE",purchase_units:[{reference_id:guestId,amount:{currency_code:"USD",value:money(due)},description:"Tabloom · "+bill.title.slice(0,90)}],payment_source:{paypal:{experience_context:{return_url:returnUrl,cancel_url:returnUrl,user_action:"PAY_NOW"}}}};
      try{
        const order=await this.paypal("POST","/v2/checkout/orders",request,payment.requestId,payment,async fingerprint=>{
          if(payment.paypalAppBindingPending){
            payment.paypalAppFingerprint=fingerprint;delete payment.paypalAppBindingPending;
            bill.payments[guestId]=payment;await this.save(bill);
          }
        });
        if(typeof order.id!=="string"||!/^[A-Z0-9]{5,40}$/.test(order.id))fail("PayPal order identity is malformed",502);
        const link=Array.isArray(order.links)?order.links.find((x:any)=>x.rel==="payer-action"||x.rel==="approve"):null;
        if(!link||typeof link.href!=="string"||!/^https:\/\/(?:www\.)?sandbox\.paypal\.com\//.test(link.href))fail("PayPal returned no trusted Sandbox approval link",502);
        payment={...payment,status:"awaiting_approval",orderId:order.id,approvalUrl:link.href};
        bill.payments[guestId]=payment;await this.save(bill);
        return {payment};
      }catch(error){
        payment.status="unknown_order";bill.payments[guestId]=payment;await this.save(bill);
        throw error;
      }
    });
  }
  async capture(guestId:string) {
    return this.exclusive(async()=>{
      this.credentials();const bill=await this.read();let payment=bill.payments[guestId];
      if(!payment||!payment.orderId)fail("No PayPal approval request exists");
      if(payment.status==="captured")return {payment};
      await this.assertPaymentContext(bill,guestId,payment);
      if(payment.providerFailure)fail("Check the original payment status before completing it. The last provider check was unsuccessful.",409);
      if(payment.status==="pending")fail("Payment is pending; use Reconcile instead",409);
      if(payment.status!=="awaiting_approval"&&payment.status!=="capture_unknown")fail("Payment is not ready for capture",409);
      if(payment.status==="capture_unknown"&&!paymentRetryAllowed(payment))fail("This unresolved capture needs organizer review. Check the original payment status; do not start a replacement.",409);
      // An operator click alone is not buyer authorization: verify order ID, state,
      // reference and amount before posting the first capture.
      if(payment.status==="awaiting_approval"){
        const order=await this.observeOrder(bill,guestId,payment);
        const units=order?.purchase_units;
        if(order?.id!==payment.orderId || order?.status!=="APPROVED" ||
          !Array.isArray(units) || units.length!==1 ||
          units[0]?.reference_id!==guestId ||
          units[0]?.amount?.currency_code!=="USD" ||
          units[0]?.amount?.value!==money(payment.amountCents)){
          bill.payments[guestId]=payment;await this.save(bill);
          fail("PayPal buyer approval and exact amount have not been confirmed. Open the Sandbox buyer link and retry after approval.",409);
        }
      }
      if(!payment.captureRequestId){payment={...payment,status:"capture_unknown",captureStartedAt:new Date().toISOString(),captureRequestId:randomUUID()};bill.payments[guestId]=payment;await this.save(bill);}
      try{
        const result=await this.paypal("POST","/v2/checkout/orders/"+encodeURIComponent(payment.orderId!)+"/capture",{},payment.captureRequestId,payment);
        const verified=verifiedCapture(result,payment,guestId);
        if(verified){payment={...payment,status:"captured",captureId:verified.id};}
        else payment={...payment,status:"pending"};
        bill.payments[guestId]=payment;await this.save(bill);return {payment};
      }catch(error){payment.status="capture_unknown";bill.payments[guestId]=payment;await this.save(bill);throw error;}
    });
  }
  async reconcile(guestId:string){
    return this.exclusive(async()=>{
      this.credentials();const bill=await this.read();let payment=bill.payments[guestId];
      if(!payment||!payment.orderId)fail("No PayPal order exists to reconcile");
      if(payment.status==="captured")return {payment};
      const order=await this.observeOrder(bill,guestId,payment);
      const verified=verifiedCapture(order,payment,guestId);
      if(verified){payment={...payment,status:"captured",captureId:verified.id};}
      else if(payment.status==="capture_unknown"||payment.status==="pending"){
        const units=order?.purchase_units;
        const captures=units?.[0]?.payments?.captures;
        const exactApproved=order?.id===payment.orderId&&order?.status==="APPROVED"&&
          Array.isArray(units)&&units.length===1&&units[0]?.reference_id===guestId&&
          units[0]?.amount?.currency_code==="USD"&&units[0]?.amount?.value===money(payment.amountCents);
        // A GET with no capture does not establish failure. Keep the original request
        // available for a deliberate idempotent retry, rather than stranding the diner.
        const retryable=exactApproved&&payment.captureRequestId&&
          (captures===undefined||(Array.isArray(captures)&&captures.length===0));
        payment={...payment,status:retryable?"capture_unknown":"pending"};
      }
      bill.payments[guestId]=payment;await this.save(bill);return {payment};
    });
  }
}
async function receive(req:IncomingMessage,limit=128*1024):Promise<Record<string,unknown>> {
  let size=0;const parts:Buffer[]=[];
  for await(const chunk of req){const buf=Buffer.from(chunk);size+=buf.length;if(size>limit)fail("Request exceeded "+Math.floor(limit/1024)+" KiB",413);parts.push(buf);}
  let input:unknown;try{input=JSON.parse(Buffer.concat(parts).toString("utf8"));}catch{fail("Malformed JSON");}
  if(!input||typeof input!=="object"||Array.isArray(input))fail("Request must be a JSON object");
  return input as Record<string,unknown>;
}
function reply(res:ServerResponse,status:number,data:unknown){
  res.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"});
  res.end(JSON.stringify(data));
}
const mime:Record<string,string>={"share-math.js":"text/javascript; charset=utf-8","guest-identity.js":"text/javascript; charset=utf-8","draft-comparison.js":"text/javascript; charset=utf-8","receipt-intake.js":"text/javascript; charset=utf-8","receipt-reconciliation.js":"text/javascript; charset=utf-8","receipt-intake-view.js":"text/javascript; charset=utf-8","receipt-intake.css":"text/css; charset=utf-8","index.html":"text/html; charset=utf-8","style.css":"text/css; charset=utf-8","main.js":"text/javascript; charset=utf-8","guest-receipt.js":"text/javascript; charset=utf-8","guest-review.js":"text/javascript; charset=utf-8","guest-network.js":"text/javascript; charset=utf-8","guest-response-view.js":"text/javascript; charset=utf-8","guest-response-view.css":"text/css; charset=utf-8"};
Object.assign(mime,{"chat-intake.js":"text/javascript; charset=utf-8","chat-intake-view.js":"text/javascript; charset=utf-8","chat-intake.css":"text/css; charset=utf-8"}); // chat intake
Object.assign(mime,VOICE_ASSETS); // voice intake
mime["receipt-draft-store.js"]="text/javascript; charset=utf-8";
mime["receipt-ocr.js"]="text/javascript; charset=utf-8";
mime["receipt-photo-crop.js"]="text/javascript; charset=utf-8";
mime["receipt-photo-input.js"]="text/javascript; charset=utf-8";
for(const name of ["tesseract.min.js","worker.min.js",...["tesseract-core","tesseract-core-lstm","tesseract-core-simd","tesseract-core-simd-lstm","tesseract-core-relaxedsimd","tesseract-core-relaxedsimd-lstm"].map(core=>"core/"+core+".wasm.js")])mime["receipt-ocr/"+name]="text/javascript; charset=utf-8";
mime["receipt-ocr/lang/eng.traineddata.gz"]="application/gzip";
for(const name of ["ABOUT.txt","LICENSE-tesseract.js","LICENSE-tesseract.js-core"])mime["receipt-ocr/"+name]="text/plain; charset=utf-8";
export async function handleTabloom(req:IncomingMessage,res:ServerResponse,service:TabloomService):Promise<boolean>{
  const requestUrl=new URL(req.url??"/","http://local.invalid");
  const pathname=requestUrl.pathname;
  const collection=service;
  if(!pathname.startsWith("/tabloom"))return false;
  try{
    if(!isValidHost(req.headers.host??""))fail("Local-only browser host required",403);
    if(req.method==="GET"&&!pathname.startsWith("/tabloom/api/")){
      const asset=pathname==="/tabloom"||pathname==="/tabloom/"?"index.html":pathname.slice("/tabloom/".length);
      if(!Object.hasOwn(mime,asset))fail("Asset not found",404);
      const body=await fs.readFile(join(here,"..","tabloom",asset));
      res.writeHead(200,{"content-type":mime[asset],"cache-control":"no-store","x-content-type-options":"nosniff","content-security-policy":"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; base-uri 'none'; form-action 'self'; object-src 'none'; frame-ancestors 'none'"});
      res.end(body);return true;
    }
    if(req.method==="GET"&&pathname==="/tabloom/api/tables"){reply(res,200,await collection.tableList());return true;}
    if(req.method==="GET"&&pathname==="/tabloom/api/guest-network"){if(!collection.guestNetwork)fail("Guest network setup is unavailable in this installation.",503);reply(res,200,collection.guestNetwork.status());return true;}
    if(req.method==="GET"&&pathname==="/tabloom/api/receipt-reader"){reply(res,200,await receiptVisionReader.status());return true;}
    if(await handleVoice(req,res,pathname,requestUrl.searchParams))return true; // voice intake
    const tableId=requestUrl.searchParams.get("table") ?? LEGACY_TABLE;
    if(pathname!=="/tabloom/api/tables")service=await collection.table(tableId);
    if(req.method==="GET"&&pathname==="/tabloom/api/guest-links"){const state=await service.state();reply(res,200,{links:service.links?.list(service.tableId,state.bill.revision)??[],groups:service.links?.groupList(service.tableId,state.bill.revision)??[]});return true;}
    if(req.method==="GET"&&pathname==="/tabloom/api/state"){reply(res,200,{...await service.state(),tableId});return true;}
    if(req.method==="GET"&&pathname==="/tabloom/api/receipt-source"){
      const {source,data}=await service.receiptSource(requestUrl.searchParams.get("id")??"");
      res.writeHead(200,{"content-type":source.type,"content-length":data.length,"cache-control":"no-store","x-content-type-options":"nosniff","content-security-policy":"default-src 'none'; frame-ancestors 'none'","content-disposition":"inline; filename=receipt."+({"image/jpeg":"jpg","image/png":"png","image/webp":"webp"}[source.type])});
      res.end(data);return true;
    }
    if(req.method!=="POST")fail("Route not found",404);
    const origin=req.headers.origin;
    if(origin&&origin!=="http://"+req.headers.host)fail("Origin mismatch",403);
    if(pathname==="/tabloom/api/receipt-source"){
      let size=0;const parts:Buffer[]=[];
      for await(const chunk of req){const part=Buffer.from(chunk);size+=part.length;if(size>20*1024*1024)fail("Photo exceeded 20 MiB",413);parts.push(part);}
      reply(res,200,await service.stageReceiptSource(Buffer.concat(parts),req.headers["content-type"]?.split(";")[0].trim()??""));return true;
    }
    if(req.headers["content-type"]?.split(";")[0].trim()!=="application/json")fail("JSON content type required",415);
    const body=await receive(req,pathname==="/tabloom/api/receipt-reader"?RECEIPT_VISION_BODY_LIMIT:128*1024);
    let result:unknown;
    if(pathname==="/tabloom/api/guest-network/start"||pathname==="/tabloom/api/guest-network/stop"){
      if(!collection.guestNetwork)fail("Guest network setup is unavailable in this installation.",503);
      result=pathname.endsWith("/start")?await collection.guestNetwork.start(body.address):await collection.guestNetwork.stop();
    }
    else if(pathname==="/tabloom/api/tables")result=await collection.createTable(body.tableId,body.details);
    else if(pathname==="/tabloom/api/bill")result=await service.updateDraft(body.bill,body.revision,body.guestResponse,body.guestResponses,body.guestFileResponses);
    else if(pathname==="/tabloom/api/paypal/check")result=await service.checkPayPalConnection();
    else if(pathname.startsWith("/tabloom/api/guest-links/")){
      if(!service.links)fail("Enable guest invitations in the organizer before sharing a link.",503);
      if(pathname==="/tabloom/api/guest-links/create")result=await service.links.create(service,body.guestId);
      else if(pathname==="/tabloom/api/guest-links/create-group")result=await service.links.createGroup(service);
      else if(pathname==="/tabloom/api/guest-links/revoke-group")result=await service.links.revokeGroup(service.tableId,body.id);
      else if(pathname==="/tabloom/api/guest-links/revoke")result=await service.links.revoke(service.tableId,body.id,body.discardResponseId);
      else if(pathname==="/tabloom/api/guest-links/response")result={response:service.links.response(service.tableId,body.id),identity:service.links.reviewIdentity(service.tableId,body.id)};
      else if(pathname==="/tabloom/api/guest-links/responses"){
        if(!Array.isArray(body.ids)||!body.ids.length||body.ids.length>12)fail("Select the guest responses to review.");
        const choices=body.ids.map((id:unknown)=>({response:service.links!.response(service.tableId,id),identity:service.links!.reviewIdentity(service.tableId,id)}));
        result={responses:choices.map((choice:any)=>choice.response),identities:choices.map((choice:any)=>choice.identity)};
      }
      else fail("Route not found",404);
    }
    else if(pathname==="/tabloom/api/bill/preview")result=await service.previewDraft(body.bill,body.revision);
    else if(pathname==="/tabloom/api/guest-review/export")result=await service.guestReview(body.guestId);
    else if(pathname==="/tabloom/api/guest-review/preview")result=await service.reviewGuestResponse(body.response);
    else if(pathname==="/tabloom/api/guest-review/preview-many")result=await service.reviewGuestResponses(body.responses);
    else if(pathname==="/tabloom/api/receipt-reader"){
      const controller=new AbortController();
      const stop=()=>{if(!res.writableEnded)controller.abort();};
      res.once("close",stop);
      try{result=await receiptVisionReader.read(body.image,controller.signal);}
      catch(error){if(controller.signal.aborted&&res.destroyed)return true;throw error;}
      finally{res.removeListener("close",stop);}
    }
    else if(pathname==="/tabloom/api/suggest"){
      const requestController=new AbortController();
      const stop=()=>{if(!res.writableEnded)requestController.abort();};
      res.once("close",stop);
      try{result=await service.suggest(body.bill,body.revision,requestController.signal);}
      catch(error){if(requestController.signal.aborted&&res.destroyed)return true;throw error;}
      finally{res.removeListener("close",stop);}
    }
    else if(pathname==="/tabloom/api/suggest/apply")result=await service.applySuggestions(body.revision,body.suggestions as SuggestedShare[],body.reviewedItemIds);
    else{
      const match=/^\/tabloom\/api\/payments\/([a-zA-Z0-9_-]{1,48})\/(order|capture|reconcile)$/.exec(pathname);
      if(!match)fail("Route not found",404);
      result=match[2]==="order"?(service.links?.acceptingInvitations?await service.links.requestPayment(service,match[1],body.revision):await service.createOrder(match[1],body.revision)):match[2]==="capture"?await service.capture(match[1]):await service.reconcile(match[1]);
    }
    reply(res,200,result);return true;
  }catch(e){
    const err=e as HttpError;
    const status=err instanceof ReceiptVisionError?err.status:err instanceof ValidationError?err.statusCode??400:502;
    reply(res,status,{error:err instanceof ValidationError||err instanceof ReceiptVisionError?err.message:"The service failed. Your saved table was not automatically approved or charged."});return true;
  }
}

