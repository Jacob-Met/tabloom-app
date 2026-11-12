import QRCode from "qrcode";
import {renderGuestInvitationUnavailable} from "./tabloom-guest-unavailable.js";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { TabloomService } from "./tabloom-service.js";
import { ValidationError } from "./errors.js";
import { guestReviewFingerprint as fingerprint } from "./tabloom-guest-review.js";
type Packet = Awaited<ReturnType<TabloomService["guestReview"]>>;
type Session = {id:string;qr:string;service:TabloomService;packet:Packet;expiresAt:number;reviewOnly?:boolean;stopped?:boolean;response?:unknown;submittedAt?:string;responseId?:string;saved?:{packet:Packet;at:string}};

type GroupSession={id:string;qr:string;service:TabloomService;title:string;fingerprint:string;expiresAt:number;members:string[]};
function sessionRow(s:Session){
  const {service,qr,...rest}=s;
  if(s.reviewOnly){const {packet,...other}=rest;return {...other,kind:"table-review-child",reviewPacket:packet,tableId:service.tableId};}
  return {...rest,tableId:service.tableId};
}
function groupRow(g:GroupSession){const {service,qr,...rest}=g;return {...rest,kind:"table-review-entry",tableId:service.tableId};}

const lifetime=2*60*60*1000;
function duplicateDisplayName(guests:{name:string}[]){
 const seen=new Set<string>();
 return guests.find(guest=>{const name=guest.name.normalize("NFKC").trim().replace(/\s+/g," ").toLocaleLowerCase("en-US");if(seen.has(name))return true;seen.add(name);return false;});
}

function json(res:ServerResponse,status:number,body:unknown){res.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store","referrer-policy":"no-referrer","x-content-type-options":"nosniff"});res.end(JSON.stringify(body));}
async function bodyJson(req:IncomingMessage) {
  let size=0;const chunks:Buffer[]=[];
  for await(const raw of req){const chunk=Buffer.from(raw);size+=chunk.length;if(size>128*1024)throw Object.assign(new ValidationError("The guest request is too large."),{statusCode:413});chunks.push(chunk);}
  try {
    const body=JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if(!body||typeof body!=="object"||Array.isArray(body))throw new Error("object required");
    return body;
  } catch { throw new ValidationError("The guest request was not readable."); }
}
async function unavailableCheckout(res:ServerResponse,status:number){
  const renderer=await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)),"..","tabloom","guest-checkout.js")).href);
  res.writeHead(status,{"content-type":"text/html; charset=utf-8","cache-control":"no-store","referrer-policy":"no-referrer","x-content-type-options":"nosniff","x-frame-options":"DENY"});
  res.end(renderer.renderGuestCheckoutUnavailable());
}
function invitationUnavailable(res:ServerResponse,status:number,reason:"changed"|"expired"|"unavailable"|"names"){
 res.writeHead(status,{"content-type":"text/html; charset=utf-8","cache-control":"no-store","referrer-policy":"no-referrer","x-content-type-options":"nosniff","x-frame-options":"DENY"});
 res.end(renderGuestInvitationUnavailable(reason));
}
export class TabloomGuestLinks {
  private sessions=new Map<string,Session>();
  private groups=new Map<string,GroupSession>();
  acceptingInvitations=true;
  stopInvitations(){
    this.acceptingInvitations=false;this.groups.clear();
    for(const [id,s] of this.sessions){if(s.response&&!s.saved)s.stopped=true;else this.sessions.delete(id);}
  }
  private onChange?: (rows:unknown[])=>Promise<void>;
  setOnChange(fn:(rows:unknown[])=>Promise<void>){this.onChange=fn;}
  snapshot(){return [...[...this.sessions.values()].filter(s=>(!!s.response&&!s.saved)||(!s.stopped&&s.expiresAt>Date.now())).map(sessionRow),...[...this.groups.values()].filter(g=>g.expiresAt>Date.now()).map(groupRow)];}
  private changeTail:Promise<void>=Promise.resolve();
  private async withChange(action:()=>Promise<void>){
    const previous=this.changeTail;let release!:()=>void;
    this.changeTail=new Promise<void>(resolve=>release=resolve);
    await previous;try{await action();}finally{release();}
  }
  private async changed(){await this.withChange(async()=>{await this.onChange?.(this.snapshot());});}
  private async retainSession(s:Session,changes:Partial<Pick<Session,"response"|"responseId"|"submittedAt"|"saved">>){
    await this.withChange(async()=>{
    const next={...s,...changes};
    const rows:unknown[]=[...this.sessions.values()].map(row=>row===s?next:row)
      .filter(row=>(!!row.response&&!row.saved)||(!row.stopped&&row.expiresAt>Date.now()))
      .map(sessionRow);
    rows.push(...[...this.groups.values()].filter(g=>g.expiresAt>Date.now()).map(groupRow));
    await this.onChange?.(rows);
    if(this.sessions.get(s.id)===s)Object.assign(s,changes);
    });
  }
  async restore(rows:unknown[],resolveTable:(id:string)=>Promise<TabloomService>){
    const restored=new Map<string,Session>();
    for(const raw of rows){
      const original=raw as any;
      const r=original?.kind==="table-review-child"?{...original,packet:original.reviewPacket,reviewOnly:true}:original;
      if(!r||typeof r.id!=="string"||!/^[a-f0-9]{48}$/.test(r.id)||typeof r.tableId!=="string"||!Number.isFinite(r.expiresAt)||(r.expiresAt<=Date.now()&&!(r.response&&!r.saved))||r.expiresAt>Date.now()+lifetime||!r.packet||r.packet.tableId!==r.tableId||typeof r.packet.guestId!=="string"||typeof r.packet.fingerprint!=="string")continue;
      if(r.responseId!==undefined&&(typeof r.responseId!=="string"||!/^[a-f0-9]{32}$/.test(r.responseId)))continue;
      if(r.saved&&(!r.saved.packet||r.saved.packet.tableId!==r.tableId||r.saved.packet.guestId!==r.packet.guestId||typeof r.saved.at!=="string"||!r.responseId))continue;
      try{
        const service=await resolveTable(r.tableId);
        const qr=await QRCode.toDataURL(this.baseUrl+"/guest/"+r.id,{errorCorrectionLevel:"M",margin:4,scale:6});
        restored.set(r.id,{id:r.id,qr,service,packet:r.packet,expiresAt:r.expiresAt,stopped:r.stopped===true,reviewOnly:original?.kind==="table-review-child",...(r.response?{response:r.response}:{}),...(r.submittedAt?{submittedAt:r.submittedAt}:{}),...(r.responseId?{responseId:r.responseId}:{}),...(r.saved?{saved:r.saved}:{})});
      }catch{}
      if(restored.size>=100)break;
    }
    this.sessions=restored;this.groups.clear();
    for(const raw of rows){
      const g=raw as any;
      if(g?.kind!=="table-review-entry"||typeof g.id!=="string"||!/^[a-f0-9]{48}$/.test(g.id)||typeof g.tableId!=="string"||typeof g.title!=="string"||g.title.length>100||typeof g.fingerprint!=="string"||!Number.isFinite(g.expiresAt)||g.expiresAt<=Date.now()||g.expiresAt>Date.now()+lifetime||!Array.isArray(g.members)||!g.members.length||g.members.length>12)continue;
      if(!g.members.every((id:unknown)=>typeof id==="string"&&restored.get(id)?.reviewOnly&&restored.get(id)?.service.tableId===g.tableId))continue;
      if(this.sessions.size+this.groups.size>=100)break;
      const service=restored.get(g.members[0])!.service;
      const qr=await QRCode.toDataURL(this.baseUrl+"/join/"+g.id,{errorCorrectionLevel:"M",margin:4,scale:6});
      this.groups.set(g.id,{id:g.id,qr,service,title:g.title,fingerprint:g.fingerprint,expiresAt:g.expiresAt,members:g.members});
    }
  }
  async revokeAll(){this.sessions.clear();this.groups.clear();await this.changed();}
  constructor(readonly baseUrl:string) {}
  async create(service:TabloomService,guestId:unknown){
    if(!this.acceptingInvitations)throw new ValidationError("Start guest invitations before creating a new link.");
    const packet=await service.guestInvitation(guestId);
    if(!this.acceptingInvitations)throw new ValidationError("Guest invitations were stopped.");
    if([...this.sessions.values()].some(s=>(s.stopped||s.expiresAt<=Date.now())&&s.response&&!s.saved&&s.service.tableId===service.tableId&&s.packet.guestId===guestId))
      throw new ValidationError("Review or dismiss this guest's received reply before inviting them again.");
    for(const [id,s] of this.sessions)if(s.expiresAt<=Date.now()&&!(s.response&&!s.saved))this.sessions.delete(id);
    let session=[...this.sessions.values()].find(s=>!s.reviewOnly&&!s.stopped&&s.expiresAt>Date.now()&&s.service.tableId===service.tableId&&s.packet.guestId===guestId&&(s.saved?.packet??s.packet).fingerprint===packet.fingerprint);
    if(!session){
      if(this.sessions.size+this.groups.size>=100)throw new ValidationError("Stop an older guest link before opening another.");
      const id=randomBytes(24).toString("hex");
      const qr=await QRCode.toDataURL(this.baseUrl+"/guest/"+id,{errorCorrectionLevel:"M",margin:4,scale:6});
      if(!this.acceptingInvitations)throw new ValidationError("Guest invitations were stopped.");
      session={id,qr,service,packet,expiresAt:Date.now()+lifetime};this.sessions.set(session.id,session);
    }
    await this.changed();
    return {...this.summary(session),checkoutUrl:this.baseUrl+"/guest/"+session.id+"/checkout"};
  }

  private groupSummary(g:GroupSession){return {id:g.id,title:g.title,url:this.baseUrl+"/join/"+g.id,qr:g.qr,guestCount:g.members.length,revision:this.sessions.get(g.members[0])?.packet.revision,expiresAt:new Date(g.expiresAt).toISOString()};}
  groupList(tableId:string,revision?:number){return [...this.groups.values()].filter(g=>g.service.tableId===tableId&&g.expiresAt>Date.now()&&(revision===undefined||this.sessions.get(g.members[0])?.packet.revision===revision)).map(g=>this.groupSummary(g));}
  async createGroup(service:TabloomService){
    if(!this.acceptingInvitations)throw new ValidationError("Enable guest invitations before sharing this table.");
    const state=await service.state();
    if(Object.keys(state.bill.payments).length)throw new ValidationError("Use individual payment invitations after requesting payments.");
    const duplicate=duplicateDisplayName(state.bill.guests);
    if(duplicate)throw new ValidationError('Give each diner a distinct name before sharing the table. Add a surname or nickname to "'+duplicate.name+'", then Save the receipt.');
    if([...this.sessions.values()].some(s=>(s.stopped||s.expiresAt<=Date.now())&&s.response&&!s.saved&&s.service.tableId===service.tableId))throw new ValidationError("Review or dismiss retained guest replies before sharing this table again.");
    const current=fingerprint(state.bill,service.tableId);
    const existing=[...this.groups.values()].find(g=>g.service.tableId===service.tableId&&g.fingerprint===current&&g.expiresAt>Date.now()&&g.members.every(id=>{const s=this.sessions.get(id);return s?.reviewOnly&&!s.stopped&&s.expiresAt>Date.now();}));
    if(existing)return this.groupSummary(existing);
    // An explicit re-share can refresh the posted table entry without reviving stopped access.
    // Keep its original lifetime and diner scope; individual reply sessions remain immutable.
    const reusable=[...this.groups.values()].find(g=>g.service.tableId===service.tableId&&g.expiresAt>Date.now()&&
      g.members.length===state.bill.guests.length&&g.members.every(id=>{const member=this.sessions.get(id);return member?.reviewOnly&&!member.stopped&&member.expiresAt>Date.now()&&state.bill.guests.some(guest=>guest.id===member.packet.guestId&&guest.name===member.packet.guestName);}));
    const expiresAt=reusable?.expiresAt??Date.now()+lifetime,children:Session[]=[];
    for(const guest of state.bill.guests){
      const packet=await service.guestInvitation(guest.id);
      if(packet.fingerprint!==current)throw new ValidationError("The receipt changed. Open its current shares before inviting the table.");
      const id=randomBytes(24).toString("hex");
      const qr=await QRCode.toDataURL(this.baseUrl+"/guest/"+id,{errorCorrectionLevel:"M",margin:4,scale:6});
      children.push({id,qr,service,packet,expiresAt,reviewOnly:true});
    }
    const id=reusable?.id??randomBytes(24).toString("hex"),qr=reusable?.qr??await QRCode.toDataURL(this.baseUrl+"/join/"+id,{errorCorrectionLevel:"M",margin:4,scale:6});
    const group:GroupSession={id,qr,service,title:state.bill.title,fingerprint:current,expiresAt,members:children.map(s=>s.id)};
    await this.withChange(async()=>{
      if(!this.acceptingInvitations)throw new ValidationError("Guest invitations were stopped.");
      if(reusable&&(this.groups.get(reusable.id)!==reusable||reusable.expiresAt<=Date.now()||reusable.members.some(id=>{const member=this.sessions.get(id);return !member||member.stopped||member.expiresAt<=Date.now();})))throw new ValidationError("The table invitation changed. Open its current shares before inviting the table.");
      if(this.sessions.size+this.groups.size+children.length+(reusable?0:1)>100)throw new ValidationError("Stop older invitations before sharing another table.");
      const latest=await service.state();
      if(fingerprint(latest.bill,service.tableId)!==current||Object.keys(latest.bill.payments).length)throw new ValidationError("The receipt changed. Open its current shares before inviting the table.");
      const obsolete=[...this.groups.values()].filter(g=>g.expiresAt<=Date.now()||g.service.tableId===service.tableId&&g.fingerprint!==current).map(g=>g.id);
      const rows=[...this.snapshot().filter(row=>!("kind" in row&&row.kind==="table-review-entry"&&obsolete.includes(row.id))),...children.map(s=>sessionRow(s)),groupRow(group)];
      await this.onChange?.(rows);
      if(!this.acceptingInvitations)throw new ValidationError("Guest invitations were stopped.");
      if(reusable&&(this.groups.get(reusable.id)!==reusable||reusable.members.some(id=>{const member=this.sessions.get(id);return !member||member.stopped;})))throw new ValidationError("The table invitation was stopped. Share the current receipt again when ready.");
      for(const old of obsolete)this.groups.delete(old);
      for(const child of children)this.sessions.set(child.id,child);
      this.groups.set(group.id,group);
    });
    return this.groupSummary(group);
  }
  async revokeGroup(tableId:string,id:unknown){
    const group=typeof id==="string"?this.groups.get(id):undefined;
    if(!group||group.service.tableId!==tableId)throw new ValidationError("That table invitation is no longer available.");
    for(const member of group.members){const s=this.sessions.get(member);if(!s)continue;if(s.response&&!s.saved)s.stopped=true;else this.sessions.delete(member);}
    this.groups.delete(group.id);await this.changed();return {stopped:true};
  }
  private tableJoinUrl(s:Session,current:string){
    if(!s.reviewOnly)return undefined;
    const group=[...this.groups.values()].find(g=>g.members.includes(s.id)&&g.fingerprint===current&&g.expiresAt>Date.now());
    return this.acceptingInvitations&&!s.stopped&&group?this.baseUrl+"/join/"+group.id:null;
  }
  private async showGroup(req:IncomingMessage,res:ServerResponse,id:string){
    if(req.method!=="GET"){json(res,405,{error:"Open the table invitation to choose your name."});return;}
    const group=this.groups.get(id);
    if(!group||!this.acceptingInvitations||group.expiresAt<=Date.now()){invitationUnavailable(res,410,"unavailable");return;}
    const state=await group.service.state();
    if(!this.acceptingInvitations||this.groups.get(id)!==group||group.expiresAt<=Date.now()){invitationUnavailable(res,410,"unavailable");return;}
    if(fingerprint(state.bill,group.service.tableId)!==group.fingerprint||Object.keys(state.bill.payments).length){invitationUnavailable(res,409,"changed");return;}
    const members=group.members.map(id=>this.sessions.get(id)).filter((s):s is Session=>!!s&&!!s.reviewOnly&&!s.stopped&&s.expiresAt>Date.now());
    if(duplicateDisplayName(members.map(s=>({name:s.packet.guestName})))){invitationUnavailable(res,409,"names");return;}
    const esc=(v:string)=>v.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
    const html='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>Join '+esc(group.title)+' · Tabloom</title><style>body{margin:0;color:#102858;background:#fff;font:16px Arial,sans-serif}header{background:#ff5925;padding:20px 24px;font-size:24px;font-weight:800}main{max-width:600px;margin:auto;padding:28px 22px}h1{font-size:28px;line-height:1.15;margin:0 0 10px}p{line-height:1.5}nav{display:grid;gap:12px;margin:28px 0}a{display:flex;justify-content:space-between;gap:16px;padding:20px 16px;border:1px solid #1b39d1;color:#102858;text-decoration:none;font-weight:700;overflow-wrap:anywhere}a:focus-visible{outline:3px solid #ff5925;outline-offset:3px}.tag{font-size:12px;color:#63728e;text-transform:uppercase;letter-spacing:.08em}.foot{color:#63728e;font-size:14px}</style></head><body><header>TABLOOM</header><main><p class="tag">Join this table</p><h1>'+esc(group.title)+'</h1><p>Choose your name to review what you had.</p><nav aria-label="Choose your name">'+members.map(s=>'<a href="/guest/'+s.id+'"><span>'+esc(s.packet.guestName)+'</span><span aria-hidden="true">→</span></a>').join('')+'</nav></main></body></html>';
    res.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store","referrer-policy":"no-referrer","x-content-type-options":"nosniff","x-frame-options":"DENY","content-security-policy":"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"});res.end(html);
  }

  private responseChanged(s:Session){
    if(!s.response||s.saved)return false;
    const items=(s.response as {items?:{id:string;selected:boolean}[]}).items;
    return !Array.isArray(items)||items.length!==s.packet.items.length||
      s.packet.items.some(item=>items.find(answer=>answer.id===item.id)?.selected!==item.selected);
  }
  private summary(s:Session){const url=this.baseUrl+"/guest/"+s.id;return {id:s.id,stopped:!!s.stopped||!this.acceptingInvitations,qr:s.qr,guestId:s.packet.guestId,guest:s.packet.guestName,revision:s.packet.revision,url,checkoutUrl:s.reviewOnly?null:url+"/checkout",reviewOnly:!!s.reviewOnly,expiresAt:new Date(s.expiresAt).toISOString(),submittedAt:s.submittedAt??null,responseId:s.responseId??null,responseChanged:this.responseChanged(s),savedAt:s.saved?.at??null,savedRevision:s.saved?.packet.revision??null};}
  list(tableId:string,revision:number){return [...this.sessions.values()].filter(s=>s.service.tableId===tableId).map(s=>({...this.summary(s),expired:s.expiresAt<=Date.now(),stale:(s.saved?.packet??s.packet).revision!==revision}));}
  hasPendingResponseChanges(tableId:string,revision:number){
    return [...this.sessions.values()].some(s=>s.service.tableId===tableId&&s.packet.revision===revision&&this.responseChanged(s));
  }
  async revoke(tableId:string,id:unknown,discardResponseId?:unknown){
    const s=typeof id==="string"?this.sessions.get(id):undefined;
    if(!s||s.service.tableId!==tableId)throw new ValidationError("That guest link is no longer available.");
    if(discardResponseId!==undefined){
      if(typeof discardResponseId!=="string"||!s.response||s.saved||(!s.stopped&&this.acceptingInvitations)||s.responseId!==discardResponseId)
        throw new ValidationError("The received reply changed. Refresh it before dismissing.");
      this.sessions.delete(s.id);
    }else if(s.response&&!s.saved){
      // Stop closes access; only a separate, version-bound dismissal discards a reply.
      s.stopped=true;
    }else this.sessions.delete(s.id);
    for(const [groupId,g] of this.groups){g.members=g.members.filter(id=>id!==s.id);if(!g.members.length)this.groups.delete(groupId);}
    await this.changed();
    return {stopped:true,replyRetained:this.sessions.has(s.id)&&!!s.response&&!s.saved};
  }
  response(tableId:string,id:unknown){const s=typeof id==="string"?this.sessions.get(id):undefined;if(!s||s.service.tableId!==tableId)throw new ValidationError("That guest link expired or was stopped.");if(!s.response)throw new ValidationError("This guest has not sent an item response yet.");return s.response;}

  reviewIdentity(tableId:string,id:unknown){this.response(tableId,id);const s=this.sessions.get(id as string)!;return {id:s.id,responseId:s.responseId!};}
  reviewedForSave(tableId:string,identity:unknown){
    const key=identity as {id?:unknown;responseId?:unknown}|null;
    if(!key||typeof key.id!=="string"||typeof key.responseId!=="string")throw new ValidationError("Review the guest response again before saving.");
    const response=this.response(tableId,key.id),s=this.sessions.get(key.id)!;
    if(s.saved||s.responseId!==key.responseId)throw new ValidationError("The guest response changed. Review the latest choices before saving.");
    return response;
  }
  async recordSaved(tableId:string,identity:unknown,packet:Packet){
    const key=identity as {id:string;responseId:string};const s=this.sessions.get(key.id);
    if(!s||s.service.tableId!==tableId||s.responseId!==key.responseId)return;
    const saved={packet,at:new Date().toISOString()};
    // Publish the outcome only after its durable snapshot is accepted.
    try{await this.retainSession(s,{saved});}
    catch{throw new ValidationError("The guest confirmation could not be saved. Check this computer’s storage, then review the reply again.");}
  }

  /** Only the organizer's existing request-payment action starts an order. */
  async requestPayment(service:TabloomService,guestId:string,revision:unknown) {
    const invitation=await this.create(service,guestId);
    const result=await service.createOrder(guestId,revision,invitation.checkoutUrl+"?returned=1");
    return {...result,checkoutUrl:invitation.checkoutUrl};
  }
  private async checkout(s:Session) {
    const packet=await s.service.guestCheckout(s.packet.guestId);
    return {...packet,checkoutUrl:this.baseUrl+"/guest/"+s.id+"/checkout",
      reviewUrl:this.baseUrl+"/guest/"+s.id,expiresAt:new Date(s.expiresAt).toISOString()};
  }
  async handle(req:IncomingMessage,res:ServerResponse){
    const url=new URL(req.url??"/",this.baseUrl);
    if(req.headers.host!==new URL(this.baseUrl).host){json(res,404,{error:"Guest link not found."});return;}
    const group=/^\/join\/([a-f0-9]{48})$/.exec(url.pathname);
    if(group){try{await this.showGroup(req,res,group[1]);}catch{json(res,503,{error:"Could not open this table. Try the invitation again."});}return;}
    const match=/^\/guest\/([a-f0-9]{48})(?:\/(response|preview|review-state|checkout)(?:\/(state|order|capture|reconcile))?)?$/.exec(url.pathname);
    if(req.headers.host!==new URL(this.baseUrl).host||!match||(match[2]!=="checkout"&&match[3])){json(res,404,{error:"Guest link not found."});return;}
    const s=this.sessions.get(match[1]);
    if(!s||s.stopped||!this.acceptingInvitations||s.expiresAt<=Date.now()){if(req.method==="GET"&&!match[2]&&req.headers.accept?.includes("text/html"))invitationUnavailable(res,410,s&&!s.stopped&&this.acceptingInvitations?"expired":"unavailable");else if(req.method==="GET"&&match[2]==="checkout"&&!match[3])await unavailableCheckout(res,410);else json(res,410,{error:"This guest link expired or was stopped. Ask the organizer for a new link."});return;}
    if(s.reviewOnly&&match[2]==="checkout"){json(res,404,{error:"Payment links are sent separately by the organizer."});return;}
    try{
      if(req.method==="GET"&&match[2]==="review-state"){
        const observedSave=s.saved;
        const bill=(await s.service.state()).bill;
        if(!this.acceptingInvitations||s.stopped||this.sessions.get(s.id)!==s||s.expiresAt<=Date.now()){json(res,410,{error:"This guest link expired or was stopped."});return;}
        if(s.saved!==observedSave){json(res,200,{state:"pending"});return;}
        if(s.saved){json(res,200,{state:"saved",current:fingerprint(bill,s.service.tableId)===s.saved.packet.fingerprint,totalCents:s.saved.packet.totalCents,revision:s.saved.packet.revision,submittedAt:s.submittedAt,responseItems:(s.response as {items?:unknown}|undefined)?.items});return;}
        const state=fingerprint(bill,s.service.tableId)===s.packet.fingerprint?"pending":"changed";
        json(res,200,{state,...(state==="pending"&&url.searchParams.get("receipt")==="1"?{submittedAt:s.submittedAt??null,responseItems:(s.response as {items?:unknown}|undefined)?.items??null}:{})});return;
      }
      const isReview=!match[2];
      if(s.saved&&(isReview||match[2]==="response"||match[2]==="preview")){
        if(req.method!=="GET"||!isReview){json(res,409,{error:"The organizer already saved these choices. Ask for a new link to suggest another change."});return;}
        const current=fingerprint((await s.service.state()).bill,s.service.tableId)===s.saved.packet.fingerprint;
        const renderer=await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)),"..","tabloom","guest-review.js")).href);
        const checkoutUrl=current&&!s.reviewOnly?this.baseUrl+"/guest/"+s.id+"/checkout":null;
        const html=renderer.renderGuestOutcome({...s.saved.packet,reviewOnly:!!s.reviewOnly,savedAt:s.saved.at,current,checkoutUrl,tableJoinUrl:null,recoveryPacket:{...s.packet,live:true,tableJoinUrl:null,expiresAt:new Date(s.expiresAt).toISOString(),submittedAt:s.submittedAt??null,responseItems:(s.response as {items?:unknown}|undefined)?.items??null}});
        res.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store","referrer-policy":"no-referrer","x-content-type-options":"nosniff","x-frame-options":"DENY"});res.end(html);return;
      }
      const current=await this.checkout(s);
      if(!this.acceptingInvitations||s.stopped||this.sessions.get(s.id)!==s)throw new ValidationError("This guest link was stopped.");
      const receiptChanged=current.fingerprint!==(s.saved?.packet??s.packet).fingerprint;
      if(receiptChanged&&!(req.method==="GET"&&isReview&&req.headers.accept?.includes("text/html")))throw new ValidationError("The organizer changed this receipt. Ask for a fresh guest link.");
      const isCheckout=match[2]==="checkout";
      const action=match[3];
      if(req.method==="GET"&&isCheckout&&action==="state"){json(res,200,current);return;}
      if(req.method==="GET"&&!action&&(!match[2]||isCheckout)){
        if(!s.reviewOnly&&!isCheckout&&!receiptChanged&&current.paymentRequestsExist){
          res.writeHead(303,{location:current.checkoutUrl,"cache-control":"no-store","referrer-policy":"no-referrer"});res.end();return;
        }
        const name=isCheckout?"guest-checkout.js":"guest-review.js";
        const renderer=await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)),"..","tabloom",name)).href);
        const response=s.response as {items?:unknown}|undefined;
        const html=isCheckout?renderer.renderGuestCheckout(current):renderer.renderGuestReview({...s.packet,live:true,receiptChanged,expiresAt:new Date(s.expiresAt).toISOString(),checkoutUrl:receiptChanged||s.reviewOnly?null:current.checkoutUrl,tableJoinUrl:current.paymentRequestsExist?null:this.tableJoinUrl(s,current.fingerprint),submittedAt:s.submittedAt??null,responseItems:response?.items??null});
        res.writeHead(receiptChanged?409:200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store","referrer-policy":"no-referrer","x-content-type-options":"nosniff","x-frame-options":"DENY"});res.end(html);return;
      }
      if(req.method!=="POST"||(!isCheckout&&match[2]!=="response"&&match[2]!=="preview")||(isCheckout&&!["order","capture","reconcile"].includes(action??""))){json(res,405,{error:"Use the guest page controls."});return;}
      if(req.headers.origin&&req.headers.origin!==this.baseUrl){json(res,403,{error:"Open this guest link directly before sending."});return;}
      if(req.headers["content-type"]?.split(";")[0]!=="application/json"){json(res,415,{error:"Send guest actions as JSON."});return;}
      const body=await bodyJson(req);
      if(!this.acceptingInvitations||s.stopped||this.sessions.get(s.id)!==s||s.expiresAt<=Date.now()){json(res,410,{error:"This guest link expired or was stopped."});return;}
      if(isCheckout){
        if(!current.payment)throw new ValidationError("The organizer has not requested your payment yet. Your saved share is unchanged.");
        // The URL binds the guest, receipt and amount. Browser fields never choose a payer.
        if(action==="order")await s.service.createOrder(s.packet.guestId,(s.saved?.packet??s.packet).revision);
        else if(action==="capture")await s.service.capture(s.packet.guestId);
        else await s.service.reconcile(s.packet.guestId);
        json(res,200,await this.checkout(s));return;
      }
      const response={kind:"tabloom-guest-response",version:1,tableId:s.packet.tableId,revision:s.packet.revision,fingerprint:s.packet.fingerprint,guestId:s.packet.guestId,items:body?.items};
      const reviewed=await s.service.reviewGuestResponse(response,match[2]==="preview"?undefined:async()=>{
        if(!this.acceptingInvitations||s.stopped||this.sessions.get(s.id)!==s||s.expiresAt<=Date.now())
          throw new ValidationError("This guest link was stopped or expired.");
        // A deliberate retry after a lost acknowledgement must not invalidate
        // an organizer's review of these exact choices. Validation still ran.
        const previous=(s.response as {items?:{id:string;selected:boolean}[]}|undefined)?.items;
        const items=response.items as {id:string;selected:boolean}[];
        if(previous&&s.responseId&&s.submittedAt&&previous.length===items.length&&
          items.every(item=>previous.some(old=>old.id===item.id&&old.selected===item.selected)))return;
        try{await this.retainSession(s,{response,responseId:randomBytes(16).toString("hex"),submittedAt:new Date().toISOString()});}
        catch{throw Object.assign(new ValidationError("The organizer could not keep these choices. Keep this page open or download them, then retry after storage is restored."),{statusCode:503});}
      });
      if(!this.acceptingInvitations||s.stopped||this.sessions.get(s.id)!==s)throw new ValidationError("This guest link was stopped.");
      if(match[2]==="preview"){
        const due=reviewed.calculated?.dues.find(d=>d.guestId===s.packet.guestId);
        json(res,200,{
          revision:reviewed.revision,
          share:due?{itemsCents:due.itemsCents,discountCents:due.discountCents??0,taxCents:due.taxCents,tipCents:due.tipCents,totalCents:due.totalCents,lineItems:due.lineItems}:null,
          unresolved:reviewed.unresolved,
        });
        return;
      }
      json(res,200,{received:true,submittedAt:s.submittedAt,message:"Your item choices reached the organizer. They still need to review and save them; no bill or payment changed."});
    }catch(error){
      const status=error instanceof ValidationError?(error as Error&{statusCode?:number}).statusCode??409:502;
      if(status===409&&req.method==="GET"&&!match[2]&&req.headers.accept?.includes("text/html"))invitationUnavailable(res,409,"changed");else if(status===409&&req.method==="GET"&&match[2]==="checkout"&&!match[3])await unavailableCheckout(res,status);else json(res,status,{error:error instanceof ValidationError?error.message:match[2]==="preview"?"Could not check your proposed share. Try again.":"Could not complete this request. Check your saved payment status before trying again."});
    }
  }
}
export function guestAddress(value:string){
  const url=new URL(value);
  const parts=url.hostname.split(".").map(Number);
  const privateAddress=parts.length===4&&parts.every(n=>Number.isInteger(n)&&n>=0&&n<=255)&&(parts[0]===10||parts[0]===127||(parts[0]===172&&parts[1]>=16&&parts[1]<=31)||(parts[0]===192&&parts[1]===168)||(parts[0]===100&&parts[1]>=64&&parts[1]<=127));
  if(url.protocol!=="http:"||!privateAddress||url.username||url.password||url.pathname!=="/"||url.search||url.hash||!url.port||Number(url.port)<1)throw new Error("TABLOOM_GUEST_URL must be an explicit private-network IPv4 HTTP address and port, e.g. http://192.168.1.20:3001. The organizer stays on localhost.");
  return {host:url.hostname,port:Number(url.port),origin:url.origin};
}
const guestConnections = new WeakMap<Server, {unused:Set<Socket>;closing:boolean}>();

/** Browser preconnections have no HTTP request for closeIdleConnections to reap. */
export async function closeGuestListener(server:Server):Promise<void>{
  const connections=guestConnections.get(server);
  if(connections)connections.closing=true;
  await new Promise<void>((resolve,reject)=>{
    server.close(error=>error?reject(error):resolve());
    for(const socket of connections?.unused??[]){
      // A partial request already belongs to its sender and must drain normally.
      if(socket.bytesRead===0)socket.destroy();
    }
    server.closeIdleConnections();
  });
}

export async function listenGuestLinks(service:TabloomService,host:string,port:number,beforePublish?:(links:TabloomGuestLinks)=>Promise<void>):Promise<Server>{
  guestAddress("http://"+host+":"+(port===0?1:port));
  let links:TabloomGuestLinks|undefined;
  const connections={unused:new Set<Socket>(),closing:false};
  const server=createServer((req,res)=>{
    connections.unused.delete(req.socket);
    res.once("finish",()=>{
      if(connections.closing)server.closeIdleConnections();
    });
    if(!links){json(res,503,{error:"Guest sharing is starting. Try this invitation again."});return;}
    void links.handle(req,res).catch(()=>{if(!res.headersSent)json(res,502,{error:"Guest request failed."});else res.end();});
  });
  guestConnections.set(server,connections);
  server.on("connection",socket=>{
    connections.unused.add(socket);
    socket.once("close",()=>connections.unused.delete(socket));
  });
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(port,host,()=>{server.off("error",reject);resolve();});});
  const address=server.address();
  if(!address||typeof address==="string"){server.close();throw new Error("Guest sharing did not receive a network address.");}
  const fresh=new TabloomGuestLinks("http://"+host+":"+address.port);
  try{await beforePublish?.(fresh);}catch(error){await closeGuestListener(server);throw error;}
  links=fresh;
  service.setGuestLinks(links);
  console.log("Tabloom guest-only links available on "+links.baseUrl+". Share individual invitations from the localhost organizer; links expire after two hours, pause while the app is closed, and resume on the same network. Stop sharing revokes them.");
  return server;
}
export async function startGuestLinks(service:TabloomService,value=process.env.TABLOOM_GUEST_URL):Promise<Server|undefined>{
  if(!value)return;
  const address=guestAddress(value);
  return listenGuestLinks(service,address.host,address.port);
}
