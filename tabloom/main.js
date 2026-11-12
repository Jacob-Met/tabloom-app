import { renderDraftComparison } from "./draft-comparison.js";
import { guestFileName } from "./guest-identity.js";
import { initReceiptIntake, fitTextareas } from "./receipt-intake-view.js";
import { createGuestResponseView } from "./guest-response-view.js";
import { initGuestNetwork } from "./guest-network.js";
import { renderGuestReview } from "./guest-review.js";
import { renderGuestReceipt } from "./guest-receipt.js";
import { initChatIntake, renderChatCopy } from "./chat-intake-view.js"; // chat intake
const $ = id => document.getElementById(id);
const LAST_TABLE_KEY = "tabloom:last-table:v1";
async function initialTableId(){
  const explicit=new URLSearchParams(location.search).get("table");
  // Shared links and payment returns retain their existing destination.
  if(location.search||location.hash)return explicit||"legacy";
  let remembered;try{remembered=localStorage.getItem(LAST_TABLE_KEY);}catch{return "legacy";}
  if(!remembered||remembered==="legacy"||remembered.length>96)return "legacy";
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),2000);
  try{
    const response=await fetch("/tabloom/api/tables?table=legacy",{signal:controller.signal});
    if(!response.ok)return "legacy";
    const result=await response.json();
    if(Array.isArray(result.tables)&&result.tables.some(table=>table?.id===remembered))return remembered;
    try{localStorage.removeItem(LAST_TABLE_KEY);}catch{}
  }catch{}finally{clearTimeout(timer);}
  return "legacy";
}
const activeTableId = await initialTableId();
function rememberOpenedTable(){
  try{
    if(activeTableId!=="legacy"||new URLSearchParams(location.search).has("table")||!localStorage.getItem(LAST_TABLE_KEY))localStorage.setItem(LAST_TABLE_KEY,activeTableId);
  }catch{}
  if(activeTableId!=="legacy"&&!location.search&&!location.hash)history.replaceState(history.state,"","?table="+encodeURIComponent(activeTableId));
}
const fmt = cents => "$" + (cents / 100).toFixed(2);
const formatCents = amount => {
  if (!/^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/.test(amount.trim())) throw Error("Use a USD amount with at most 2 decimal places.");
  const [major,decimal=""] = amount.trim().split(".");
  return Number(major)*100+Number((decimal+"00").slice(0,2));
};
const esc = value => String(value).replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
let guestResponsePreview=null, guestResponseRaw=null, guestResponseIdentity=null, adoptedGuestResponse=null;
let guestResponseIdentities=null, adoptedGuestResponses=null, pendingGuestLinks=[], guestRecoveryIds=null;
const omittedGuestResponses=new Set();
let saved, draft, suggested=null, dirty=false, busy=false, editGeneration=0;
const reviewedSuggestions=new Set();
const portionResets=new Set();
const openPortions=new Set();
const openOwners=new Set();
let draftTotalGeneration=0,draftTotalTimer;
let previewGeneration=0, previewReady=false;
let aiRequest=null;
let receiptUndo=null;
let pendingInvite=null;
const paymentFeedback=new Map();
const setupPanel=$("table-setup");
setupPanel.open=false;
function refreshSetupSummary(){
  if(!draft)return;
  const amount=id=>{try{return fmt(formatCents($(id).value));}catch{return "check amount";}};
  $("setup-summary").textContent=draft.guests.length+" guests · Discount "+amount("discount")+" · Tax "+amount("tax")+" · Tip "+amount("tip");
}

let sandboxConnection=null;
const guestResponseView=createGuestResponseView($("guest-response-preview"),{onDismiss:clearGuestResponse,onSave:saveReviewedGuestResponse,onResolve:resolveReviewedGuestResponse,onRefresh:refreshReviewedGuestResponses,onCheck:checkReviewedGuestSave});

const stateMsg=(message,error=false,quiet=false)=>{$("message").hidden=false;$("message").textContent=message;$("message").className="message"+(error?" error":"")+(quiet?" save-confirmation":"");};
async function api(path,body,signal){
  const response=await fetch("/tabloom/api/"+path+"?table="+encodeURIComponent(activeTableId),{method:body===undefined?"GET":"POST",headers:body===undefined?{}:{"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),signal});
  const data=await response.json();if(!response.ok)throw Error(data.error||"The operation did not complete.");
  return data;
}
const DRAFT_KEY="tabloom:unsaved-receipt:v1"+(activeTableId==="legacy"?"":":"+activeTableId);
let pendingRecovery=null,cachedTableNavigation=false;
window.addEventListener("beforeunload",event=>{
  if(cachedTableNavigation){cachedTableNavigation=false;return;}
  if(!dirty&&!suggested&&!pendingRecovery)return;
  event.preventDefault();event.returnValue="";
});
function clearDraftCache(){
  $("draft-comparison").replaceChildren();$("draft-comparison").hidden=true;
  try{sessionStorage.removeItem(DRAFT_KEY);}catch{}
  pendingRecovery=null;guestRecoveryIds=null;$("draft-recovery").hidden=true;$("review-latest-guests").hidden=true;
}
function cacheDraft(){
  if(!saved||!draft||Object.keys(saved.bill.payments).length)return;
  const record={base:JSON.stringify(saved.bill),draft,noteReview:suggested?{proposal:suggested,confirmed:[...reviewedSuggestions]}:null,portionResets:[...portionResets],portions:Object.fromEntries([...document.querySelectorAll("[data-portion-guest]")].map(input=>[input.dataset.portionItem+":"+input.dataset.portionGuest,input.value])),
    fields:{discount:$("discount").value,title:$("bill-title").value,note:$("bill-note").value,tax:$("tax").value,tip:$("tip").value},
    prices:Object.fromEntries(Array.from(document.querySelectorAll(".item")).map(row=>[row.dataset.item,row.querySelector(".item-cents").value]))};
  const earlier=pendingRecovery&&(pendingRecovery.base!==record.base?pendingRecovery:pendingRecovery.earlier);
  if(earlier)record.earlier=earlier;
  try{sessionStorage.setItem(DRAFT_KEY,JSON.stringify(record));if(pendingRecovery)pendingRecovery=record;return true;}
  catch{$("save-state").textContent="Unsaved edits — browser recovery unavailable";}
}
function recoverNoteReview(record){
  const proposal=record.noteReview?.proposal,choices=proposal?.suggestions;
  if(proposal?.revision!==saved.bill.revision||!Array.isArray(choices)||choices.length!==draft.items.length)return false;
  const itemIds=new Set(draft.items.map(item=>item.id)),guestIds=new Set(draft.guests.map(guest=>guest.id));
  if(new Set(choices.map(choice=>choice?.itemId)).size!==itemIds.size||choices.some(choice=>!choice||!itemIds.has(choice.itemId)||typeof choice.reason!=="string"||choice.reason.length>240||!Array.isArray(choice.guestIds)||new Set(choice.guestIds).size!==choice.guestIds.length||choice.guestIds.some(id=>!guestIds.has(id))))return false;
  suggested=proposal;reviewedSuggestions.clear();
  const confirmed=Array.isArray(record.noteReview.confirmed)?record.noteReview.confirmed:[];
  for(const choice of choices)if(choice.guestIds.length&&confirmed.includes(choice.itemId))reviewedSuggestions.add(choice.itemId);
  document.querySelector(".assistant-card").open=true;renderSuggestions();return true;
}
function recoverDraft(){
  $("draft-comparison").replaceChildren();$("draft-comparison").hidden=true;
  let record;try{record=JSON.parse(sessionStorage.getItem(DRAFT_KEY)||"null");}catch{return false;}
  if(!record?.draft||!record.fields||!record.prices||!Array.isArray(record.draft.guests)||!Array.isArray(record.draft.items))return false;
  pendingRecovery=record;$("draft-recovery").hidden=false;renderDraftComparison($("draft-comparison"),record,saved.bill);
  if(record.base!==JSON.stringify(saved.bill)||Object.keys(saved.bill.payments).length){
    $("draft-recovery-text").textContent="The saved table changed. Compare your earlier draft before editing the current receipt.";
    $("draft-backup").hidden=false;return true;
  }
  draft=record.draft;dirty=true;suggested=null;portionResets.clear();for(const id of record.portionResets||[])portionResets.add(id);
  $("bill-title").value=record.fields.title;$("bill-note").value=record.fields.note;
  $("discount").value=record.fields.discount??"0.00";$("tax").value=record.fields.tax;$("tip").value=record.fields.tip;
  renderGuests();renderItems();
  for(const row of document.querySelectorAll(".item")){
    if(Object.hasOwn(record.prices,row.dataset.item))row.querySelector(".item-cents").value=record.prices[row.dataset.item];
  }
  for(const input of document.querySelectorAll("[data-portion-guest]")){const value=record.portions?.[input.dataset.portionItem+":"+input.dataset.portionGuest];if(value!==undefined)input.value=value;}
  $("save-state").textContent="Recovered unsaved edits";
  $("draft-recovery-text").textContent=recoverNoteReview(record)?"Unsaved receipt and split review recovered. Check the proposed totals before saving.":"Unsaved receipt recovered.";
  $("draft-backup").hidden=false;renderPayments();scheduleDraftTotal();requestAnimationFrame(sizeItemNames);return true;
}
$("discard-draft").addEventListener("click",()=>{
  if(busy){stateMsg("Wait for the current operation before discarding this draft.",true);return;}
  if(!window.confirm("Discard this tab's unsaved receipt and show the saved table?"))return;
  clearDraftCache();renderEverything();stateMsg("Unsaved draft discarded. The saved table is unchanged.");
});
$("draft-backup").addEventListener("click",()=>{
  let record;try{record=JSON.parse(sessionStorage.getItem(DRAFT_KEY)||"null");}catch{}
  if(!record)return;
  const url=URL.createObjectURL(new Blob([JSON.stringify(record,null,2)],{type:"application/json"}));
  const link=document.createElement("a");link.href=url;link.download="tabloom-unsaved-draft.json";link.click();
  setTimeout(()=>URL.revokeObjectURL(url),5000);
});
function clearGuestResponse(){heldGuestFiles=null;$("file-response-recovery").classList.remove("file-response-selection");guestResponseView.close();if(guestRecoveryIds){$("draft-recovery-text").textContent="Your receipt edits are still unsaved. Save & Recalculate when ready, or discard this draft to return to the saved table.";}guestRecoveryIds=null;$("review-latest-guests").hidden=true;guestResponseIdentities=null;guestResponseIdentity=null;guestResponsePreview=null;guestResponseRaw=null;$("guest-response-preview").replaceChildren();$("guest-response-file").value="";$("file-response-recovery").replaceChildren();$("file-response-recovery").hidden=true;}
function setDirty(options={}){
  if($("message").classList.contains("save-confirmation"))$("message").hidden=true;
  pendingInvite=null;
  clearReceiptUndo();
  refreshSetupSummary();
  aiRequest?.abort("edited");
  adoptedGuestResponse=null;adoptedGuestResponses=null;clearGuestResponse();
  editGeneration++;
  dirty=true;if(!options.keepNoteReview)suggested=null;if(suggested)refreshProposalCost();else renderSuggestions();$("save-state").textContent="Unsaved edits";
  $("save").disabled=busy;
  cacheDraft();renderPayments();renderReceiptSources();scheduleDraftTotal();
  $("suggest").disabled=busy||Object.keys(saved.bill.payments).length>0||!draft.items.length;
}
function renderGuests(){
  $("distinct-guest-name-status")?.remove();
  refreshSetupSummary();
  $("guests").innerHTML=draft.guests.map((g,i)=>'<div class="guest"><span class="guest-num">'+String(i+1).padStart(2,"0")+'</span><input class="guest-name" data-guest="'+esc(g.id)+'" aria-label="Guest '+(i+1)+' name" maxlength="48" value="'+esc(g.name)+'"><button class="delete" data-remove-guest="'+esc(g.id)+'" aria-label="Remove '+esc(g.name)+'">×</button></div>').join("");
}
let savedTables=[];
const tableSearchText=value=>String(value??"").normalize("NFD").replace(/\p{Diacritic}/gu,"").toLocaleLowerCase();
function renderTableList(){
  const query=$("table-search").value.trim(),terms=tableSearchText(query).split(/\s+/).filter(Boolean);
  const matches=savedTables.filter(table=>{const text=tableSearchText([table.title,...(table.guestNames||[])].join(" "));return terms.every(term=>text.includes(term));});
  $("clear-table-search").hidden=!query;
  $("table-count").textContent=query?matches.length+" of "+savedTables.length+" tables":savedTables.length+" "+(savedTables.length===1?"table":"tables")+" on this computer";
  $("table-list").innerHTML=matches.length?matches.map(table=>{
    const status=table.sample?"Example receipt":table.paymentCount?fmt(table.capturedCents)+" captured"+(table.unresolvedPayments?" · "+table.unresolvedPayments+" unresolved":""):table.itemCount?"":"No receipt items yet";
    const href="?table="+encodeURIComponent(table.id),date=table.updatedAt?new Date(table.updatedAt):null;
    const savedDate=date&&Number.isFinite(date.getTime())?'<time datetime="'+esc(table.updatedAt)+'" title="'+esc(date.toLocaleString())+'">Saved '+esc(date.toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"}))+'</time>':"";
    const guestNames=table.guestNames||[],matchedNames=guestNames.filter(name=>terms.some(term=>tableSearchText(name).includes(term)));
    const shownNames=[...matchedNames,...guestNames.filter(name=>!matchedNames.includes(name))].slice(0,3);
    const names=shownNames.join(", ")+(guestNames.length>3?" +"+(guestNames.length-3)+" more":"")||table.guestCount+" guests";
    return '<li><a href="'+href+'" '+(table.id===activeTableId?'aria-current="page"':'')+'><span class="table-row-name">'+esc(table.title)+(table.id===activeTableId?'<span class="table-current-mark">OPEN</span>':'')+'</span><span class="table-row-total">'+fmt(table.totalCents)+'</span><small class="table-row-guests">'+esc(names)+' · '+table.itemCount+' '+(table.itemCount===1?'item':'items')+'</small><small class="table-row-meta">'+savedDate+(savedDate&&status?' · ':'')+esc(status)+'</small></a></li>';
  }).join(""):'<li class="table-list-empty">No tables match “'+esc(query)+'”.</li>';
}
async function refreshTables(){
  $("table-current").textContent=saved?.bill.title || "Your tables";
  try{
    const result=await api("tables");savedTables=result.tables;renderTableList();
    const example=savedTables.some(table=>table.id===activeTableId&&table.sample);
    $("example-receipt").hidden=!example;
    $("new-table").textContent=example?"START YOUR TABLE →":"+ NEW TABLE";
  }catch(error){$("table-count").textContent="Could not load saved tables";$("table-list").innerHTML='<li class="table-list-error">'+esc(error.message)+'</li>';}
}
$("table-search").addEventListener("input",renderTableList);
$("clear-table-search").addEventListener("click",()=>{$("table-search").value="";renderTableList();$("table-search").focus();});
function tableNavigationBusy(){
  $("table-toggle").disabled=busy;$("new-table").disabled=busy;
  $("table-list").setAttribute("aria-busy",String(busy));
}
$("table-toggle").addEventListener("click",()=>{
  const opening=$("table-drawer").hidden;
  $("table-drawer").hidden=!opening;$("table-toggle").setAttribute("aria-expanded",String(opening));
  if(opening)refreshTables();
});
$("table-list").addEventListener("click",event=>{
  const link=event.target.closest("a");if(!link)return;
  if(busy){event.preventDefault();stateMsg("Wait for the current operation before changing tables.",true);return;}
  if((dirty||suggested)&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&!event.altKey&&event.button===0)cachedTableNavigation=cacheDraft()===true;
});
const NEW_TABLE_ATTEMPT_KEY="tabloom:pending-table-create:v1";
function readNewTableAttempt(){
  try{
    const record=JSON.parse(sessionStorage.getItem(NEW_TABLE_ATTEMPT_KEY)||"null");
    if(!record||!/^table-[a-f0-9]{32}$/.test(record.tableId)||typeof record.details?.title!=="string"||!Array.isArray(record.details?.guests)||!record.details.guests.every(name=>typeof name==="string"))return null;
    if(record.tableId===activeTableId){sessionStorage.removeItem(NEW_TABLE_ATTEMPT_KEY);return null;}
    return record;
  }catch{return null;}
}
function rememberNewTableAttempt(form){
  try{
    if(!form.dataset.pendingDetails){sessionStorage.removeItem(NEW_TABLE_ATTEMPT_KEY);return;}
    sessionStorage.setItem(NEW_TABLE_ATTEMPT_KEY,JSON.stringify({tableId:form.dataset.tableId,details:JSON.parse(form.dataset.pendingDetails),confirmed:form.dataset.confirmed==="true"}));
  }catch{}
}
readNewTableAttempt();
function refreshNewTableControls(){
  const form=$("new-table-form"),pending=!!form.dataset.pendingDetails;
  $("new-table-title").disabled=pending;$("new-table-guests").disabled=pending;
  $("create-table").textContent=form.dataset.confirmed==="true"?"Open table →":pending?"Continue →":"Create table →";
  $("cancel-new-table").textContent=pending?"Close":"Cancel";
}
$("new-table").addEventListener("click",()=>{
  if(busy)return;
  const form=$("new-table-form");
  if(!form.dataset.pendingDetails){
    const earlier=readNewTableAttempt();
    if(earlier){
      form.dataset.tableId=earlier.tableId;form.dataset.pendingDetails=JSON.stringify(earlier.details);
      if(earlier.confirmed)form.dataset.confirmed="true";
      $("new-table-title").value=earlier.details.title;$("new-table-guests").value=earlier.details.guests.join("\n");
      $("new-table-error").textContent=earlier.confirmed?"Your table is ready. Open it to continue.":"Could not confirm creation. Continue to open this same table.";
    }
  }
  if(!form.dataset.pendingDetails){
    form.reset();delete form.dataset.tableId;delete form.dataset.confirmed;
    $("new-table-error").textContent="";
  }
  refreshNewTableControls();$("new-table-dialog").showModal();
  (form.dataset.pendingDetails?$("create-table"):$("new-table-title")).focus();
});
$("new-table-dialog").addEventListener("cancel",event=>{if($("create-table").disabled)event.preventDefault();});
$("cancel-new-table").addEventListener("click",()=>{if(!$("create-table").disabled)$("new-table-dialog").close();});
$("new-table-form").addEventListener("submit",async event=>{
  event.preventDefault();
  if(busy||$("create-table").disabled)return;
  const form=$("new-table-form");
  const tableId=form.dataset.tableId || "table-"+crypto.randomUUID().replaceAll("-","");
  const details=form.dataset.pendingDetails?JSON.parse(form.dataset.pendingDetails):{title:$("new-table-title").value,guests:$("new-table-guests").value.split(/\r?\n/).map(name=>name.trim()).filter(Boolean)};
  form.dataset.tableId=tableId;form.dataset.pendingDetails=JSON.stringify(details);rememberNewTableAttempt(form);refreshNewTableControls();
  $("create-table").disabled=true;$("cancel-new-table").disabled=true;
  $("new-table-error").textContent=form.dataset.confirmed==="true"?"Opening your table…":"Creating your table…";
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  let rejected=false;
  try{
    if(form.dataset.confirmed!=="true"){
      const response=await fetch("/tabloom/api/tables?table="+encodeURIComponent(activeTableId),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({tableId,details}),signal:controller.signal});
      const result=await response.json();
      if(!response.ok){rejected=response.status>=400&&response.status<500;throw Error(result.error||"The table could not be created.");}
      if(result.tableId!==tableId)throw Error("The table could not be confirmed.");
      form.dataset.confirmed="true";rememberNewTableAttempt(form);
    }
    $("new-table-error").textContent="Your table is ready. Continue to open it.";
    if(dirty||suggested)cachedTableNavigation=cacheDraft()===true;
    location.assign("?table="+encodeURIComponent(tableId));
  }catch(error){
    if(rejected){delete form.dataset.pendingDetails;delete form.dataset.tableId;delete form.dataset.confirmed;rememberNewTableAttempt(form);}
    $("new-table-error").textContent=rejected?error.message:"Could not confirm creation. Continue to open this same table.";
  }finally{
    clearTimeout(timer);$("create-table").disabled=false;$("cancel-new-table").disabled=false;refreshNewTableControls();
  }
});
function portionEditor(item){
  const notice=portionResets.has(item.id)?'<p class="portion-reset" role="status">People changed · portions reset to equal.</p>':"";
  if(item.sharedBy.length<2)return notice;
  if(!item.portions)return notice+'<button type="button" class="text-button portions-toggle" data-portions="'+esc(item.id)+'">Equal split · change portions</button>';
  const names=item.sharedBy.map(id=>esc(draft.guests.find(g=>g.id===id).name)+' '+item.portions[id]).join(' · ');
  return notice+'<details class="portion-editor" data-portion-details="'+esc(item.id)+'" '+(openPortions.has(item.id)?'open':'')+'><summary>Portions · '+names+'</summary><div class="portion-inputs">'+item.sharedBy.map(id=>{const guest=draft.guests.find(g=>g.id===id);return '<label>'+esc(guest.name)+'<input type="number" min="1" max="1000" step="1" inputmode="numeric" aria-label="Portions of '+esc(item.name)+' for '+esc(guest.name)+'" data-portion-item="'+esc(item.id)+'" data-portion-guest="'+esc(id)+'" value="'+item.portions[id]+'"></label>';}).join('')+'</div><button type="button" class="text-button" data-equal-portions="'+esc(item.id)+'">Use equal split</button></details>';
}
$("items").addEventListener("toggle",event=>{const id=event.target.dataset.portionDetails;if(id){if(event.target.open)openPortions.add(id);else openPortions.delete(id);}},true);
function sizeItemNames(){fitTextareas(document.querySelectorAll(".item-name"));}
function renderReceiptSources(){
  const host=$("receipt-originals");host.replaceChildren();
  const sources=saved.bill.receiptSources||[];host.hidden=!sources.length;
  const previous=JSON.stringify(sources.map(source=>source.id))!==JSON.stringify((draft.receiptSources||[]).map(source=>source.id));
  const label=previous?"Previous saved photo":"Original photo";
  sources.forEach((source,index)=>{
    const link=document.createElement("a");link.textContent=sources.length===1?label:label+" "+(index+1);
    link.href="/tabloom/api/receipt-source?table="+encodeURIComponent(activeTableId)+"&id="+source.id;
    link.target="_blank";link.rel="noopener";host.append(link);
  });
}
function ownershipControls(item){
  const full=draft.guests.length>=2&&!item.portions&&!Object.keys(saved.bill.payments).length&&draft.guests.every(g=>item.sharedBy.includes(g.id));
  const selectedNames=draft.guests.filter(g=>item.sharedBy.includes(g.id)).map(g=>g.name);
  const named=draft.guests.length>=5&&!item.portions&&!Object.keys(saved.bill.payments).length&&item.sharedBy.length>=1&&item.sharedBy.length<=3&&selectedNames.length===item.sharedBy.length&&selectedNames.every(name=>name.trim());
  const compact=full||named;
  if(compact&&!openOwners.has(item.id)){
    const notice=portionResets.has(item.id)?'<p class="portion-reset" role="status">People changed · portions reset to equal.</p>':"";
    const label=full?"Everyone · "+draft.guests.length+" equal shares":selectedNames.length===1?"Only "+selectedNames[0]:selectedNames.join(" · ")+" · equal shares";
    return '<button type="button" class="owners-summary" data-edit-owners="'+esc(item.id)+'" aria-label="Edit people and portions for '+esc(item.name)+': '+esc(label)+'"><span>'+esc(label)+'</span><span>Edit</span></button>'+notice;
  }
  return '<div class="shared"><button type="button" class="share-everyone" data-share-everyone="'+esc(item.id)+'" aria-label="Include everyone in '+esc(item.name)+'" '+(draft.guests.every(g=>item.sharedBy.includes(g.id))?'disabled':'')+'>Everyone</button>'+draft.guests.map(g=>'<label class="chip"><input type="checkbox" data-share="'+esc(item.id)+'" value="'+esc(g.id)+'" '+(item.sharedBy.includes(g.id)?"checked":"")+'> '+esc(g.name)+'</label>').join("")+(item.sharedBy.length>=2?'<button type="button" class="text-button owners-clear" data-clear-people="'+esc(item.id)+'" aria-label="Clear people from '+esc(item.name)+'">Clear people</button>':"")+(compact?'<button type="button" class="text-button owners-done" data-close-owners="'+esc(item.id)+'">Done</button>':'')+'</div>'+portionEditor(item);
}
let itemSearchQuery=null,itemSearchMatches=new Set();
function filterItems(refresh=false){
  const rows=[...$("items").querySelectorAll(".item")],available=rows.length>=12;
  $("item-finder").hidden=!available;if(!available)$("item-search").value="";
  const query=$("item-search").value.trim(),terms=tableSearchText(query).split(/\s+/).filter(Boolean);let count=0;
  // Keep found rows available while their names or people are being corrected.
  if(refresh || query!==itemSearchQuery){
    itemSearchQuery=query;
    itemSearchMatches=new Set(rows.filter(row=>terms.every(term=>tableSearchText(row.querySelector(".item-name").value).includes(term))).map(row=>row.dataset.item));
  }
  for(const row of rows){const matches=!query||itemSearchMatches.has(row.dataset.item);row.hidden=!matches;if(matches)count++;}
  $("clear-item-search").hidden=!query;$("item-search-status").hidden=!query;
  $("item-search-status").textContent=count?count+" of "+rows.length+" items":"No dishes match. Clear the search to see all items.";
  requestAnimationFrame(sizeItemNames);
}
function clearItemSearch(){ $("item-search").value="";filterItems(); }
$("item-search").addEventListener("input",()=>filterItems(true));
$("clear-item-search").addEventListener("click",()=>{clearItemSearch();$("item-search").focus();});
function renderItems(preserveEnteredPrices=false){
  renderReceiptSources();
  $("item-count").textContent=draft.items.length+(draft.items.length===1?" item":" items");
  const enteredPrices=preserveEnteredPrices ? new Map(Array.from(document.querySelectorAll("#items .item"),row=>[row.dataset.item,row.querySelector(".item-cents").value])) : new Map();
  const enteredPortions=preserveEnteredPrices?new Map([...document.querySelectorAll("[data-portion-guest]")].map(input=>[input.dataset.portionItem+":"+input.dataset.portionGuest,input.value])):new Map();
  $("items").innerHTML=draft.items.length?draft.items.map((item,i)=>'<div class="item" data-item="'+esc(item.id)+'"><div class="item-row"><textarea class="item-name" rows="1" maxlength="96" aria-label="Item '+(i+1)+' name">'+esc(item.name)+'</textarea><input class="item-cents" aria-label="Price of '+esc(item.name)+' in USD" inputmode="decimal" value="'+esc(enteredPrices.has(item.id)?enteredPrices.get(item.id):(item.cents/100).toFixed(2))+'"><button class="delete" data-remove-item="'+esc(item.id)+'" aria-label="Remove '+esc(item.name)+'">×</button></div><div class="shared-label">'+(item.sharedBy.length?"":"UNASSIGNED — choose who pays")+'</div>'+ownershipControls(item)+'</div>').join(""):'<div class="empty-receipt"><h3>Your receipt starts here</h3><p>Add the first food or drink, then choose who shared it. Nothing is owed until you save receipt items.</p><button type="button" class="outline" id="first-item">ADD FIRST ITEM</button></div>';
  for(const input of document.querySelectorAll("[data-portion-guest]")){const value=enteredPortions.get(input.dataset.portionItem+":"+input.dataset.portionGuest);if(value!==undefined)input.value=value;}
  filterItems();
}
function savedPaymentLabel(d){
  const payment=saved.bill.payments[d.guestId],status=payment?.status||"not_started";
  const labels={not_started:"Not requested",creating:"Request not confirmed",unknown_order:"Request not confirmed",awaiting_approval:"Awaiting approval",capture_unknown:"Payment not confirmed",pending:"Payment pending",captured:"Paid"};
  return payment?.providerFailure?"Needs organizer review":payment?.providerStatus==="VOIDED"?"Request ended":!payment&&d.totalCents===0?"No payment due":labels[status]||status.replaceAll("_"," ");
}
function renderMoney(calc=saved.calculated,bill=saved.bill,isDraft=false,isProposal=false){
  if(!isProposal){
    $("draft-total-label").textContent=isDraft?"Draft total · not saved":"Saved total";
    $("draft-total").textContent=fmt(calc.totalCents);
    if(suggested)return;
  }
  document.querySelector(".receipt-heading").textContent=isProposal?"Proposed guest totals":"Each guest owes";
  $("money-label").textContent=isProposal?"REVIEW SHARES":isDraft?"DRAFT SHARES":"SAVED SHARES";
  $("money-state").textContent=isProposal?"Preview only · not saved":isDraft?"Not saved":"Revision "+saved.bill.revision;
  $("revision").textContent="REV "+saved.bill.revision;
  $("subtotal").innerHTML='<div class="total-row"><span>Food & drinks</span><b>'+fmt(calc.subtotalCents)+'</b></div>'+(bill.discountCents?'<div class="total-row"><span>Receipt discount</span><b>−'+fmt(bill.discountCents)+'</b></div>':'')+'<div class="total-row"><span>Tax</span><b>'+fmt(bill.taxCents)+'</b></div><div class="total-row"><span>Tip</span><b>'+fmt(bill.tipCents)+'</b></div>';
  $("dues").innerHTML=calc.dues.map(d=>'<div class="due"><strong>'+esc(d.name)+'</strong><span>'+fmt(d.totalCents)+'</span><small>Food '+fmt(d.itemsCents)+(d.discountCents?' · discount −'+fmt(d.discountCents):'')+' · tax '+fmt(d.taxCents)+' · tip '+fmt(d.tipCents)+'</small>'+(isDraft||isProposal?"":'<small>'+esc(d.paidCents>0?"CAPTURED "+fmt(d.paidCents):savedPaymentLabel(d))+'</small>')+'</div>').join("");
  $("grand-total").innerHTML='<span>TABLE TOTAL</span><strong>'+fmt(calc.totalCents)+'</strong>';
}
function paymentCard(d){
  const payment=saved.bill.payments[d.guestId];
  const status=payment?.status||"not_started";
  const feedback=paymentFeedback.get(d.guestId);
  const retryAllowed=saved.paymentRetries?.[d.guestId]!==false;
  const reviewNeeded=["creating","unknown_order","capture_unknown"].includes(status)&&!retryAllowed;
  const refreshRequired=feedback?.refreshRequired;
  const providerFailure=payment?.providerFailure;
  const key=esc(d.guestId);
  const receipt='<button type="button" class="receipt-export" data-receipt="'+key+'" '+(dirty||busy?"disabled":"")+'>Download guest breakdown ↓</button>';
  const review='<button type="button" class="receipt-export" data-guest-review="'+key+'" '+(dirty||busy||Object.keys(saved.bill.payments).length?"disabled":"")+'>Download item review form ↓</button>';
  const live=saved.guestLinksReady?'<button type="button" class="secondary" data-guest-link="'+key+'" aria-label="'+(status==="captured"?'Share result for ':payment?'Share checkout for ':'Invite ')+esc(d.name)+'" '+(dirty||busy?"disabled":"")+'>'+(status==="captured"?'Share result':payment?'Share checkout':'Invite')+'</button>':'<button type="button" class="secondary" data-invite-setup="'+key+'" aria-label="Invite '+esc(d.name)+'" '+(dirty||busy?"disabled":"")+'>Invite</button>';
  const opening=!providerFailure&&payment?.providerStatus!=="VOIDED"&&payment?.approvalUrl?'<a href="'+esc(payment.approvalUrl)+'" target="_blank" rel="noopener noreferrer">Open PayPal Sandbox ↗</a>':"";
  const action=!reviewNeeded&&(!payment||status==="unknown_order"||status==="creating")&&d.totalCents>0?'<button data-pay="'+key+'" '+(dirty||busy||refreshRequired||!saved.paypalReady||!payment&&pendingGuestLinks.some(link=>link.responseChanged)?"disabled":"")+'>'+(payment?"Retry same request":pendingGuestLinks.some(link=>link.responseChanged)?"Review replies first":"Request payment")+'</button>':"";
  const capture=!reviewNeeded&&(status==="awaiting_approval"||status==="capture_unknown")?'<button data-capture="'+key+'" '+(busy||refreshRequired?"disabled":"")+'>'+(status==="capture_unknown"?"Retry approved payment":"Complete approved payment")+'</button>':"";
  const reconcile=payment?.orderId&&status!=="captured"?'<button data-reconcile="'+key+'" '+(busy||refreshRequired?"disabled":"")+'>Check payment</button>':"";
  const refresh=refreshRequired?'<button data-refresh-payment="'+key+'" '+(busy?'disabled':'')+'>REFRESH SAVED STATUS</button>':'';
  const openingInOptions=status==="awaiting_approval"&&!saved.guestLinksReady&&!refreshRequired?"":opening;
  let primary="",recovery="";
  if(providerFailure){
    const reasons={not_found:"PayPal could not find this request. Review the original request and Sandbox connection.",connection_changed:"Reconnect this request’s original PayPal app, then check its status.",order_mismatch:"The provider response did not match this guest’s saved payment.",unavailable:"The latest PayPal status could not be confirmed."};
    primary='<p class="payment-error">'+esc(reasons[providerFailure.reason]||reasons.unavailable)+'</p>'+(payment.orderId?reconcile:providerFailure.reason==="connection_changed"?action:"");
  }
  else if(payment?.providerStatus==="VOIDED"){primary='<p class="payment-error">PayPal has ended this request. Review the original payment.</p>'+reconcile;}
  else if(reviewNeeded){primary='<p class="payment-error">The original request is unresolved and needs organizer review before another attempt.</p>'+reconcile;recovery=refresh;}
  else if(refreshRequired){primary=refresh;recovery=action+capture+reconcile;}
  else if(!payment||status==="unknown_order"||status==="creating"){primary=live+(saved.paypalReady?action:"");if(!saved.paypalReady)recovery=action;}
  else if(status==="awaiting_approval"){primary=live+(!saved.guestLinksReady?opening:"")+capture;recovery=reconcile;}
  else if(status==="capture_unknown"){primary=live+reconcile;recovery=capture;}
  else if(status==="pending")primary=live+reconcile;
  else primary=live;
  const label=savedPaymentLabel(d);
  const notice=feedback?'<p class="payment-feedback'+(feedback.error?' error':'')+'" role="status" aria-live="polite">'+esc(feedback.text)+'</p>':'';
  const discount=d.discountCents?'<small>−'+fmt(d.discountCents)+' discount included</small>':"";
  const observedTime=value=>typeof value==="string"&&Number.isFinite(Date.parse(value))?'<time datetime="'+esc(value)+'">'+esc(new Date(value).toLocaleString())+'</time>':"Not recorded";
  const observation=providerFailure?'<p class="payment-reference">Last unsuccessful check: '+observedTime(providerFailure.checkedAt)+'<br>Last known payment state: '+esc(status.replaceAll("_"," "))+'</p>':"";
  const history=payment?'<div class="payment-reference" data-payment-history="'+key+'"><strong>Original payment request</strong><p>Request reference<br><code>'+esc(payment.requestId||"Not recorded")+'</code><br>Started: '+observedTime(payment.requestStartedAt)+'</p>'+(payment.orderId?'<p>PayPal Sandbox order<br><code>'+esc(payment.orderId)+'</code></p>':'<p>PayPal order reference not received.</p>')+(payment.captureRequestId?'<p>Capture request reference<br><code>'+esc(payment.captureRequestId)+'</code><br>First attempt: '+observedTime(payment.captureStartedAt)+'</p>':'')+'</div>':"";
  const breakdown='<dl class="payment-breakdown"><div><dt>Items</dt><dd>'+fmt(d.itemsCents)+'</dd></div>'+(d.discountCents?'<div><dt>Receipt discount</dt><dd>−'+fmt(d.discountCents)+'</dd></div>':'')+'<div><dt>Sales tax</dt><dd>'+fmt(d.taxCents)+'</dd></div><div><dt>Tip</dt><dd>'+fmt(d.tipCents)+'</dd></div></dl>';
  return '<div class="payment-card payment-row'+(!payment&&!saved.paypalReady&&!refreshRequired?' payment-row-invite':'')+'" role="group" aria-labelledby="payment-name-'+key+'" data-payment-status="'+esc(status)+'"><div class="payment-row-top"><div class="payment-person"><h3 id="payment-name-'+key+'">'+esc(d.name)+'</h3><div class="status">'+(refreshRequired?'LAST KNOWN · ':'')+esc(label)+'</div></div><div class="payment-amount"><strong>'+fmt(d.totalCents)+'</strong>'+discount+'</div><div class="payment-actions">'+primary+'</div></div>'+notice+'<details class="payment-options" data-payment-options="'+key+'"><summary>Breakdown &amp; other options</summary>'+breakdown+observation+history+(payment?.captureId?'<p class="payment-reference">Sandbox capture: '+esc(payment.captureId)+'</p>':'')+'<div class="payment-other-actions">'+receipt+review+openingInOptions+recovery+'</div></details></div>';
}
function downloadReceipt(guestId) {
  if (dirty || busy) throw Error("Save your edits before exporting a guest receipt.");
  const due=saved.calculated.dues.find(d=>d.guestId===guestId);
  if (!due) throw Error("Unknown guest share.");
  const html=renderGuestReceipt(saved.bill,due,saved.bill.payments[guestId]);
  const blob=new Blob([html],{type:"text/html;charset=utf-8"});
  const url=URL.createObjectURL(blob);
  const link=document.createElement("a");
  link.href=url;link.download=guestFileName({title:saved.bill.title,guestName:due.name,guestId:due.guestId,revision:saved.bill.revision},"receipt","html");
  document.body.append(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),5000);
}
function refreshReceiptAction(){
  const ready=!dirty&&saved?.bill.items.length>0;
  $("save").textContent=ready?"Guest shares →":"Save receipt ↗";
  $("save").disabled=busy||(!ready&&Object.keys(saved?.bill.payments||{}).length>0);
}
function renderPendingInvite(){
  const button=$("invite-review-file");
  const guest=pendingInvite&&saved?.bill.revision===pendingInvite.revision&&!dirty&&!Object.keys(saved.bill.payments).length?saved.bill.guests.find(g=>g.id===pendingInvite.guestId):null;
  button.hidden=!guest;button.disabled=busy;
  for(const control of document.querySelectorAll("[data-live-guest-file],[data-fresh-guest-form]"))control.disabled=dirty||busy||Object.keys(saved.bill.payments).length>0;
  if(guest)button.textContent="Download "+guest.name+"’s offline form";
}
function renderPayments(){
  renderTableInvitation();
  renderPendingInvite();
  refreshReceiptAction();
  $("paste-receipt").disabled=busy||!saved||Object.keys(saved.bill.payments).length>0;
  renderGuestBatchControls();
  $("shares-state").textContent="Saved revision "+saved.bill.revision+(dirty?" · Draft edits not included. Return to Receipt to save.":"");
  const openOptions=new Set([...$("payments").querySelectorAll("details[data-payment-options][open]")].map(details=>details.dataset.paymentOptions));
  $("payments").innerHTML=saved.bill.items.length?saved.calculated.dues.map(paymentCard).join(""):'<p class="empty-checkout">Add receipt items and save them to prepare each guest’s breakdown. No payment has been requested.</p>';
  for(const details of $("payments").querySelectorAll("details[data-payment-options]"))details.open=openOptions.has(details.dataset.paymentOptions);
  renderChatCopy(saved); // chat intake
  $("sandbox-tag").textContent=sandboxConnection?.status==="ready"?"SANDBOX CONNECTED":saved.paypalReady?"SANDBOX CONFIGURED":"PAYMENTS NOT CONNECTED";
}
function renderEverything(){
  clearReceiptUndo();
  draftTotalGeneration++;clearTimeout(draftTotalTimer);
  aiRequest?.abort("edited");
  portionResets.clear();
  adoptedGuestResponse=null;adoptedGuestResponses=null;clearGuestResponse();
  draft=structuredClone(saved.bill);
  $("bill-title").value=draft.title;$("bill-note").value=draft.note;$("discount").value=((draft.discountCents||0)/100).toFixed(2);$("tax").value=(draft.taxCents/100).toFixed(2);$("tip").value=(draft.tipCents/100).toFixed(2);
  dirty=false;busy=false;suggested=null;
  $("save-state").textContent="Saved as revision "+saved.bill.revision;
  renderGuests();renderItems();renderMoney();renderPayments();renderSuggestions();requestAnimationFrame(sizeItemNames);
  const locked=Object.keys(saved.bill.payments).length>0;
  document.querySelectorAll("#bill-title,#bill-note,#discount,#tax,#tip,#guests input,#guests button,#items input,#items textarea,#items button,#save").forEach(control=>{control.disabled=locked||(!!control.dataset.shareEveryone&&draft.guests.every(g=>draft.items.find(i=>i.id===control.dataset.shareEveryone)?.sharedBy.includes(g.id)));});
  if(locked)$("save-state").textContent="Receipt locked — payment requests exist";
  refreshReceiptAction();
  refreshTables();refreshGuestLinks();
  $("suggest").disabled=locked||!draft.items.length;
  $("add-guest").disabled=Object.keys(saved.bill.payments).length>0;
  $("add-item").disabled=Object.keys(saved.bill.payments).length>0;
}
function scheduleDraftTotal(){
  const generation=++draftTotalGeneration;clearTimeout(draftTotalTimer);
  $("draft-total-label").textContent="Draft total · not saved";$("draft-total").textContent="…";
  if(!suggested){
    $("money-label").textContent="DRAFT SHARES";$("money-state").textContent="Calculating…";
    $("subtotal").replaceChildren();$("dues").replaceChildren();$("grand-total").replaceChildren();
  }
  draftTotalTimer=setTimeout(async()=>{
    try{
      const bill=structuredClone(draft);
      bill.title=$("bill-title").value;bill.note=$("bill-note").value;
      for(const key of ["discount","tax","tip"])bill[key+"Cents"]=formatCents($(key).value);
      for(const row of document.querySelectorAll("#items .item")){
        const item=bill.items.find(i=>i.id===row.dataset.item);
        item.cents=formatCents(row.querySelector(".item-cents").value);
      }
      const unassigned=bill.items.filter(item=>!item.sharedBy.length);
      if(unassigned.length){
        const subtotalCents=bill.items.reduce((sum,item)=>sum+item.cents,0);
        if(bill.discountCents>subtotalCents)throw Error("Receipt discount cannot exceed the item subtotal.");
        const totalCents=subtotalCents-bill.discountCents+bill.taxCents+bill.tipCents;
        if(!Number.isSafeInteger(totalCents))throw Error("This receipt total is too large.");
        if(generation!==draftTotalGeneration||!dirty)return;
        renderMoney({subtotalCents,totalCents,dues:[]},bill,true);
        if(suggested)return;
        $("money-label").textContent="DRAFT RECEIPT";
        document.querySelector(".receipt-heading").textContent="Receipt total";
        $("money-state").textContent=unassigned.length===1?"1 item still needs people.":unassigned.length+" items still need people.";
        return;
      }
      const {calculated}=await reviewedApi("bill/preview",{bill,revision:saved.bill.revision},"Could not update the total. Retry when ready.");
      if(generation!==draftTotalGeneration||!dirty)return;
      renderMoney(calculated,bill,true);
    }catch(error){
      if(generation!==draftTotalGeneration||!dirty)return;
      $("draft-total").textContent="—";if(suggested)return;$("money-state").textContent=error.message;
      $("grand-total").innerHTML='<button id="retry-draft-total" class="outline" type="button">Retry total</button>';
    }
  },200);
}
$("grand-total").addEventListener("click",event=>{if(event.target.id==="retry-draft-total")scheduleDraftTotal();});
function showWorkspace(){
  const shares=location.hash==="#guest-checkout";
  $("receipt-workspace").hidden=shares;$("guest-checkout").hidden=!shares;
  if(!shares)requestAnimationFrame(sizeItemNames);
}
window.addEventListener("hashchange",showWorkspace);window.addEventListener("resize",sizeItemNames);showWorkspace();
function syncRoot(){
  draft.title=$("bill-title").value;draft.note=$("bill-note").value;
  draft.discountCents=formatCents($("discount").value);
  draft.taxCents=formatCents($("tax").value);draft.tipCents=formatCents($("tip").value);
}
function lockEditCheck(){
  if(Object.keys(saved.bill.payments).length)throw Error("Payment requests already exist. Editing is locked for settlement safety.");
}
function reviewPortions(choice){
  const item=draft.items.find(item=>item.id===choice.itemId);
  if(!item?.portions)return null;
  const kept=item.sharedBy.length===choice.guestIds.length&&item.sharedBy.every(id=>choice.guestIds.includes(id));
  return {kept,portions:kept?item.portions:null};
}
function updateReviewPortions(row,choice){
  const state=reviewPortions(choice);
  if(!state)return;
  row.querySelector("[data-review-portions]").textContent=state.kept?"Current portions are kept.":"Changing people resets this item to equal shares.";
  row.querySelectorAll("[data-review-portion]").forEach(label=>{
    const id=label.dataset.reviewPortion;
    const count=choice.guestIds.includes(id)?state.portions?.[id]||1:0;
    label.textContent=count?" · "+count+" "+(count===1?"portion":"portions"):"";
  });
}
function currentReviewPeople(choice){
  const item=draft.items.find(item=>item.id===choice.itemId);
  const normalize=value=>String(value??"").trim().replace(/\s+/g," ").toLowerCase();
  const name=normalize(item?.name);
  if(name&&normalize(draft.note).includes(name))return [];
  return draft.guests.filter(guest=>item?.sharedBy.includes(guest.id));
}
function renderSuggestions(){
  if(!suggested){previewGeneration++;previewReady=false;$("suggestions").replaceChildren();return;}
  const lookup=new Map(draft.items.map(i=>[i.id,i]));
  const currentPeopleAction=s=>{
    const people=currentReviewPeople(s);
    return people.length?'<button type="button" class="text-button review-current" data-review-current="'+esc(s.itemId)+'" '+(s.guestIds.length?'hidden':'')+'>Keep current: '+people.map(g=>esc(g.name)).join(', ')+'</button>':'';
  };
  const reviewPeople=s=>{
    const full=draft.guests.length>=5&&!lookup.get(s.itemId)?.portions&&draft.guests.every(g=>s.guestIds.includes(g.id));
    const summary=full?'<button type="button" class="owners-summary" data-review-edit="'+esc(s.itemId)+'" aria-expanded="false" aria-label="Edit people for '+esc(lookup.get(s.itemId)?.name||s.itemId)+': all '+draft.guests.length+' people share equally"><span>Everyone · '+draft.guests.length+' equal shares</span><span>Edit</span></button>':'';
    return summary+(reviewPortions(s)?'<p class="review-portions" data-review-portions></p>':'')+'<div class="review-guests" '+(full?'hidden':'')+'>'+draft.guests.map(g=>'<label><input type="checkbox" data-review-guest="'+esc(g.id)+'" '+(s.guestIds.includes(g.id)?'checked':'')+'><span>'+esc(g.name)+'<span data-review-portion="'+esc(g.id)+'"></span></span></label>').join('')+(full?'<button type="button" class="text-button owners-done" data-review-close="'+esc(s.itemId)+'">Done</button>':'')+'</div>';
  };
  const retainable=suggested.suggestions.filter(choice=>!choice.guestIds.length&&currentReviewPeople(choice).length);
  $("suggestions").innerHTML='<div class="assignment-review-heading"><h3 id="assignment-review-title" tabindex="-1">Check who shared each item</h3><p id="review-status" role="status"></p></div><button id="cancel-note-review" type="button" class="text-button">Cancel review · keep receipt edits</button>'+(retainable.length>1?'<div id="keep-other-current-group"><button id="keep-other-current" type="button" class="outline">Keep current people on '+retainable.length+' other items</button><p class="review-help">Each item still needs your confirmation.</p></div>':'')+suggested.suggestions.map(s=>'<fieldset class="suggestion" data-review-item="'+esc(s.itemId)+'"><legend>'+esc(lookup.get(s.itemId)?.name||s.itemId)+' · '+fmt(lookup.get(s.itemId)?.cents||0)+'</legend><small>'+esc(s.reason)+'</small>'+reviewPeople(s)+'<p class="review-needed" '+(s.guestIds.length?'hidden':'')+'>Choose who shared this item.</p>'+currentPeopleAction(s)+'<label class="review-confirm"><input type="checkbox" data-review-confirm="'+esc(s.itemId)+'"> I checked who shared this item</label></fieldset>').join('')+'<section id="proposal-cost" class="proposal-cost" aria-label="Proposed guest totals"></section><button id="apply-ai" class="primary" type="button">USE REVIEWED ASSIGNMENTS →</button>';
  updateReviewStatus();refreshProposalCost();
}
function setReviewedOwners(item,guestIds,adopting=false){
  const samePeople=item.sharedBy.length===guestIds.length&&item.sharedBy.every(id=>guestIds.includes(id));
  if(!samePeople){if(adopting&&item.portions)portionResets.add(item.id);delete item.portions;}
  item.sharedBy=[...guestIds];
}
async function refreshProposalCost(){
  const generation=++previewGeneration;
  previewReady=false;updateReviewStatus();
  const panel=$("proposal-cost");
  document.querySelector(".receipt-heading").textContent="Proposed guest totals";
  $("money-label").textContent="REVIEW SHARES";$("money-state").textContent="Calculating these choices…";
  $("dues").replaceChildren();$("subtotal").replaceChildren();$("grand-total").replaceChildren();
  try{syncRoot();}catch(error){
    $("money-state").textContent="Correct the receipt amount to update proposed totals.";
    panel.innerHTML='<h3>Check receipt amounts</h3><p>'+esc(error.message)+'</p>';
    return;
  }
  $("suggestions").querySelectorAll("[data-review-item]").forEach(row=>{
    const item=draft.items.find(item=>item.id===row.dataset.reviewItem);
    row.querySelector("legend").textContent=item.name+" · "+(Number.isSafeInteger(item.cents)&&item.cents>=1&&item.cents<=10000000?fmt(item.cents):"Check price");
  });
  const invalidPrice=draft.items.find(item=>!Number.isSafeInteger(item.cents)||item.cents<1||item.cents>10000000);
  if(invalidPrice){
    $("money-state").textContent="Correct the receipt price to update proposed totals.";
    panel.innerHTML='<h3>Check receipt amounts</h3><p>Enter a valid price for '+esc(invalidPrice.name)+'.</p>';
    return;
  }
  const proposal=structuredClone(draft);
  for(const item of proposal.items)setReviewedOwners(item,suggested.suggestions.find(s=>s.itemId===item.id)?.guestIds||[]);
  const unresolved=proposal.items.filter(i=>!i.sharedBy.length);
  if(unresolved.length){
    $("money-state").textContent="Choose people for "+unresolved.length+" item(s) to see totals.";
    panel.innerHTML='<h3>Proposed guest totals</h3><p class="preview-incomplete">'+fmt(unresolved.reduce((sum,i)=>sum+i.cents,0))+' of food & drinks still unassigned: '+unresolved.map(i=>esc(i.name)).join(', ')+'.</p><p>Choose who shared every item to see full totals with tax and tip. No saved charges have changed.</p>';return;
  }
  panel.innerHTML='<h3>Proposed guest totals</h3><p role="status">Calculating these choices…</p>';
  try{
    const {calculated}=await reviewedApi("bill/preview",{bill:proposal,revision:saved.bill.revision},"These totals took too long. Your choices are kept; retry when ready.");
    if(generation!==previewGeneration||!suggested)return;
    renderMoney(calculated,proposal,true,true);
    panel.innerHTML='<h3>Proposed guest totals</h3><p>Preview only · includes tax and tip · not saved</p>'+calculated.dues.map(d=>'<details class="preview-guest"><summary><strong>'+esc(d.name)+'</strong><b>'+fmt(d.totalCents)+'</b></summary><ul>'+d.lineItems.map(i=>'<li><span>'+esc(i.name)+(i.portionCount?' · '+i.portionCount+' of '+i.totalPortions+' portions':i.sharedCount>1?' · 1 of '+i.sharedCount+' shares':'')+'</span><span>'+fmt(i.shareCents)+'</span></li>').join('')+'</ul>'+(d.discountCents?'<div class="preview-extra"><span>Receipt discount</span><span>−'+fmt(d.discountCents)+'</span></div>':'')+'<div class="preview-extra"><span>Tax</span><span>'+fmt(d.taxCents)+'</span></div><div class="preview-extra"><span>Tip</span><span>'+fmt(d.tipCents)+'</span></div></details>').join('')+'<div class="preview-total"><span>Table total</span><strong>'+fmt(calculated.totalCents)+'</strong></div>';
    previewReady=true;updateReviewStatus();
  }catch(error){
    if(generation!==previewGeneration||!suggested)return;
    $("money-state").textContent="Proposed totals unavailable.";
    panel.innerHTML='<h3>Totals unavailable</h3><p>'+esc(error.message)+'</p><button type="button" id="retry-preview" class="outline">RETRY TOTALS</button>';
    updateReviewStatus();
  }
}

function updateReviewStatus(){
  $("suggestions").querySelectorAll("[data-review-item]").forEach(row=>updateReviewPortions(row,suggested.suggestions.find(s=>s.itemId===row.dataset.reviewItem)));

  const unresolved=suggested.suggestions.filter(s=>!s.guestIds.length).length;
  const confirmed=suggested.suggestions.filter(s=>s.guestIds.length&&reviewedSuggestions.has(s.itemId)).length;
  $("suggestions").querySelectorAll("[data-review-confirm]").forEach(input=>{const s=suggested.suggestions.find(s=>s.itemId===input.dataset.reviewConfirm);input.checked=reviewedSuggestions.has(s.itemId);input.disabled=busy||!s.guestIds.length;});
  $("suggestions").querySelectorAll("[data-review-current]").forEach(button=>{button.hidden=!!suggested.suggestions.find(s=>s.itemId===button.dataset.reviewCurrent)?.guestIds.length;button.disabled=busy;});
  $("suggestions").querySelectorAll("[data-review-close]").forEach(button=>{const choice=suggested.suggestions.find(s=>s.itemId===button.dataset.reviewClose);button.hidden=!choice||!draft.guests.every(g=>choice.guestIds.includes(g.id));button.disabled=busy;});
  const keepOthers=$("keep-other-current");
  if(keepOthers){const count=suggested.suggestions.filter(choice=>!choice.guestIds.length&&currentReviewPeople(choice).length).length;$("keep-other-current-group").hidden=count<2;keepOthers.textContent="Keep current people on "+count+" other items";keepOthers.disabled=busy;}
  $("cancel-note-review").disabled=busy;
  $("apply-ai").disabled=unresolved>0||confirmed!==suggested.suggestions.length||busy||!previewReady;
  $("review-status").textContent=unresolved?unresolved+" item(s) need your choice before applying.":confirmed+" of "+suggested.suggestions.length+" items confirmed. Check every item before applying.";
}
$("suggestions").addEventListener("change",event=>{
  const input=event.target;if(!suggested||busy)return;
  if(input.matches("[data-review-confirm]")){const choice=suggested.suggestions.find(s=>s.itemId===input.dataset.reviewConfirm);if(input.checked&&choice?.guestIds.length)reviewedSuggestions.add(choice.itemId);else reviewedSuggestions.delete(input.dataset.reviewConfirm);updateReviewStatus();cacheDraft();return;}
  if(!input.matches("[data-review-guest]"))return;
  const row=input.closest("[data-review-item]");const choice=suggested.suggestions.find(s=>s.itemId===row.dataset.reviewItem);
  choice.guestIds=[...row.querySelectorAll("[data-review-guest]:checked")].map(e=>e.dataset.reviewGuest);
  choice.reason="You edited this choice. Check the people before applying.";row.querySelector("small").textContent=choice.reason;
  reviewedSuggestions.delete(choice.itemId);
  row.querySelector(".review-needed").hidden=choice.guestIds.length>0;updateReviewStatus();refreshProposalCost();cacheDraft();
});

function clearReceiptUndo(){receiptUndo=null;for(const id of ["receipt-import-status","guest-removal-status"]){$(id).hidden=true;$(id).replaceChildren();}}
function receiptSnapshot(){
  let cache=null,cacheRead=false;try{cache=sessionStorage.getItem(DRAFT_KEY);cacheRead=true;}catch{}
  return {draft:structuredClone(draft),dirty,setupOpen:setupPanel.open,base:JSON.stringify(saved.bill),cache,cacheRead,pendingRecovery,
    adoptedGuestResponse,adoptedGuestResponses,guestRecoveryIds,
    saveState:$("save-state").textContent,
    recovery:{hidden:$("draft-recovery").hidden,text:$("draft-recovery-text").textContent,backupHidden:$("draft-backup").hidden,reviewHidden:$("review-latest-guests").hidden},
    portionResets:[...portionResets],openPortions:[...openPortions],
    fields:Object.fromEntries(["bill-title","bill-note","discount","tax","tip"].map(id=>[id,$(id).value])),
    prices:Object.fromEntries([...$("items").querySelectorAll(".item")].map(row=>[row.dataset.item,row.querySelector(".item-cents").value])),
    portions:Object.fromEntries([...document.querySelectorAll("[data-portion-guest]")].map(input=>[input.dataset.portionItem+":"+input.dataset.portionGuest,input.value]))};
}
async function importReceipt(receipt,append,photo,signal){
  const generation=editGeneration,table=activeTableId;
  let source;
  if(photo){
    if(!["image/jpeg","image/png","image/webp"].includes(photo.type)||photo.size>20*1024*1024)throw Error("Choose a JPEG, PNG or WebP photo up to 20 MiB.");
    if(append&&(draft.receiptSources?.length||0)>=20)throw Error("Keep at most 20 original receipt photos.");
    const response=await fetch("/tabloom/api/receipt-source?table="+encodeURIComponent(table),{method:"POST",headers:{"content-type":photo.type},body:photo,signal});
    const result=await response.json();if(!response.ok)throw Error(result.error||"The original photo could not be retained. Try again.");
    source=result;
  }
  if(signal?.aborted)return false;
  if(generation!==editGeneration||table!==activeTableId)throw Error("The dinner changed while keeping the photo. Review the receipt again.");
  if(busy)throw Error("Wait for the current operation before importing a receipt.");
  lockEditCheck();
  if((append?draft.items.length:0)+receipt.items.length>60)throw Error("Keep the combined receipt to 60 items or fewer.");
  const adjustments={};
  for(const field of ["discount","tax","tip"])adjustments[field]=(append?formatCents($(field).value):0)+(receipt[field+"Cents"]||0);
  const existingSubtotal=append?[...$("items").querySelectorAll(".item-cents")].reduce((sum,input)=>sum+formatCents(input.value),0):0;
  const subtotal=existingSubtotal+receipt.subtotalCents;
  if(adjustments.discount>subtotal)throw Error("The combined discount cannot exceed the item subtotal.");
  if(subtotal-adjustments.discount+adjustments.tax+adjustments.tip>10000000||Object.values(adjustments).some(amount=>amount>10000000))throw Error("The combined receipt exceeds the $100,000 limit.");
  const previous=receiptSnapshot();
  const items=receipt.items.map(item=>({id:uniqueId("item"),name:item.name,cents:item.cents,sharedBy:[]}));
  draft.items=append?[...draft.items,...items]:items;
  const sources=append?[...(draft.receiptSources||[])]:[];
  if(source&&!sources.some(value=>value.id===source.id))sources.push(source);
  if(sources.length)draft.receiptSources=sources;else delete draft.receiptSources;
  if(!append){portionResets.clear();openPortions.clear();}
  for(const field of ["discount","tax","tip"]){draft[field+"Cents"]=adjustments[field];$(field).value=(adjustments[field]/100).toFixed(2);}
  setupPanel.open=false;$("item-search").value="";renderItems(append);setDirty();receiptUndo={previous,generation:editGeneration,importedIds:items.map(item=>item.id),append};
  $("receipt-import-status").innerHTML='<span>'+items.length+(items.length===1?' item':' items')+(append?' added':' imported')+'</span>'+(items.length>1?'<button type="button" id="share-imported-everyone" class="outline">Share these '+items.length+' with everyone</button>':'')+'<button type="button" id="undo-receipt-import" class="text-button">Undo import</button>';
  $("receipt-import-status").hidden=false;
  stateMsg("Receipt added to your draft. Choose people, then save.");
  requestAnimationFrame(()=>$("receipt-import-status").scrollIntoView({block:"nearest"}));
}
function handleReceiptUndo(event){
  if(event.target.id==="share-imported-everyone"){
    if(!receiptUndo||busy)return;
    try{
      lockEditCheck();
      const {importedIds,generation,previous:beforeImport}=receiptUndo;
      if(!importedIds||generation!==editGeneration||beforeImport.base!==JSON.stringify(saved.bill)){clearReceiptUndo();return;}
      const items=importedIds.map(id=>draft.items.find(item=>item.id===id));
      if(!draft.guests.length||items.some(item=>!item||item.sharedBy.length||item.portions)){clearReceiptUndo();return;}
      const importUndo=receiptUndo,importNotice=$("receipt-import-status").innerHTML;
      const previous=receiptSnapshot();
      for(const item of items)item.sharedBy=draft.guests.map(guest=>guest.id);
      renderItems(true);setDirty();receiptUndo={previous,generation:editGeneration,sharedImport:true,importUndo,importNotice};
      $("receipt-import-status").innerHTML='<span>Everyone shares these '+items.length+' items · not saved</span><button type="button" id="undo-receipt-sharing" class="text-button">Undo sharing</button>';
      $("receipt-import-status").hidden=false;
      $("undo-receipt-sharing").focus({preventScroll:true});
      stateMsg("Everyone shares the imported items. Check any exceptions, then save.");
    }catch(error){stateMsg(error.message,true);}
    return;
  }
  if(!["undo-receipt-import","undo-receipt-removal","undo-receipt-sharing","undo-guest-removal"].includes(event.target.id)||!receiptUndo||busy)return;
  const {previous,generation,removedItem,removedGuest,sharedImport,importUndo,importNotice}=receiptUndo;
  if(generation!==editGeneration||previous.base!==JSON.stringify(saved.bill)){clearReceiptUndo();stateMsg("The table changed after this action. Your latest edits have been kept.",true);return;}
  draft=previous.draft;setupPanel.open=previous.setupOpen;
  for(const [id,value]of Object.entries(previous.fields))$(id).value=value;
  portionResets.clear();for(const id of previous.portionResets)portionResets.add(id);
  openPortions.clear();for(const id of previous.openPortions)openPortions.add(id);
  if(removedItem)$("item-search").value="";
  renderGuests();renderItems();
  for(const row of $("items").querySelectorAll(".item"))if(Object.hasOwn(previous.prices,row.dataset.item))row.querySelector(".item-cents").value=previous.prices[row.dataset.item];
  for(const input of document.querySelectorAll("[data-portion-guest]")){const value=previous.portions[input.dataset.portionItem+":"+input.dataset.portionGuest];if(value!==undefined)input.value=value;}
  setDirty();
  dirty=previous.dirty;pendingRecovery=previous.pendingRecovery;
  adoptedGuestResponse=previous.adoptedGuestResponse;adoptedGuestResponses=previous.adoptedGuestResponses;guestRecoveryIds=previous.guestRecoveryIds;
  $("save-state").textContent=previous.saveState;
  $("draft-recovery").hidden=previous.recovery.hidden;$("draft-recovery-text").textContent=previous.recovery.text;
  $("draft-backup").hidden=previous.recovery.backupHidden;$("review-latest-guests").hidden=previous.recovery.reviewHidden;
  if(previous.cacheRead)try{if(previous.cache===null)sessionStorage.removeItem(DRAFT_KEY);else sessionStorage.setItem(DRAFT_KEY,previous.cache);}catch{}
  if(!dirty)renderMoney();renderPayments();refreshSetupSummary();
  if(sharedImport&&importUndo){receiptUndo={...importUndo,generation:editGeneration};$("receipt-import-status").innerHTML=importNotice;$("receipt-import-status").hidden=false;$("share-imported-everyone")?.focus({preventScroll:true});}
  if(removedItem){[...$("items").querySelectorAll(".item")].find(row=>row.dataset.item===removedItem)?.querySelector(".item-name")?.focus();}
  if(removedGuest){[...$("guests").querySelectorAll(".guest-name")].find(input=>input.dataset.guest===removedGuest)?.focus();}
  stateMsg(removedGuest?"Guest restored with their original items and portions.":removedItem?"Item restored. Your previous receipt edits are back.":sharedImport?"Sharing undone. Choose who shared the imported items.":"Import undone. Your previous receipt is restored.");
}
$("receipt-import-status").addEventListener("click",handleReceiptUndo);
$("guest-removal-status").addEventListener("click",handleReceiptUndo);


// chat intake
initChatIntake({
  getDraft:()=>draft,
  addGuests:names=>{try{lockEditCheck();for(const name of names){if(draft.guests.length>=12)break;draft.guests.push({id:uniqueId("guest"),name});}renderGuests();renderItems(true);setDirty();}catch(e){stateMsg(e.message,true);}},
  setNote:text=>{$("bill-note").value=text;$("bill-note").dispatchEvent(new Event("input",{bubbles:true}));},
  startSuggest:()=>{if($("suggest").disabled){stateMsg("Import or enter the receipt items first, then suggest splits.",true);return;}document.querySelector("details.assistant-card").open=true;$("suggest").click();}
});
function uniqueId(prefix){return prefix+"-"+crypto.randomUUID().replaceAll("-","").slice(0,12);}
$("bill-note").addEventListener("input",setDirty);
for(const id of ["bill-title","discount","tax","tip"])$(id).addEventListener("input",()=>setDirty({keepNoteReview:true}));
$("guests").addEventListener("input",event=>{
  if(!event.target.matches(".guest-name"))return;
  const g=draft.guests.find(g=>g.id===event.target.dataset.guest);if(g){g.name=event.target.value;renderItems(true);setDirty();}
});
$("items").addEventListener("input",event=>{
  const row=event.target.closest(".item");if(!row)return;
  const item=draft.items.find(i=>i.id===row.dataset.item);if(!item)return;
  if(event.target.matches(".item-name")){item.name=event.target.value;sizeItemNames();}
  if(event.target.matches(".item-cents")){try{item.cents=formatCents(event.target.value);}catch{item.cents=-1;}}
  if(event.target.matches("[data-portion-guest]")){item.portions[event.target.dataset.portionGuest]=Number(event.target.value);row.querySelector(".portion-editor summary").textContent="Portions · "+item.sharedBy.map(id=>draft.guests.find(g=>g.id===id).name+" "+item.portions[id]).join(" · ");}
  if(event.target.matches("[data-share]")){if(draft.guests.length>=5)openOwners.add(item.id);if(item.portions)portionResets.add(item.id);delete item.portions;item.sharedBy=Array.from(row.querySelectorAll("[data-share]:checked")).map(input=>input.value);const focusedGuest=event.target.value;renderItems(true);[...document.querySelectorAll("[data-share]")].find(input=>input.dataset.share===item.id&&input.value===focusedGuest)?.focus({preventScroll:true});}
  setDirty({keepNoteReview:event.target.matches(".item-cents")});
});
$("guests").addEventListener("click",event=>{
  const id=event.target.dataset.removeGuest;if(!id)return;
  try{
    if(busy)return;
    lockEditCheck();if(draft.guests.length<=2)throw Error("Keep at least two guests.");
    const guest=draft.guests.find(g=>g.id===id);if(!guest)return;
    const previous=receiptSnapshot();
    draft.guests=draft.guests.filter(g=>g.id!==id);
    for(const item of draft.items){if(item.sharedBy.includes(id)){if(item.portions)portionResets.add(item.id);delete item.portions;}item.sharedBy=item.sharedBy.filter(g=>g!==id);}
    renderGuests();renderItems(true);setDirty();
    receiptUndo={previous,generation:editGeneration,removedGuest:id};
    $("guest-removal-status").innerHTML='<span>'+esc(guest.name||"Guest")+' removed</span><button type="button" id="undo-guest-removal" class="text-button">Undo removal</button>';
    $("guest-removal-status").hidden=false;$("undo-guest-removal").focus();

  }catch(error){stateMsg(error.message,true);}
});
$("items").addEventListener("click",event=>{
  const ownerButton=event.target.closest("[data-edit-owners],[data-close-owners]");
  if(ownerButton){
    if(busy)return;
    const id=ownerButton.dataset.editOwners||ownerButton.dataset.closeOwners;
    if(ownerButton.dataset.editOwners)openOwners.add(id);else openOwners.delete(id);
    renderItems(true);
    const selector=ownerButton.dataset.editOwners?"[data-share]":"[data-edit-owners]";
    [...document.querySelectorAll(selector)].find(control=>(control.dataset.share||control.dataset.editOwners)===id)?.focus({preventScroll:true});
    return;
  }


  const clearPeopleId=event.target.dataset.clearPeople;
  if(clearPeopleId){
    try{
      lockEditCheck();
      const item=draft.items.find(i=>i.id===clearPeopleId);
      if(!item||!item.sharedBy.length)return;
      if(item.portions)portionResets.add(item.id);
      delete item.portions;
      item.sharedBy=[];
      openOwners.add(item.id);
      renderItems(true);setDirty();
      [...document.querySelectorAll("[data-share]")].find(input=>input.dataset.share===item.id)?.focus({preventScroll:true});
    }catch(error){stateMsg(error.message,true);}
    return;
  }
  const everyoneId=event.target.dataset.shareEveryone;
  if(everyoneId){
    try{
      lockEditCheck();
      const item=draft.items.find(i=>i.id===everyoneId);
      if(!item||draft.guests.every(g=>item.sharedBy.includes(g.id)))return;
      if(item.portions)portionResets.add(item.id);
      delete item.portions;
      item.sharedBy=draft.guests.map(g=>g.id);
      openOwners.delete(item.id);
      renderItems(true);setDirty();
      [...document.querySelectorAll("[data-share],[data-edit-owners]")].find(input=>(input.dataset.share||input.dataset.editOwners)===item.id)?.focus({preventScroll:true});
    }catch(error){stateMsg(error.message,true);}
    return;
  }

  const portionId=event.target.dataset.portions||event.target.dataset.equalPortions;
  if(portionId){
    try{lockEditCheck();const item=draft.items.find(i=>i.id===portionId);portionResets.delete(item.id);if(event.target.dataset.equalPortions)delete item.portions;else {item.portions=Object.fromEntries(item.sharedBy.map(id=>[id,1]));openPortions.add(item.id);}renderItems(true);setDirty();}catch(error){stateMsg(error.message,true);}
    return;
  }
  if(event.target.id==="first-item"){$("add-item").click();document.querySelector(".item-name")?.focus();return;}
  const id=event.target.dataset.removeItem;if(!id)return;
  try{
    lockEditCheck();if(draft.items.length<=1)throw Error("Keep at least one item.");
    const item=draft.items.find(i=>i.id===id);if(!item)return;
    const previous=receiptSnapshot();
    draft.items=draft.items.filter(i=>i.id!==id);renderItems(true);setDirty();
    receiptUndo={previous,generation:editGeneration,removedItem:id};
    $("receipt-import-status").innerHTML='<span>'+esc(item.name||"Item")+' removed</span><button type="button" id="undo-receipt-removal" class="text-button">Undo removal</button>';
    $("receipt-import-status").hidden=false;$("undo-receipt-removal").focus();
  }catch(e){stateMsg(e.message,true);}
});
$("add-guest").addEventListener("click",()=>{
  try{lockEditCheck();if(draft.guests.length>=12)throw Error("Maximum 12 guests.");draft.guests.push({id:uniqueId("guest"),name:"New guest"});renderGuests();renderItems(true);setDirty();const name=$("guests").querySelector(".guest:last-child .guest-name");name?.focus();name?.select();}catch(e){stateMsg(e.message,true);}
});
$("add-item").addEventListener("click",()=>{
  try{lockEditCheck();if(draft.items.length>=60)throw Error("Maximum 60 items.");draft.items.push({id:uniqueId("item"),name:"",cents:0,sharedBy:[]});$("item-search").value="";renderItems(true);setDirty();$("items").querySelector(".item:last-child .item-name")?.focus();}catch(e){stateMsg(e.message,true);}
});
function adoptSavedUpdate(result,submittedGeneration){
  saved={...saved,...result};
  if(editGeneration===submittedGeneration){clearDraftCache();renderEverything();return;}
  // The response saved the submitted snapshot; keep all subsequently typed input.
  draft.revision=saved.bill.revision;
  pendingRecovery=null;dirty=true;cacheDraft();
  renderMoney();renderPayments();scheduleDraftTotal();
  $("save-state").textContent="Newer edits are still unsaved";
  $("draft-recovery").hidden=false;$("draft-backup").hidden=false;
  $("draft-recovery-text").textContent="The earlier version was saved. Your newer edits remain here and in this tab's recovery draft. Save & Recalculate again to include them; payment stays blocked.";
}
async function action(fn,success,quietSuccess=false){
  if(busy)return;busy=true;guestResponseView.setBusy(true);$("save").disabled=true;tableNavigationBusy();renderGuestBatchControls();
  try{await fn();stateMsg(typeof success==="function"?success():success,false,typeof quietSuccess==="function"?quietSuccess():quietSuccess);}catch(e){stateMsg(e.message,true);}finally{busy=false;syncFileResponseSelection();guestResponseView.setBusy(false);$("save").disabled=Object.keys(saved.bill.payments).length>0;tableNavigationBusy();renderPayments();if(suggested&&$("apply-ai"))updateReviewStatus();}
}
$("save").addEventListener("click",()=>{
  if(busy)return;
  if(!dirty&&saved.bill.items.length){window.addEventListener("hashchange",()=>window.scrollTo({top:0,behavior:"instant"}),{once:true});location.hash="guest-checkout";return;}
  let checkedSave=false;
  return action(async()=>{
  lockEditCheck();syncRoot();
  const unassigned=draft.items.filter(item=>!item.sharedBy.length);
  if(unassigned.length)throw Error("Choose who pays for: "+unassigned.map(item=>item.name).join(", ")+". No bill changes were saved.");
  const badPortions=draft.items.find(item=>item.portions&&Object.values(item.portions).some(n=>!Number.isSafeInteger(n)||n<1||n>1000));
  if(badPortions)throw Error("Use 1–1000 whole portions for each person sharing "+badPortions.name+". No bill changes were saved.");
  const submittedGeneration=editGeneration;
  let result;
  try{result=await reviewedApi("bill",{bill:draft,revision:saved.bill.revision,...(adoptedGuestResponse?{guestResponse:adoptedGuestResponse}:{}),...(adoptedGuestResponses?{guestResponses:adoptedGuestResponses}:{})},"Save could not be confirmed. Your edits are still here.");}
  catch(error){
    // A lost response may have saved successfully. Observe before another save,
    // and retain the exact raw draft if the saved receipt changed meanwhile.
    let current;
    try{current=await reviewedApi("state",undefined,"Could not check the saved receipt. Your edits are still here.");}catch{}
    if(current&&(current.bill.revision!==saved.bill.revision||Object.keys(current.bill.payments).length)){
      if(cacheDraft()!==true)throw Error("The saved receipt changed. Your edits are still here; browser recovery is unavailable.");
      saved=current;renderEverything();recoverDraft();
      checkedSave=true;return;
    }
    const identities=adoptedGuestResponses||(adoptedGuestResponse?[adoptedGuestResponse]:[]);
    if(identities.length){
      guestRecoveryIds=identities.map(identity=>identity.id);
      $("draft-recovery").hidden=false;$("draft-backup").hidden=false;$("review-latest-guests").hidden=false;
      $("draft-recovery-text").textContent="Your unsaved choices are still here. Discard this draft to review the latest replies from the same selected guests.";
      $("draft-recovery").scrollIntoView({block:"nearest"});
    }
    throw error;
  }
  adoptSavedUpdate(result,submittedGeneration);
},()=>checkedSave?"Saved receipt checked.":dirty?"Earlier version saved. Your newer edits are still unsaved; Save again when ready.":"Bill saved. The receipt and each participant's exact-cent balance are updated.",()=>checkedSave||!dirty);
});
function focusManualAssignment(){
  clearItemSearch();
  const unassigned=draft.items.find(item=>!item.sharedBy.length);
  const rows=Array.from($("items").querySelectorAll(".item"));
  const row=rows.find(row=>row.dataset.item===unassigned?.id)||rows[0];
  const target=row?.querySelector("[data-share],[data-edit-owners]")||$("first-item");
  if(target){target.scrollIntoView({block:"center",behavior:"smooth"});target.focus({preventScroll:true});}
}
$("suggest").addEventListener("click",()=>{
  let stoppedFor=null;
  return action(async()=>{
    lockEditCheck();syncRoot();
    const generation=editGeneration;
    suggested=null;renderSuggestions();cacheDraft();
    const request=new AbortController();aiRequest=request;
    const started=performance.now();
    $("suggestions").innerHTML='<p class="ai-reading" role="status">Reading receipt… <span id="ai-elapsed" aria-hidden="true">0s</span></p><div class="ai-recovery-actions"><button id="cancel-ai" class="outline" type="button">CHOOSE PEOPLE MYSELF</button></div>';
    const timer=setInterval(()=>{const clock=$("ai-elapsed");if(clock)clock.textContent=Math.floor((performance.now()-started)/1000)+"s";},1000);
    let proposal;
    try{
      proposal=await api("suggest",{bill:draft,revision:saved.bill.revision},request.signal);
    }catch(error){
      suggested=null;reviewedSuggestions.clear();
      if(request.signal.aborted){
        stoppedFor=request.signal.reason;
        $("suggestions").replaceChildren();
        if(stoppedFor==="manual")focusManualAssignment();
        return;
      }
      $("suggestions").innerHTML='<p role="alert"><strong>Review unavailable</strong><br>'+esc(error.message)+'</p><div class="ai-recovery-actions"><button id="assign-manually" class="primary" type="button">CHOOSE PEOPLE MYSELF →</button> <button id="retry-ai" class="outline" type="button">TRY AGAIN</button></div>';
      throw error;
    }finally{
      clearInterval(timer);
      if(aiRequest===request)aiRequest=null;
    }
    if(generation!==editGeneration){$("suggestions").textContent="The receipt changed. Review it again when ready.";throw Error($("suggestions").textContent);}
    suggested=proposal;reviewedSuggestions.clear();renderSuggestions();cacheDraft();
    requestAnimationFrame(()=>{
      if(suggested!==proposal)return;
      const title=$("assignment-review-title");
      title.focus({preventScroll:true});
      $("suggestions").scrollIntoView({block:"start",behavior:"auto"});
    });
  },()=>stoppedFor?(stoppedFor==="manual"?"Choose who shared each item.":"Your receipt edits are ready for review."):"Review the suggested people.");
});
$("suggestions").addEventListener("click",event=>{
  if(event.target.id==="cancel-note-review"){
    if(busy||!suggested)return;
    suggested=null;reviewedSuggestions.clear();renderSuggestions();cacheDraft();
    if(dirty)scheduleDraftTotal();else renderMoney();
    document.querySelector(".assistant-card").open=false;
    focusManualAssignment();stateMsg("Review cancelled. Your receipt edits are still here.");return;
  }
  const closePeople=event.target.closest("[data-review-close]");
  if(closePeople){
    if(busy||!suggested)return;
    const choice=suggested.suggestions.find(s=>s.itemId===closePeople.dataset.reviewClose);
    if(!choice||!draft.guests.every(g=>choice.guestIds.includes(g.id)))return;
    const row=closePeople.closest("[data-review-item]"),summary=row.querySelector("[data-review-edit]");
    row.querySelector(".review-guests").hidden=true;summary.hidden=false;summary.setAttribute("aria-expanded","false");summary.focus();return;
  }
  const editPeople=event.target.closest("[data-review-edit]");
  if(editPeople){
    if(busy||!suggested)return;
    const row=editPeople.closest("[data-review-item]");
    editPeople.hidden=true;editPeople.setAttribute("aria-expanded","true");
    row.querySelector(".review-guests").hidden=false;row.querySelector("[data-review-guest]").focus();return;
  }
  const keep=event.target.closest("[data-review-current]");
  if(keep||event.target.id==="keep-other-current"){
    if(!suggested||busy)return;
    const choices=keep?suggested.suggestions.filter(choice=>choice.itemId===keep.dataset.reviewCurrent):suggested.suggestions.filter(choice=>!choice.guestIds.length&&currentReviewPeople(choice).length);
    let first;
    for(const choice of choices){
      if(choice.guestIds.length)continue;
      choice.guestIds=currentReviewPeople(choice).map(guest=>guest.id);
      if(!choice.guestIds.length)continue;
      choice.reason="You kept the current people. Check this choice before applying.";
      reviewedSuggestions.delete(choice.itemId);
      const row=[...$("suggestions").querySelectorAll("[data-review-item]")].find(row=>row.dataset.reviewItem===choice.itemId);
      row.querySelector("small").textContent=choice.reason;
      row.querySelectorAll("[data-review-guest]").forEach(input=>{input.checked=choice.guestIds.includes(input.dataset.reviewGuest);});
      row.querySelector(".review-needed").hidden=true;first??=row;
    }
    updateReviewStatus();refreshProposalCost();cacheDraft();
    first?.querySelector("[data-review-confirm]").focus();return;
  }
  if(event.target.id==="cancel-ai"){aiRequest?.abort("manual");return;}
  if(event.target.id==="retry-preview"){refreshProposalCost();return;}
  if(event.target.id==="retry-ai"){if(!busy)$("suggest").click();return;}
  if(event.target.id==="assign-manually"){
    if(busy)return;
    focusManualAssignment();
    stateMsg("Choose who shared each receipt item, then Save & Recalculate. Your draft has not been saved.");
    return;
  }
  if(event.target.id==="save-reviewed"){$("save").click();return;}
  if(event.target.id!=="apply-ai")return;
  action(async()=>{
    lockEditCheck();
    if(!previewReady)throw Error("Wait for the proposed totals before using these assignments.");
    const costPreview=$("proposal-cost").outerHTML;
    if(!suggested||suggested.suggestions.some(s=>!s.guestIds.length||!reviewedSuggestions.has(s.itemId)))throw Error("Choose the people and confirm every item before using these assignments.");
    for(const choice of suggested.suggestions)setReviewedOwners(draft.items.find(item=>item.id===choice.itemId),choice.guestIds,true);
    renderItems();setDirty();
    $("suggestions").innerHTML=costPreview+'<p role="status">Reviewed assignments are in your unsaved draft. Save to update the receipt and balances.</p><button id="save-reviewed" class="primary" type="button">SAVE &amp; RECALCULATE →</button>';
  },"Reviewed assignments are in your unsaved draft. Save & Recalculate to update balances; no saved bill or payment changed.");
});

let tableInvitations=[];
function renderTableInvitation(){
  const button=$("invite-table"),host=$("table-invitation");
  const allowed=!!saved?.bill.items.length&&!Object.keys(saved?.bill.payments||{}).length;
  button.hidden=!allowed;button.disabled=dirty||busy;
  const group=tableInvitations.find(g=>g.revision===saved?.bill.revision);
  if(!group||!allowed){host.hidden=true;host.replaceChildren();return;}
  const open=host.querySelector("details")?.open||false;
  host.hidden=false;
  host.innerHTML='<details class="guest-link-qr"><summary>Table QR · '+esc(group.guestCount)+' diners</summary><p>Each diner chooses their name and sends item choices.</p><img src="'+esc(group.qr)+'" alt="QR to join '+esc(group.title)+'" width="270" height="270"><details class="guest-link-address"><summary>Copy table link</summary><label>TABLE INVITATION<input readonly value="'+esc(group.url)+'" aria-label="Table invitation link"></label><button type="button" class="text-button" data-copy-table-invitation>COPY LINK</button></details><button type="button" class="text-button" data-stop-table-invitation="'+esc(group.id)+'">STOP TABLE INVITATION</button></details>';
  host.querySelector("details").open=open;
}
async function inviteTable(){
  const names=new Set();
  const duplicate=saved.bill.guests.find(guest=>{
    const name=guest.name.normalize("NFKC").trim().replace(/\s+/g," ").toLocaleLowerCase("en-US");
    if(names.has(name))return true;names.add(name);return false;
  });
  if(duplicate){
    location.hash="receipt";showWorkspace();$("table-setup").open=true;
    const input=[...$("guests").querySelectorAll(".guest-name")].find(field=>field.dataset.guest===duplicate.id);
    stateMsg('Give each diner a distinct name. Add a surname or nickname to "'+duplicate.name+'", then Save the receipt.',true);
    let notice=$("distinct-guest-name-status");
    if(!notice){notice=document.createElement("p");notice.id="distinct-guest-name-status";notice.className="receipt-import-status";notice.setAttribute("role","status");$("guests").after(notice);}
    notice.textContent='Add a surname or nickname so each diner can recognize their name, then Save the receipt.';

    if(input){input.scrollIntoView({block:"center"});input.focus({preventScroll:true});input.select();}
    return;
  }
  return action(async()=>{
    if(dirty||Object.keys(saved.bill.payments).length)throw Error("Save the receipt before inviting the table to choose items.");
    const group=await api("guest-links/create-group",{});
    await refreshGuestLinks();
    const qr=$("table-invitation").querySelector("details");
    if(qr){qr.open=true;qr.querySelector("summary").focus({preventScroll:true});qr.scrollIntoView({block:"start"});}
  },"Table invitation ready. Everyone with this code can choose a diner; payment links stay separate.");
}
$("invite-table").addEventListener("click",()=>{
  if(dirty||busy)return;
  if(saved.guestLinksReady){pendingInvite=null;void inviteTable();return;}
  pendingInvite={group:true,revision:saved.bill.revision};renderPendingInvite();
  const settings=$("invitation-settings");settings.open=true;settings.scrollIntoView({block:"start"});
  ($("guest-network-address")||settings.querySelector("button")||settings.querySelector("summary")).focus({preventScroll:true});
});
$("table-invitation").addEventListener("click",event=>{
  const stop=event.target.closest("[data-stop-table-invitation]");
  if(stop){void action(async()=>{await api("guest-links/revoke-group",{id:stop.dataset.stopTableInvitation});await refreshGuestLinks();},"Table invitation stopped. Received replies remain available for review.");return;}
  if(event.target.closest("[data-copy-table-invitation]")){
    const input=$("table-invitation").querySelector("input");input.select();
    void navigator.clipboard?.writeText(input.value).catch(()=>input.focus());
  }
});

async function inviteGuest(guestId){
  return action(async()=>{if(dirty)throw Error("Save your current receipt first.");const invitation=await api("guest-links/create",{guestId:guestId});await refreshGuestLinks();const row=[...document.querySelectorAll(".guest-link-row")].find(row=>row.dataset.invitationId===invitation.id);const qr=row?.querySelector(".guest-link-qr");if(qr){qr.open=true;qr.querySelector("summary").focus({preventScroll:true});qr.scrollIntoView({block:"start"});}else (row||$("guest-links-desk")).scrollIntoView({block:"start"});},"Guest link ready. Give that private link only to the named guest on your network.");
}
function downloadGuestReview(guestId){
  return action(async()=>{
    if(dirty)throw Error("Save your current edits before preparing a guest review.");
    if(Object.keys(saved.bill.payments).length)throw Error("Item review is closed while payment requests exist.");
    const packet=await api("guest-review/export",{guestId});
    downloadGuestFile(renderGuestReview(packet),"text/html;charset=utf-8",guestFileName(packet,"review","html"));
  },"Review form downloaded. Send it to the guest, then import their response below.");
}
$("invite-review-file").addEventListener("click",()=>{
  const intent=pendingInvite;
  if(!intent||dirty||busy||saved.bill.revision!==intent.revision)return;
  void downloadGuestReview(intent.guestId);
});
$("invitation-settings").addEventListener("toggle",()=>{if(!$("invitation-settings").open){pendingInvite=null;renderPendingInvite();}});
$("payments").addEventListener("click",event=>{
  const button=event.target.closest("button");if(!button)return;
  if(button.dataset.inviteSetup){
    if(dirty||busy)return;
    pendingInvite={guestId:button.dataset.inviteSetup,revision:saved.bill.revision};renderPendingInvite();
    const settings=$("invitation-settings");settings.open=true;settings.scrollIntoView({block:"start"});
    ($("guest-network-address")||settings.querySelector("button")||settings.querySelector("summary")).focus({preventScroll:true});
    return;
  }
  if(button.dataset.guestLink){
    pendingInvite=null;
    void inviteGuest(button.dataset.guestLink);
    return;
  }
  if (button.dataset.guestReview) {
    void downloadGuestReview(button.dataset.guestReview);
    return;
  }
  if (button.dataset.receipt) {
    try {downloadReceipt(button.dataset.receipt);stateMsg("Guest receipt exported from saved revision "+saved.bill.revision+". It is a snapshot for review, not proof of payment.");}
    catch(e){stateMsg(e.message,true);}
    return;
  }
  if(button.dataset.refreshPayment){
    const guestId=button.dataset.refreshPayment;
    action(async()=>{
      paymentFeedback.set(guestId,{text:"Refreshing saved payment status…",refreshRequired:true});renderPayments();
      try{
        saved=await api("state");renderMoney();
        paymentFeedback.set(guestId,{text:"Saved status refreshed. Check this guest’s status and available actions above."});
      }catch(error){
        paymentFeedback.set(guestId,{error:true,refreshRequired:true,text:"Saved status is still unavailable. Payment controls remain paused; try refreshing again."});
        throw error;
      }
    },"Saved payment status refreshed.");
    return;
  }
  const id=button.dataset.pay||button.dataset.capture||button.dataset.reconcile;
  const method=button.dataset.pay?"order":button.dataset.capture?"capture":"reconcile";
  if(!id||busy)return;
  const pending=method==="order"?"Requesting this guest’s Sandbox order…":method==="capture"?"Checking this guest’s approved Sandbox payment…":"Reading this guest’s current PayPal order status…";
  const success=method==="order"?"Order response received. Check this guest’s status and approval link above.":method==="capture"?"Capture response received. Only CAPTURED confirms completed payment.":"PayPal status checked. This guest’s current status is shown above.";
  action(async()=>{
    if(dirty)throw Error("Save your edits first.");
    if(paymentFeedback.get(id)?.refreshRequired)throw Error("Refresh saved status before another payment action.");
    paymentFeedback.set(id,{text:pending});renderPayments();
    try{
      await api("payments/"+encodeURIComponent(id)+"/"+method,{revision:saved.bill.revision});
    }catch(error){
      // A failed response can follow a persisted unknown state. Observe it without
      // repeating the payment request, so recovery controls reflect durable truth.
      let refreshed=false;
      try{saved=await api("state");renderMoney();refreshed=true;}catch{}
      paymentFeedback.set(id,{error:true,refreshRequired:!refreshed,text:error.message+(refreshed?" Saved status refreshed above; use its available recovery action.":" Could not refresh saved status. Reload and check before trying again.")});
      renderPayments();throw error;
    }
    try{saved=await api("state");renderMoney();}
    catch(error){
      const message="The request returned, but its saved status could not be refreshed. Reload and check before trying again.";
      paymentFeedback.set(id,{error:true,refreshRequired:true,text:message});renderPayments();throw Error(message);
    }
    paymentFeedback.set(id,{text:success});renderPayments();refreshTables();if(method==="order")await refreshGuestLinks();
  },success);
});
window.addEventListener("pageshow",event=>{if(event.persisted){location.reload();return;}if(saved&&new URLSearchParams(location.search).has("returned"))stateMsg("Back at "+saved.bill.title+". Check the PayPal status; nothing was silently captured.");});
(async()=>{
  try{saved=await api("state");rememberOpenedTable();renderEverything();recoverDraft();receiptIntake.checkRecovery();stateMsg(activeTableId==="legacy"&&saved.bill.revision===0&&!Object.keys(saved.bill.payments).length?"Example table ready. Create a new table for your dinner, or edit this sample.":"Table ready: "+saved.bill.title+". Each dinner keeps its own receipt and payment history.");if(new URLSearchParams(location.search).has("returned"))stateMsg("Back at "+saved.bill.title+". Check the PayPal status; nothing was silently captured.");else $("message").hidden=true;}
  catch(e){stateMsg("Unable to open the saved table: "+e.message,true);}
})();

function downloadGuestFile(content,type,name){
  const url=URL.createObjectURL(new Blob([content],{type}));
  const link=document.createElement("a");link.href=url;link.download=name;link.click();
  setTimeout(()=>URL.revokeObjectURL(url),5000);
}
function offerFreshGuestForms(responses){
  const host=$("file-response-recovery");
  if(dirty||Object.keys(saved.bill.payments).length)return;
  const ids=new Set(responses.filter(response=>response?.kind==="tabloom-guest-response"&&response.version===1&&response.tableId===activeTableId&&Number.isSafeInteger(response.revision)&&response.revision>=0&&response.revision<saved.bill.revision).map(response=>response.guestId));
  for(const guest of saved.bill.guests.filter(guest=>ids.has(guest.id))){
    const button=document.createElement("button");button.type="button";button.className="outline";
    button.dataset.freshGuestForm=guest.id;button.disabled=busy;
    button.textContent="Download "+guest.name+"’s new form";host.append(button);
  }
  host.hidden=!host.childElementCount;
}
$("file-response-recovery").addEventListener("click",event=>{
  const button=event.target.closest("[data-fresh-guest-form]");
  if(!button||busy||dirty||button.disabled)return;
  void downloadGuestReview(button.dataset.freshGuestForm);
});

let heldGuestFiles=null;
function syncFileResponseSelection(){
  if(!heldGuestFiles)return;
  const selected=heldGuestFiles.filter(entry=>entry.preview&&entry.selected);
  const duplicate=new Set(selected.map(entry=>entry.response.guestId)).size!==selected.length;
  const locked=busy||dirty||Object.keys(saved.bill.payments).length>0;
  $("file-response-recovery").querySelectorAll("[data-file-response-select]").forEach(input=>{input.disabled=locked;});
  const button=$("review-file-responses");if(button){button.disabled=locked||!selected.length||duplicate;button.textContent="Review "+selected.length+" selected "+(selected.length===1?"reply":"replies");}
  const hint=$("file-response-selection-note");if(hint)hint.textContent=duplicate?"Choose one reply per diner.":selected.length?"Review these choices before saving.":"Select a current reply to review.";
}
function showHeldGuestFiles(entries){
  heldGuestFiles=entries;
  const host=$("file-response-recovery");host.replaceChildren();host.classList.add("file-response-selection");
  const list=document.createElement("div");list.className="file-response-list";
  entries.forEach((entry,index)=>{
    const row=document.createElement("div");row.className="file-response-entry";
    if(entry.preview){
      const label=document.createElement("label"),input=document.createElement("input"),copy=document.createElement("span");
      input.type="checkbox";input.checked=entry.selected;input.dataset.fileResponseSelect=String(index);
      const name=document.createElement("strong");name.textContent=entry.preview.guest;
      const filename=document.createElement("small");filename.textContent=entry.name;
      const changes=document.createElement("small");changes.className="file-response-changes";
      const describe=change=>(change.selected?"Add ":"Remove ")+change.name;
      changes.textContent=entry.preview.changes.length?entry.preview.changes.slice(0,3).map(describe).join(" · "):"Same choices as the saved receipt";
      copy.append(name,filename,changes);label.append(input,copy);row.append(label);
      if(entry.preview.changes.length>3){
        const more=document.createElement("details"),heading=document.createElement("summary"),items=document.createElement("ul");
        heading.textContent=(entry.preview.changes.length-3)+" more item changes";
        for(const change of entry.preview.changes.slice(3)){const item=document.createElement("li");item.textContent=describe(change);items.append(item);}
        more.append(heading,items);row.append(more);
      }
    }else{
      const name=document.createElement("strong");name.textContent=entry.name;
      const reason=document.createElement("small");reason.textContent=entry.error;
      row.append(name,reason);
    }
    list.append(row);
  });
  host.append(list);
  if(entries.some(entry=>entry.preview)){
    const note=document.createElement("p");note.id="file-response-selection-note";note.setAttribute("role","status");
    const review=document.createElement("button");review.id="review-file-responses";review.type="button";review.className="outline";
    host.append(note,review);
  }
  offerFreshGuestForms(entries.map(entry=>entry.response));
  host.hidden=false;syncFileResponseSelection();
}
$("file-response-recovery").addEventListener("change",event=>{
  const input=event.target.closest("[data-file-response-select]");
  if(!input||busy||dirty||!heldGuestFiles)return;
  const entry=heldGuestFiles[Number(input.dataset.fileResponseSelect)];
  if(entry?.preview)entry.selected=input.checked;
  syncFileResponseSelection();
});
$("file-response-recovery").addEventListener("click",event=>{
  if(!event.target.closest("#review-file-responses")||busy||dirty||!heldGuestFiles)return;
  const entries=heldGuestFiles.filter(entry=>entry.preview&&entry.selected);
  if(!entries.length||new Set(entries.map(entry=>entry.response.guestId)).size!==entries.length)return;
  void action(async()=>{
    lockEditCheck();
    const responses=entries.map(entry=>entry.response);
    await showGuestResponse(responses.length===1?responses[0]:responses,responses.length===1?"file":"files");
  },"Selected replies ready for review. The saved receipt is unchanged.");
});
$("guest-response-file").addEventListener("change",async event=>{
  const files=Array.from(event.target.files||[]);if(!files.length)return;
  if(busy)return;
  clearGuestResponse();
  let recovery=false;
  await action(async()=>{
    if(dirty)throw Error("Save or discard your current edits before reviewing guest responses.");
    lockEditCheck();
    if(files.length>12)throw Error("Choose up to 12 guest response files together.");
    const generation=editGeneration,revision=saved.bill.revision,entries=[];
    for(const file of files){
      const entry={name:file.name,selected:true};entries.push(entry);
      if(file.size>128*1024){entry.error="Larger than 128 KiB.";continue;}
      try{entry.response=JSON.parse(await file.text());}catch{entry.error="Not a valid guest response JSON file.";}
    }
    const unchanged=()=>{
      if(generation!==editGeneration||revision!==saved.bill.revision||dirty)throw Error("The receipt changed. Choose these files again after saving your edits.");
    };
    unchanged();
    if(entries.every(entry=>!entry.error)){
      const responses=entries.map(entry=>entry.response);
      try{await showGuestResponse(files.length===1?responses[0]:responses,files.length===1?"file":"files");return;}
      catch(error){unchanged();if(error.requestTimedOut)throw error;}
    }
    for(const entry of entries){
      if(entry.error)continue;
      try{entry.preview=await fileGuestReviewApi("guest-review/preview",{response:entry.response});}
      catch(error){if(error.requestTimedOut)throw error;entry.error=error.message;}
      unchanged();
    }
    showHeldGuestFiles(entries);recovery=true;
    if(!entries.some(entry=>entry.preview))throw Error(entries[0].error||"No current replies to review.");
  },()=>recovery?"Some files need attention. Choose current replies below; the saved receipt is unchanged.":files.length===1?"Guest response ready for your review. The saved receipt is unchanged.":files.length+" guest responses ready to review together. The saved receipt is unchanged.");
});
function currentGuestReviewIdentities(){
  return guestResponseIdentities||(guestResponseIdentity?[guestResponseIdentity]:[]);
}
async function reviewedApi(path,body,timeoutMessage="The request timed out. Check the saved receipt before continuing."){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try{return await api(path,body,controller.signal);}
  catch(error){if(controller.signal.aborted)throw Object.assign(Error(timeoutMessage),{requestTimedOut:true});throw error;}
  finally{clearTimeout(timer);}
}
async function reviewedSaveRecorded(current){
  const identities=currentGuestReviewIdentities();
  if(!identities.length)return false;
  const {links}=await reviewedApi("guest-links");
  return identities.every(identity=>links.some(link=>link.id===identity.id&&link.responseId===identity.responseId&&link.savedAt&&link.savedRevision===current.bill.revision));
}
async function checkReviewedGuestSave(){
  await action(async()=>{
    const previousRevision=saved.bill.revision;
    let current,reviewSaved=false;
    try{current=await reviewedApi("state");reviewSaved=await reviewedSaveRecorded(current);}
    catch(error){guestResponseView.showError("Couldn’t confirm the save. Check the saved receipt before continuing.","check");throw error;}
    if(reviewSaved||current.bill.revision!==previousRevision||Object.keys(current.bill.payments).length){
      saved=current;clearDraftCache();renderEverything();
      document.dispatchEvent(new CustomEvent("tabloom:review-saved",{detail:{revision:saved.bill.revision}}));
      return;
    }
    guestResponseView.showError("The saved receipt is unchanged. Review the latest replies before saving.",currentGuestReviewIdentities().length?"refresh":"close");
  },"Saved receipt checked.");
}
async function saveReviewedGuestResponse(){
  await action(async()=>{
    if(dirty||!guestResponsePreview||!guestResponseRaw)throw Error("Review replies for the saved receipt first.");
    lockEditCheck();
    if(guestResponsePreview.unresolved.length)throw Error("Assign the remaining items first.");
    const generation=editGeneration,revision=saved.bill.revision;
    const bill=guestResponsePreview.bill,identity=guestResponseIdentity,identities=guestResponseIdentities;
    try{
      const result=await reviewedApi("bill",{bill,revision,...(identity?{guestResponse:identity}:{}),...(identities?{guestResponses:identities}:{}),...(!identity&&!identities?{guestFileResponses:Array.isArray(guestResponseRaw)?guestResponseRaw:[guestResponseRaw]}:{})});
      adoptSavedUpdate(result,generation);
      document.dispatchEvent(new CustomEvent("tabloom:review-saved",{detail:{revision:saved.bill.revision}}));
    }catch(error){
      let current,reviewSaved=false;
      try{current=await reviewedApi("state");reviewSaved=await reviewedSaveRecorded(current);}
      catch{guestResponseView.showError("Couldn’t confirm the save. Check the saved receipt before continuing.","check");throw error;}
      if(reviewSaved){
        adoptSavedUpdate(current,generation);
        document.dispatchEvent(new CustomEvent("tabloom:review-saved",{detail:{revision:saved.bill.revision}}));
        return;
      }
      if(current.bill.revision!==revision||Object.keys(current.bill.payments).length){
        saved=current;clearDraftCache();renderEverything();
        document.dispatchEvent(new CustomEvent("tabloom:review-saved",{detail:{revision:saved.bill.revision}}));
        throw Error("The receipt changed. Its current saved shares are now shown.");
      }
      guestResponseView.showError(error.message,currentGuestReviewIdentities().length?"refresh":"close");
      throw error;
    }
  },"Reviewed split saved.");
}
async function refreshReviewedGuestResponses(){
  await action(async()=>{
    const ids=currentGuestReviewIdentities().map(identity=>identity.id);
    if(!ids.length)throw Error("Choose the guest response again.");
    lockEditCheck();const generation=editGeneration;
    const timeoutMessage="Loading the latest replies took too long. Try again.";
    try{
      const {responses,identities}=await reviewedApi("guest-links/responses",{ids},timeoutMessage);
      const preview=await reviewedApi("guest-review/preview-many",{responses},timeoutMessage);
      if(generation!==editGeneration||dirty)throw Error("The receipt changed. Save your edits before reviewing replies.");
      presentGuestResponse(preview,responses,"live",identities);
    }catch(error){guestResponseView.showError(error.message,error.message===timeoutMessage?"refresh":"close");throw error;}
  },"Latest replies ready.");
}
async function resolveReviewedGuestResponse(){
  await action(async()=>{
    if(dirty||!guestResponsePreview||!guestResponseRaw)throw Error("Review replies for the saved receipt first.");
    lockEditCheck();
    const generation=editGeneration,identity=guestResponseIdentity,identities=guestResponseIdentities,combined=Array.isArray(guestResponseRaw);
    const preview=await api(combined?"guest-review/preview-many":"guest-review/preview",combined?{responses:guestResponseRaw}:{response:guestResponseRaw});
    if(generation!==editGeneration)throw Error("The receipt changed during review.");
    for(const item of draft.items){const next=preview.bill.items.find(i=>i.id===item.id);if(item.portions&&next&&!next.portions)portionResets.add(item.id);}
    draft=preview.bill;renderItems();setDirty();adoptedGuestResponse=identity;adoptedGuestResponses=identities;
    document.dispatchEvent(new CustomEvent("tabloom:review-needs-assignment"));
    const unresolvedId=draft.items.find(item=>!item.sharedBy.length)?.id;
    const item=[...$("items").querySelectorAll(".item")].find(row=>row.dataset.item===unresolvedId);
    const target=item?.querySelector("[data-share]");
    if(target){target.scrollIntoView({block:"center"});target.focus({preventScroll:true});}
  },"Choose who shared the remaining items.");
}

async function liveGuestReviewApi(path,body){
  $("guest-refresh-error").hidden=true;
  try{return await reviewedApi(path,body,"Loading guest choices took too long. Try reviewing again.");}
  catch(error){
    const status=$("guest-refresh-error");status.textContent=error.message;status.hidden=false;
    status.scrollIntoView({block:"center"});throw error;
  }
}
async function fileGuestReviewApi(path,body){
  try{return await reviewedApi(path,body,"Review took too long. Choose the response files again. The saved receipt is unchanged.");}
  catch(error){
    if(error.requestTimedOut){const notice=$("file-response-recovery");notice.textContent=error.message;notice.hidden=false;notice.setAttribute("role","alert");notice.scrollIntoView({block:"center"});}
    throw error;
  }
}
async function showGuestResponse(response,source="file",identities=null){
  const generation=editGeneration,combined=source!=="file"&&Array.isArray(response);
  const request=source==="live"?liveGuestReviewApi:fileGuestReviewApi;
  const preview=await request(combined?"guest-review/preview-many":"guest-review/preview",combined?{responses:response}:{response});
  if(generation!==editGeneration)throw Error("The receipt changed while reviewing. Save your edits, then choose the responses again.");
  presentGuestResponse(preview,response,source,identities);
}
function presentGuestResponse(preview,response,source,identities){
  guestResponsePreview=preview;guestResponseRaw=response;guestResponseIdentity=null;guestResponseIdentities=identities;
  guestResponseView.show({preview,before:saved,source});
}

$("review-latest-guests").addEventListener("click",()=>{
  if(busy||!guestRecoveryIds)return;
  const ids=[...guestRecoveryIds];
  if(!window.confirm("Discard this unsaved draft and review the latest replies from the same selected guests? The saved receipt will not change."))return;
  action(async()=>{
    lockEditCheck();const generation=editGeneration;
    const {responses,identities}=await api("guest-links/responses",{ids});
    const preview=await api("guest-review/preview-many",{responses});
    if(generation!==editGeneration)throw Error("Your draft changed while loading replies. It has been kept; review again when ready.");
    await refreshGuestLinks();
    if(generation!==editGeneration)throw Error("Your draft changed while loading replies. It has been kept; review again when ready.");
    for(const link of pendingGuestLinks){if(ids.includes(link.id))omittedGuestResponses.delete(link.id);else omittedGuestResponses.add(link.id);}
    clearDraftCache();renderEverything();
    $("guest-response-desk").open=false;
    presentGuestResponse(preview,responses,"live",identities);
  },"Latest replies ready for review. The saved receipt has not been changed by this review.");
});
function selectedGuestLinks(){return pendingGuestLinks.filter(link=>!omittedGuestResponses.has(link.id));}
function renderGuestBatchControls(){
  const incoming=$("incoming-guest-replies"),count=pendingGuestLinks.length;
  incoming.hidden=!count;incoming.disabled=busy||dirty;
  incoming.textContent=count+" "+(count===1?"guest reply":"guest replies")+" ready · View ↓";

  document.querySelectorAll("[data-pay]").forEach(button=>{
    if(saved?.bill.payments[button.dataset.pay])return;
    button.disabled=dirty||busy||!saved?.paypalReady||pendingGuestLinks.some(link=>link.responseChanged)||!!paymentFeedback.get(button.dataset.pay)?.refreshRequired;
    button.textContent=pendingGuestLinks.some(link=>link.responseChanged)?"Review replies first":"Request payment";
  });
  const selected=selectedGuestLinks();
  $("guest-batch-controls").hidden=pendingGuestLinks.length<2;
  $("review-guest-responses").disabled=busy||dirty||!selected.length;
  $("review-guest-responses").textContent=selected.length?"REVIEW "+selected.length+" SELECTED "+(selected.length===1?"RESPONSE":"RESPONSES"):"SELECT RESPONSES TO REVIEW";
  $("guest-batch-count").textContent=selected.length?selected.map(link=>link.guest).join(", "):"No guest responses selected.";
  document.querySelectorAll("[data-select-guest-response]").forEach(input=>{input.disabled=busy||dirty;});
}

function guestInvitationQr(link){
  if(new URL(link.url).hostname.startsWith("127."))return '<p class="guest-link-local">This link only opens on this computer. To let another phone join, stop guest invitations above and enable them using a private-network address.</p>';
  return '<details class="guest-link-qr"><summary>Show QR for '+esc(link.guest)+'</summary><p>Scan on '+esc(link.guest)+'’s phone using the same network.</p><img src="'+esc(link.qr)+'" alt="QR invitation for '+esc(link.guest)+'" width="270" height="270"><p>Private invitation for '+esc(link.guest)+'.</p></details>';
}

let guestLinkRefreshSequence=0,guestLinksSignature="",backgroundGuestLinksBusy=false;
const guestReplyUiBusy=()=>busy||dirty||$("guest-review-dialog")?.open;
async function refreshGuestLinks({background=false}={}){
  if(!saved||background&&guestReplyUiBusy())return;
  const sequence=++guestLinkRefreshSequence,revision=saved.bill.revision;
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);
  try{
    const {links,groups=[]}=await api("guest-links",undefined,controller.signal);
    if(sequence!==guestLinkRefreshSequence||revision!==saved.bill.revision||background&&guestReplyUiBusy())return;
    const previousError=$("guest-refresh-error");
    if(!previousError.hidden&&$("message").textContent===previousError.textContent)$("message").hidden=true;
    previousError.hidden=true;
    const signature=JSON.stringify({links,groups,revision,locked:Object.keys(saved.bill.payments).length});
    if(background&&signature===guestLinksSignature)return;
    const expanded=[...$("guest-links-list").querySelectorAll("details[open]")].map(detail=>({id:detail.closest("[data-invitation-id]").dataset.invitationId,kind:detail.className}));
    const active=document.activeElement,focusedRow=active?.closest("[data-invitation-id]");
    const marker=["data-select-guest-response","data-open-guest-response","data-stop-guest-link","data-copy-guest-link","data-live-guest-file"].find(name=>active?.hasAttribute(name));
    const focusSelector=marker?"["+marker+"]":active?.matches(".guest-link-address input")?".guest-link-address input":active?.matches(".guest-link-address summary")?".guest-link-address summary":active?.matches(".guest-link-qr summary")?".guest-link-qr summary":null;
    const focused=focusedRow&&focusSelector?{id:focusedRow.dataset.invitationId,selector:focusSelector,start:active.selectionStart,end:active.selectionEnd}:null;
    guestLinksSignature=signature;tableInvitations=groups;renderTableInvitation();
    $("guest-links-desk").hidden=links.length===0;
    pendingGuestLinks=links.filter(link=>!Object.keys(saved.bill.payments).length&&link.submittedAt&&!link.savedAt&&!link.stale);
    const replyNotice=$("guest-links-desk").querySelector("p");replyNotice.setAttribute("role","status");replyNotice.hidden=!pendingGuestLinks.length;replyNotice.textContent=pendingGuestLinks.length+" "+(pendingGuestLinks.length===1?"reply":"replies")+" ready for review.";
    const pendingIds=new Set(pendingGuestLinks.map(link=>link.id));
    $("guest-links-list").innerHTML=links.length?links.map(link=>{
      const selectable=pendingIds.has(link.id)&&pendingGuestLinks.length>1;
      const title=esc(link.guest)+' · revision '+(link.savedAt?link.savedRevision:link.revision);
      const heading=selectable?'<label class="guest-response-select"><input type="checkbox" data-select-guest-response="'+link.id+'" aria-label="Include '+esc(link.guest)+' in combined review" '+(omittedGuestResponses.has(link.id)?"":"checked")+'><strong>'+title+'</strong></label>':'<strong>'+title+'</strong>';
      const status=(link.stopped||link.expired)&&link.submittedAt&&!link.savedAt?(link.stale?'Reply retained · receipt changed. Dismiss this reply and invite the guest again.':'Reply retained · ready to review.'):link.expired?'Expired — create a new invitation.':link.savedAt?'Choices saved in revision '+link.savedRevision+(link.stale?' · receipt changed since.':'.'):link.stale?'Receipt changed — create a fresh link.':Object.keys(saved.bill.payments).length?(link.reviewOnly?'Item choices are closed. Send this diner a separate payment invitation.':'Saved receipt locked. This guest can open their own payment status.'):link.submittedAt?'Response received '+esc(new Date(link.submittedAt).toLocaleTimeString())+' · not yet saved':'Waiting for this guest’s choices.';
      const address=!link.stopped&&!link.expired&&(!link.stale||link.savedAt)?'<details class="guest-link-address"><summary>Link for '+esc(link.guest)+'</summary><label>LINK FOR THIS GUEST<input readonly value="'+esc(link.url)+'" aria-label="Guest link for '+esc(link.guest)+'"></label><button class="text-button" data-copy-guest-link="'+link.id+'" type="button">COPY LINK</button></details>'+guestInvitationQr(link):'';
      const review=pendingIds.has(link.id)&&!selectable?'<button class="outline" data-open-guest-response="'+link.id+'" type="button">REVIEW RESPONSE</button>':'';
      const offline=!link.stopped&&!link.expired&&!link.stale&&!Object.keys(saved.bill.payments).length&&saved.bill.guests.some(g=>g.id===link.guestId)?'<button class="outline" data-live-guest-file="'+esc(link.guestId)+'" type="button" '+(dirty||busy?'disabled':'')+'>Download offline form</button>':'';
      return '<div class="guest-link-row" data-invitation-id="'+esc(link.id)+'">'+heading+'<p>'+status+'</p>'+review+address+offline+'<button class="text-button" data-stop-guest-link="'+link.id+'" '+(link.stopped&&link.submittedAt&&!link.savedAt?'data-discard-response-id="'+esc(link.responseId)+'" ':'')+'type="button">'+(link.stopped?(link.submittedAt&&!link.savedAt?'DISMISS REPLY':'REMOVE LINK'):'STOP LINK')+'</button></div>';
    }).join(""):'<p>No guest links yet. Create one beside a guest below.</p>';
    for(const opened of expanded){const row=[...$("guest-links-list").children].find(row=>row.dataset.invitationId===opened.id);const detail=[...(row?.querySelectorAll("details")||[])].find(detail=>detail.className===opened.kind);if(detail)detail.open=true;}
    if(focused){const row=[...$("guest-links-list").children].find(row=>row.dataset.invitationId===focused.id),control=row?.querySelector(focused.selector);if(control){control.focus({preventScroll:true});if(typeof focused.start==="number"&&typeof focused.end==="number")control.setSelectionRange(focused.start,focused.end);}}
    renderGuestBatchControls();
  }catch(error){
    if(sequence===guestLinkRefreshSequence&&revision===saved.bill.revision){
      guestLinksSignature="";
      $("guest-links-desk").hidden=false;
      const notice=$("guest-refresh-error");notice.hidden=false;
      notice.textContent="Could not refresh replies. "+(pendingGuestLinks.length?"Last received replies are still shown. ":"")+"Refresh responses to try again.";
      renderGuestBatchControls();
    }
    return false;
  }
  finally{clearTimeout(timeout);}
}
async function observeIncomingGuestReplies(){
  if(backgroundGuestLinksBusy||document.hidden||location.hash!=="#guest-checkout"||!saved||guestReplyUiBusy())return;
  backgroundGuestLinksBusy=true;
  try{await refreshGuestLinks({background:true});}finally{backgroundGuestLinksBusy=false;}
}
setInterval(()=>void observeIncomingGuestReplies(),5000);
document.addEventListener("visibilitychange",()=>{if(!document.hidden)void observeIncomingGuestReplies();});
window.addEventListener("hashchange",()=>void observeIncomingGuestReplies());

$("incoming-guest-replies").addEventListener("click",()=>{
  if(busy||dirty||!pendingGuestLinks.length)return;
  $("guest-links-desk").scrollIntoView({block:"start",behavior:"instant"});
  const target=$("guest-links-list").querySelector("[data-open-guest-response]")||
    (!$("review-guest-responses").disabled?$("review-guest-responses"):$("guest-links-list").querySelector("[data-select-guest-response]"))||
    $("refresh-guest-links");
  target.focus({preventScroll:true});
});
$("refresh-guest-links").addEventListener("click",()=>action(async()=>{if(await refreshGuestLinks()===false)throw Error($("guest-refresh-error").textContent);},"Guest responses refreshed. No receipt changes were made."));
$("guest-links-list").addEventListener("change",event=>{
  const id=event.target.dataset.selectGuestResponse;if(!id||busy||dirty)return;
  if(event.target.checked)omittedGuestResponses.delete(id);else omittedGuestResponses.add(id);
  clearGuestResponse();renderGuestBatchControls();
});
$("review-guest-responses").addEventListener("click",()=>action(async()=>{
  if(dirty)throw Error("Save or discard your edits before reviewing guest responses.");
  lockEditCheck();const generation=editGeneration,ids=selectedGuestLinks().map(link=>link.id);
  if(!ids.length)throw Error("Select the guest responses to review.");
  clearGuestResponse();
  const {responses,identities}=await liveGuestReviewApi("guest-links/responses",{ids});
  if(dirty||generation!==editGeneration)throw Error("The receipt changed. Save your edits, then review the responses again.");
  $("guest-response-desk").open=false;
  await showGuestResponse(responses,"live",identities);
},"Combined choices ready for your review. No saved receipt changes."));
$("guest-links-list").addEventListener("click",event=>{
  const button=event.target.closest("button");if(!button)return;
  if(button.dataset.liveGuestFile){void downloadGuestReview(button.dataset.liveGuestFile);return;}
  if(button.dataset.copyGuestLink){const input=button.closest(".guest-link-row").querySelector("input[readonly]");input.select();if(!navigator.clipboard?.writeText){stateMsg("The link is selected. Copy it from the field to share.");return;}navigator.clipboard.writeText(input.value).then(()=>stateMsg("Guest link copied. Share it only with the named guest on your private network.")).catch(()=>stateMsg("The link is selected. Copy it from the field to share.",true));return;}
  if(button.dataset.stopGuestLink)action(async()=>{await api("guest-links/revoke",{id:button.dataset.stopGuestLink,...(button.dataset.discardResponseId?{discardResponseId:button.dataset.discardResponseId}:{})});await refreshGuestLinks();},button.dataset.discardResponseId?"Guest reply dismissed. Saved receipt unchanged.":"Guest link stopped.");
  if(button.dataset.openGuestResponse)action(async()=>{
    if(dirty)throw Error("Save or discard your edits before reviewing a guest response.");
    lockEditCheck();clearGuestResponse();const generation=editGeneration;
    const {response,identity}=await liveGuestReviewApi("guest-links/response",{id:button.dataset.openGuestResponse});
    if(dirty||generation!==editGeneration)throw Error("The receipt changed. Save your edits, then review the response again.");
    $("guest-response-desk").open=false;await showGuestResponse(response,"live");guestResponseIdentity=identity;
  },"Guest response ready for your review. No saved receipt changes.");
});

$("check-sandbox").addEventListener("click",async()=>{
  const button=$("check-sandbox"),result=$("sandbox-connection-result");
  if(button.disabled)return;
  button.disabled=true;button.textContent="CHECKING…";
  result.textContent="Checking the configured Sandbox app…";
  try{
    sandboxConnection=await api("paypal/check",{});
    result.textContent=sandboxConnection.message+" Checked "+new Date(sandboxConnection.observedAt).toLocaleTimeString()+".";
    renderPayments();
  }catch(error){result.textContent=error.message+" The connection has not been confirmed.";}
  finally{button.disabled=false;button.textContent="CHECK AGAIN";}
});

initGuestNetwork({element:$("guest-network"),api,onChange:async (current,networkAction)=>{
  if(!saved)return;
  saved.guestLinksReady=current.enabled;
  if(!current.enabled)$("guest-links-list").replaceChildren();
  renderPayments();await refreshGuestLinks();
  if(current.enabled&&networkAction==="start"&&pendingInvite){
    const intent=pendingInvite;pendingInvite=null;renderPendingInvite();
    if(!dirty&&!busy&&saved.bill.revision===intent.revision){
      if(intent.group)await inviteTable();
      else if(saved.bill.guests.some(g=>g.id===intent.guestId))await inviteGuest(intent.guestId);
    }
  }
}});

// Focused guest review owns its dialog; organizer owns the destination workspace.
document.addEventListener("tabloom:review-saved",()=>{location.hash="guest-checkout";showWorkspace();$("payments").scrollIntoView({block:"start"});});
document.addEventListener("tabloom:review-needs-assignment",()=>{location.hash="receipt";showWorkspace();$("items").scrollIntoView({block:"start"});});

const receiptIntake = initReceiptIntake({
  button:$("paste-receipt"),
  canEdit(){if(!saved||busy)throw Error("Wait for the receipt to finish loading.");lockEditCheck();},
  getItemCount:()=>draft?.items.length||0,
  getDraftContext:()=>({table:activeTableId,base:JSON.stringify(saved.bill)}),
  onApply:importReceipt,
  onError:error=>stateMsg(error.message,true)
});
