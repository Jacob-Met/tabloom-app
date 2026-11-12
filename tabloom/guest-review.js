import {guestIdentityStyles,guestFileName} from './guest-identity.js';
import {allocateExactCents,estimateOfflineChoices} from './share-math.js';
const esc=value=>String(value).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const money=cents=>"$"+(cents/100).toFixed(2);
/** Bounded local unsent choices; the server remains the source of every price and sent choice. */
export function createGuestDraftStore(storage,packet,pathname,now=()=>Date.now()){
  const prefix="tabloom-guest-draft-v1:",key=prefix+(packet.live?"":"offline:")+pathname,expiry=Date.parse(packet.expiresAt),offlineLifetime=24*60*60*1000;
  const validItems=items=>Array.isArray(items)&&items.length===packet.items.length&&items.length<=60&&
    new Set(items.map(item=>item?.id)).size===items.length&&items.every(item=>item&&typeof item.selected==="boolean"&&packet.items.some(original=>original.id===item.id));
  const clear=()=>{try{storage?.removeItem(key);}catch{}};
  const recoveryAge=value=>Number.isFinite(value?.storedAt)&&value.storedAt>=0&&value.storedAt<=now()&&now()-value.storedAt<offlineLifetime;
  const validContext=(value,changedReply=false,allowExpired=false)=>value?.version===1&&value.tableId===packet.tableId&&value.guestId===packet.guestId&&
    value.revision===packet.revision&&value.fingerprint===packet.fingerprint&&(changedReply||value.submittedAt===(packet.submittedAt||null))&&
    (packet.live?value.expiresAt===expiry:Number.isFinite(value.storedAt)&&value.storedAt<=now()&&value.expiresAt===value.storedAt+offlineLifetime)&&(allowExpired||value.expiresAt>now())&&validItems(value.items);
  const baseline=()=>packet.items.map(item=>({id:item.id,selected:packet.responseItems?.find(choice=>choice.id===item.id)?.selected??item.selected}));
  const priorReply=value=>packet.live&&typeof packet.submittedAt==="string"&&Number.isFinite(Date.parse(packet.submittedAt))&&
    validItems(packet.responseItems)&&validContext(value,true)&&value.submittedAt!==packet.submittedAt&&
    (value.submittedAt===null||typeof value.submittedAt==="string"&&Number.isFinite(Date.parse(value.submittedAt)))&&
    value.items.some(item=>baseline().find(original=>original.id===item.id)?.selected!==item.selected);
  return {
    clear,
    priorReply(){
      try{
        const raw=storage?.getItem(key);if(!raw||raw.length>16000)return null;
        const value=JSON.parse(raw);return priorReply(value)?{revision:packet.revision,items:value.items,skipped:0,receivedChanged:true}:null;
      }catch{return null;}
    },
    earlier(){
      if(!packet.live || packet.submittedAt || !Number.isFinite(expiry) || expiry<=now())return null;
      try{
        if(!storage)return null;
        const candidates=[];
        for(let index=0;index<storage.length;index++){
          const entry=storage.key(index);
          if(!entry?.startsWith(prefix)||entry.startsWith(prefix+"offline:")||entry===key)continue;
          const raw=storage.getItem(entry);if(!raw||raw.length>16000)continue;
          let value;try{value=JSON.parse(raw);}catch{continue;}
          if(value?.version!==1||value.tableId!==packet.tableId||value.guestId!==packet.guestId||
            !Number.isSafeInteger(value.revision)||value.revision<0||value.revision>packet.revision||(value.revision===packet.revision&&(value.fingerprint!==packet.fingerprint||!recoveryAge(value)))||
            typeof value.fingerprint!=="string"||!value.fingerprint||
            !Number.isFinite(value.storedAt)||value.storedAt>now()||value.storedAt<0||
            !Number.isFinite(value.expiresAt)||(value.expiresAt<=now()&&!(value.revision===packet.revision&&recoveryAge(value)))||
            !Array.isArray(value.items)||!value.items.length||value.items.length>60||
            new Set(value.items.map(item=>item?.id)).size!==value.items.length||
            !value.items.every(item=>item&&typeof item.id==="string"&&typeof item.selected==="boolean")||
            !Array.isArray(value.itemNames)||value.itemNames.length!==value.items.length||
            new Set(value.itemNames.map(item=>item?.id)).size!==value.itemNames.length||
            !value.itemNames.every(item=>item&&typeof item.name==="string"&&item.name.length<=200&&value.items.some(choice=>choice.id===item.id)))continue;
          const items=value.items.filter(choice=>packet.items.some(item=>item.id===choice.id&&item.name===value.itemNames.find(name=>name.id===choice.id)?.name));
          if(!items.some(choice=>choice.selected!==packet.items.find(item=>item.id===choice.id).selected))continue;
          if(value.revision===packet.revision&&(items.length!==packet.items.length||items.length!==value.items.length))continue;
          candidates.push({revision:value.revision,storedAt:value.storedAt,items,skipped:value.items.length-items.length,replacement:value.revision===packet.revision});
        }
        candidates.sort((a,b)=>b.revision-a.revision||b.storedAt-a.storedAt);
        return candidates[0]||null;
      }catch{return null;}
    },
    load(){
      if(packet.live&&!Number.isFinite(expiry))return null;
      try{
        const raw=storage?.getItem(key);if(!raw)return null;
        if(raw.length>16000){clear();return null;}
        const value=JSON.parse(raw);if(!validContext(value)){if(!priorReply(value)&&!(packet.live&&value?.expiresAt<=now()&&recoveryAge(value)&&validContext(value,false,true)))clear();return null;}
        return value.items;
      }catch{clear();return null;}
    },
    save(items){
      if((packet.live&&(!Number.isFinite(expiry)||expiry<=now()))||!validItems(items))return false;
      if(items.every(item=>baseline().find(original=>original.id===item.id)?.selected===item.selected)){clear();return true;}
      try{
        if(!storage)return false;
        const retained=[];
        for(let i=0;i<storage.length;i++){const entry=storage.key(i);if(entry?.startsWith(prefix))retained.push(entry);}
        const live=[];
        for(const entry of retained){
          try{const raw=storage.getItem(entry);const value=raw&&raw.length<=16000?JSON.parse(raw):null;
            if(!value||!Number.isFinite(value.expiresAt)||(value.expiresAt<=now()&&!(entry.startsWith(prefix)&&!entry.startsWith(prefix+"offline:")&&value.version===1&&recoveryAge(value))))storage.removeItem(entry);
            else if(entry!==key)live.push({key:entry,storedAt:Number(value.storedAt)||0});
          }catch{storage.removeItem(entry);}
        }
        live.sort((a,b)=>a.storedAt-b.storedAt);while(live.length>=20)storage.removeItem(live.shift().key);
        const storedAt=now();
        const record={version:1,tableId:packet.tableId,guestId:packet.guestId,revision:packet.revision,fingerprint:packet.fingerprint,
          submittedAt:packet.submittedAt||null,expiresAt:packet.live?expiry:storedAt+offlineLifetime,storedAt,items:items.map(({id,selected})=>({id,selected}))};
        if(packet.items.every(item=>typeof item.name==="string"&&item.name.length<=200))record.itemNames=packet.items.map(({id,name})=>({id,name}));
        let serialized=JSON.stringify(record);
        if(serialized.length>16000){delete record.itemNames;serialized=JSON.stringify(record);}
        storage.setItem(key,serialized);
        return true;
      }catch{return false;}
    }
  };
}
export function readGuestChoices(text,packet,now=()=>Date.now()){
  if(typeof text!=="string"||text.length>16000)throw Error("Choose a Tabloom response file smaller than 16 KB.");
  let value;try{value=JSON.parse(text);}catch{throw Error("Choose the response file downloaded from Tabloom.");}
  if(!packet?.live||!Number.isFinite(Date.parse(packet.expiresAt))||Date.parse(packet.expiresAt)<=now()||packet.submittedAt||packet.receiptChanged||value?.kind!=="tabloom-guest-response"||value.version!==1||
    value.tableId!==packet.tableId||value.guestId!==packet.guestId||value.revision!==packet.revision||
    typeof value.fingerprint!=="string"||!value.fingerprint||value.fingerprint!==packet.fingerprint||
    !Array.isArray(value.items)||value.items.length!==packet.items.length||value.items.length>60||
    new Set(value.items.map(item=>item?.id)).size!==value.items.length||
    value.items.some(item=>!item||typeof item.id!=="string"||typeof item.selected!=="boolean"||!packet.items.some(current=>current.id===item.id)))
    throw Error("This response file does not match this guest and saved receipt.");
  return value.items.map(({id,selected})=>({id,selected}));
}

function guestPage() {
  const packet=JSON.parse(document.getElementById("review-data").textContent);
  const inputs=[...document.querySelectorAll("[data-item]")];
  const dishSearch=document.getElementById("guest-item-search"),clearDishSearch=document.getElementById("clear-guest-item-search"),dishSearchStatus=document.getElementById("guest-item-search-status");
  if(dishSearch){
    const searchable=value=>String(value??"").normalize("NFD").replace(/\p{Diacritic}/gu,"").toLocaleLowerCase();
    const filterDishes=()=>{
      const query=dishSearch.value.trim(),terms=searchable(query).split(/\s+/).filter(Boolean);let count=0;
      for(const input of inputs){const item=packet.items.find(item=>item.id===input.dataset.item),matches=terms.every(term=>searchable(item.name).includes(term));input.closest(".item").hidden=!matches;if(matches)count++;}
      clearDishSearch.hidden=!query;dishSearchStatus.hidden=!query;dishSearchStatus.textContent=count?count+" of "+inputs.length+" dishes":"No dishes match. Clear the search to see all dishes.";
    };
    dishSearch.addEventListener("input",filterDishes);
    clearDishSearch.addEventListener("click",()=>{dishSearch.value="";filterDishes();dishSearch.focus();});
  }
  const status=document.getElementById("status");
  const button=document.getElementById("download-response");
  const fallback=document.getElementById("download-offline-response");
  const checkReceipt=document.createElement("button");checkReceipt.id="check-guest-receipt";checkReceipt.type="button";checkReceipt.hidden=true;checkReceipt.textContent="Check receipt";
  checkReceipt.style.cssText="width:auto;min-height:44px;background:transparent;color:#143dc6;text-decoration:underline;padding:8px 0";
  button.before(checkReceipt);

  const preview=document.getElementById("share-preview");
  const amount=document.getElementById("proposed-total");
  const detail=document.getElementById("proposed-detail");
  const retry=document.getElementById("preview-retry");
  const format=cents=>"$"+(cents/100).toFixed(2);
  const choices=()=>inputs.map(input=>({id:input.dataset.item,selected:input.checked}));
  let storage;try{storage=window.localStorage;}catch{}
  const draftStore=createGuestDraftStore(storage,packet,location.pathname);
  const recovery=document.getElementById("guest-draft-recovery");
  const storageNotice=document.createElement("p");storageNotice.id="guest-storage-warning";storageNotice.hidden=true;storageNotice.setAttribute("role","status");storageNotice.style.cssText="font-size:12px;line-height:1.4;margin:8px 0;color:#8b2d1b";storageNotice.textContent="This browser cannot keep your choices. Download a copy before leaving.";status.after(storageNotice);
  let unbackedChoices=false,sendGeneration=0;
  const protectDeparture=event=>{if(unbackedChoices&&!receivedChoices()){event.preventDefault();event.returnValue="";}};
  function showBackupState(){
    const needsCopy=unbackedChoices&&!receivedChoices();storageNotice.hidden=!needsCopy;
    window.removeEventListener("beforeunload",protectDeparture);
    if(needsCopy){window.addEventListener("beforeunload",protectDeparture);if(fallback)fallback.hidden=false;}
  }
  function keepChoices(){unbackedChoices=!draftStore.save(choices());showBackupState();return !unbackedChoices;}
  const responsePacket=()=>({kind:"tabloom-guest-response",version:1,tableId:packet.tableId,revision:packet.revision,fingerprint:packet.fingerprint,guestId:packet.guestId,items:choices()});
  function downloadChoices(){
    const selected=choices();
    const summary=receiptChanged?[packet.title,packet.guestName+"’s choices from receipt "+packet.revision,"","Use this list with a fresh form from your organizer.","","Selected",...packet.items.filter(item=>selected.find(choice=>choice.id===item.id)?.selected).map(item=>"- "+item.name),"","Not selected",...packet.items.filter(item=>!selected.find(choice=>choice.id===item.id)?.selected).map(item=>"- "+item.name),""].join("\n"):null;
    const url=URL.createObjectURL(new Blob([summary??JSON.stringify(responsePacket(),null,2)+"\n"],{type:receiptChanged?"text/plain;charset=utf-8":"application/json"}));
    const a=document.createElement("a");a.href=url;a.download=guestFileName(packet,receiptChanged?"choices":"response",receiptChanged?"txt":"json");a.click();
    setTimeout(()=>URL.revokeObjectURL(url),5000);
    if(!packet.live){status.textContent="File ready. Send it to your organizer for review.";button.textContent="Download again ↓";}
    const handoff=document.getElementById("handoff");handoff.textContent=receiptChanged?"Choice summary downloaded. Ask your organizer for a fresh form and use the summary to reselect your items.":"Choices downloaded. Send the file to your organizer for review; downloading does not send or save them.";handoff.hidden=false;
  }
  if(fallback)fallback.addEventListener("click",downloadChoices);
  if(preview&&typeof ResizeObserver!=="undefined"){
    new ResizeObserver(entries=>document.documentElement.style.setProperty("--review-footer-height",entries[0].target.getBoundingClientRect().height+"px")).observe(document.querySelector(".bottom"));
  }
  let sequence=0,request=null,readyChoices=null,sending=false,reviewOutcome=null,invitationEnded=false,reviewUnavailable=false,receiptChanged=false;
  function markReceiptChanged(keepSavedLink=false){
    receiptChanged=true;button.hidden=true;retry.hidden=true;checkReceipt.hidden=true;
    const tableJoin=document.querySelector(".table-join");if(tableJoin)tableJoin.hidden=true;
    const savedLink=document.querySelector(".saved");if(savedLink&&!keepSavedLink)savedLink.hidden=true;
    if(fallback){fallback.hidden=false;fallback.textContent="Keep a copy of my choices ↓";fallback.style.cssText="width:100%;background:#143dc6;color:white;text-decoration:none;min-height:46px;padding:13px 16px;font-size:15px";}
  }

  function markInvitationEnded(){
    invitationEnded=true;clearInterval(observationTimer);
    button.hidden=true;retry.hidden=true;checkReceipt.hidden=true;
    for(const link of document.querySelectorAll(".table-join,a.saved"))link.hidden=true;
    const files=document.getElementById("guest-file-recovery");if(files)files.hidden=true;
    if(fallback){fallback.hidden=false;fallback.textContent="Keep a copy of my choices ↓";fallback.style.cssText="width:100%;background:#143dc6;color:white;text-decoration:none;min-height:46px;padding:13px 16px;font-size:15px";}
  }

  const fileRecovery=document.getElementById("guest-file-recovery");
  const fileInput=document.getElementById("guest-choices-file");
  let fileReadGeneration=0;
  fileInput?.addEventListener("change",async()=>{
    const selection=++fileReadGeneration;
    const file=fileInput.files?.[0],notice=document.getElementById("guest-file-status");if(!file)return;
    const version=sequence;
    try{
      if(sending||reviewOutcome||invitationEnded||receiptChanged||packet.submittedAt)throw Error("Open a fresh invitation before loading these choices.");
      if(file.size>16000)throw Error("Choose a Tabloom response file smaller than 16 KB.");
      const text=await file.text();
      if(selection!==fileReadGeneration)return;
      if(sending||reviewOutcome||invitationEnded||receiptChanged||packet.submittedAt||version!==sequence)throw Error("The choices changed while opening the file. Choose it again to review.");
      const restored=readGuestChoices(text,packet);
      for(const input of inputs)input.checked=restored.find(item=>item.id===input.dataset.item).selected;
      keepChoices();recovery.hidden=false;
      document.getElementById("guest-draft-status").textContent="File choices loaded. Review and send them to your organizer.";
      notice.textContent="";fileRecovery.open=false;updateStatus();void checkShare();
      recovery.scrollIntoView({block:"center"});document.getElementById("discard-guest-draft").focus({preventScroll:true});
    }catch(error){if(selection===fileReadGeneration)notice.textContent=error.message;}
    finally{if(selection===fileReadGeneration)fileInput.value="";}
  });

  const receivedChoices=()=>!!(packet.live&&packet.submittedAt&&inputs.every(input=>input.checked===packet.responseItems?.find(i=>i.id===input.dataset.item)?.selected));
  const syncSend=()=>{
    if(!packet.live)return;
    const received=receivedChoices();showBackupState();
    if(fileRecovery)fileRecovery.hidden=!!(packet.submittedAt||reviewOutcome||invitationEnded||receiptChanged);
    const discard=document.getElementById("discard-guest-draft");if(discard)discard.disabled=sending;
    button.disabled=invitationEnded||!!reviewOutcome||sending||checkReceipt.disabled||readyChoices!==JSON.stringify(choices())||received;
    button.textContent=sending?"Sending choices…":received?"Choices sent ✓":"Send choices to organizer →";
    button.dataset.confirmed=String(received&&!sending);
  };
  if(packet.responseItems)for(const input of inputs){const choice=packet.responseItems.find(i=>i.id===input.dataset.item);if(choice)input.checked=choice.selected;}
  const restored=draftStore.load();
  if(restored){for(const input of inputs)input.checked=restored.find(item=>item.id===input.dataset.item).selected;if(recovery)recovery.hidden=false;}
  const earlier=!restored?(draftStore.priorReply()||draftStore.earlier()):null;
  if(earlier){
    const offer=document.createElement("section");offer.id="earlier-guest-choices";
    const label=document.createElement("p");label.textContent=earlier.receivedChanged?"Earlier choices on this invitation":earlier.replacement?"Your choices from the previous invitation":"Your earlier choices from receipt "+earlier.revision;
    const use=document.createElement("button");use.id="use-earlier-guest-choices";use.type="button";use.textContent="Review my earlier choices";
    offer.append(label,use);recovery.after(offer);
    use.addEventListener("click",()=>{
      if(sending||reviewOutcome||invitationEnded||receiptChanged)return;
      for(const input of inputs){const old=earlier.items.find(item=>item.id===input.dataset.item);if(old)input.checked=old.selected;}
      keepChoices();offer.remove();recovery.hidden=false;
      document.getElementById("guest-draft-status").textContent=earlier.receivedChanged?"Earlier choices restored. Review and send again to update your reply.":earlier.replacement?"Previous invitation choices restored. Review and send them through this invitation.":earlier.skipped?"Matching earlier choices restored. "+earlier.skipped+" changed or removed item"+(earlier.skipped===1?" was":"s were")+" left out.":"Earlier choices restored. Review this receipt before sending.";
      updateStatus();void checkShare();
    });
  }
  document.getElementById("discard-guest-draft")?.addEventListener("click",()=>{
    if(sending||reviewOutcome||invitationEnded)return;draftStore.clear();unbackedChoices=false;showBackupState();recovery.hidden=true;
    for(const input of inputs)input.checked=packet.responseItems?.find(item=>item.id===input.dataset.item)?.selected??packet.items.find(item=>item.id===input.dataset.item).selected;
    updateStatus();void checkShare();
  });
  const updateStatus=()=>{
    if(!packet.live)button.textContent="Download my response ↓";
    syncSend();
    if(receiptChanged){status.textContent="Your choices are kept here. Use a fresh form to send an updated reply.";return;}
    if(reviewUnavailable){status.textContent="Your reply previously reached the organizer. The latest review could not be checked.";return;}
    if(receivedChoices()){
      status.textContent="Your prior response reached the organizer at "+new Date(packet.submittedAt).toLocaleTimeString()+". Awaiting their review.";
      return;
    }
    const changed=inputs.filter(input=>input.checked!==packet.items.find(i=>i.id===input.dataset.item).selected).length;
    status.textContent=changed?changed+" item choice"+(changed===1?"":"s")+" changed. The organizer reviews before saving.":"Your choices match the saved receipt.";
  };
  function showItemShares(lines,state="proposed"){
    for(const input of inputs){
      const row=input.closest(".item"),price=row.querySelector(".item-price");
      const original=packet.items.find(item=>item.id===input.dataset.item);
      const line=lines?.find(item=>item.itemId===input.dataset.item);
      const savedHint=row.querySelector(".item-name small:not(.proposed-item)");
      if(savedHint&&state==="proposed")savedHint.hidden=input.checked===original.selected&&(line?.shareCents??0)===original.shareCents;
      price.querySelector("strong").textContent=state==="proposed"?format(line?.shareCents??0):state==="checking"?"…":"—";
      price.querySelector("small").textContent=state==="proposed"?(packet.live?"proposed":"estimate"):state==="checking"?"checking":"not current";
      let hint=row.querySelector(".proposed-item");
      if(!hint){hint=document.createElement("small");hint.className="proposed-item";row.querySelector(".item-name").append(hint);}
      hint.textContent=state==="proposed"?(line?(line.portionCount?line.portionCount+" of "+line.totalPortions+" portions":line.sharedCount>1?"Shared "+line.sharedCount+" ways":"Your item")+" · "+format(original.cents)+" whole item":"Not selected · "+format(original.cents)+" whole item"):format(original.cents)+" whole item";
    }
  }
  function clearItemShares(){
    for(const input of inputs){
      const row=input.closest(".item"),price=row.querySelector(".item-price"),original=packet.items.find(item=>item.id===input.dataset.item);
      price.querySelector("strong").textContent=format(original.cents);price.querySelector("small").textContent="whole item";
      row.querySelector(".proposed-item")?.remove();
      const savedHint=row.querySelector(".item-name small");if(savedHint)savedHint.hidden=false;
    }
  }
  async function checkShare(){
    if(!packet.live){
      if(!preview)return;
      const result=estimateOfflineChoices(packet,choices());
      if(!result)return;
      if(result.share){
        showItemShares(result.share.lineItems);
        amount.textContent=format(result.share.totalCents);
        detail.textContent="From this receipt · tax and tip included.";
      }else{
        showItemShares(null,"unresolved");amount.textContent="Not final";
        detail.textContent=(result.unresolved.length===1?result.unresolved[0].name+" needs a diner.":result.unresolved.length+" dishes need a diner.")+" Download your choices for the organizer to resolve.";
      }
      return;
    }
    if(reviewOutcome||invitationEnded||receiptChanged)return;
    const current=++sequence,items=choices();
    if(request)request.abort();
    const controller=new AbortController();request=controller;
    readyChoices=null;syncSend();retry.hidden=true;
    preview.setAttribute("aria-busy","true");
    showItemShares(null,"checking");
    amount.textContent="Checking…";detail.textContent="Calculating your choices with tax and tip.";
    const timeout=setTimeout(()=>controller.abort(),10000);
    try{
      const response=await fetch(location.pathname+"/preview",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({items}),signal:controller.signal});
      const result=await response.json();
      if(!response.ok){const error=Error(result.error||"Could not check your proposed share.");error.status=response.status;throw error;}
      if(current!==sequence)return;
      if(result.share){
        showItemShares(result.share.lineItems);
        amount.textContent=format(result.share.totalCents);
        detail.textContent="Items "+format(result.share.itemsCents)+(result.share.discountCents?" − discount "+format(result.share.discountCents):"")+" + tax "+format(result.share.taxCents)+" + tip "+format(result.share.tipCents)+".";
      }else{
        showItemShares(null,"unresolved");
        amount.textContent="Not final";
        detail.textContent=(result.unresolved.length===1?result.unresolved[0].name+" needs a diner.":result.unresolved.length+" dishes need a diner.")+" Send your choices so the organizer can resolve this.";
      }
      readyChoices=JSON.stringify(items);if(fallback)fallback.hidden=!reviewUnavailable&&!unbackedChoices;
    }catch(error){
      if(current!==sequence)return;
      showItemShares(null,"unavailable");
      amount.textContent="Unavailable";
      detail.textContent=error.name==="AbortError"?"The total check took too long. Your choices are still here.":error instanceof TypeError?"Cannot reach the organizer’s app. Check your connection and ask them to keep Tabloom open.":error.status===409||error.status===410?"This invitation is no longer current. Ask the organizer for a fresh link; your choices are still here.":error.message;
      if(error.status===409)markReceiptChanged();
      if(error.status===410)markInvitationEnded();
      retry.hidden=error.status===409||error.status===410;if(fallback)fallback.hidden=false;
      if(fallback&&receiptChanged)fallback.textContent="Keep a copy of my choices ↓";
    }finally{
      clearTimeout(timeout);
      if(current===sequence){preview.setAttribute("aria-busy","false");syncSend();}
    }
  }
  const fallbackText=fallback?.textContent||"",fallbackStyle=fallback?.style.cssText||"";
  function showReviewUnavailable(message="Cannot check the latest review. Ask the organizer to keep Tabloom open and check your connection.",changed=false){
    if(sending||reviewOutcome||invitationEnded)return;
    if(changed)markReceiptChanged();
    clearItemShares();
    const first=!reviewUnavailable;reviewUnavailable=true;readyChoices=null;syncSend();
    document.querySelector(".share-heading span").textContent=amount.textContent.startsWith("$")?"Last checked share":"Your choices";
    detail.textContent=message;
    status.textContent="Your reply previously reached the organizer. The latest review could not be checked.";
    button.hidden=true;retry.hidden=true;checkReceipt.hidden=true;
    const savedLink=document.querySelector(".saved");if(savedLink)savedLink.hidden=true;
    if(fallback){fallback.hidden=false;fallback.textContent=receiptChanged?"Keep a copy of my choices ↓":"Download my choices ↓";fallback.style.cssText="width:100%;background:#143dc6;color:white;text-decoration:none;min-height:46px;padding:13px 16px;font-size:15px";}
    if(first)document.getElementById("handoff").hidden=true;
  }
  function restoreReviewConnection(){
    reviewUnavailable=false;button.hidden=false;
    const savedLink=document.querySelector(".saved");if(savedLink)savedLink.hidden=false;
    document.querySelector(".share-heading span").textContent="Your proposed share";
    if(fallback){fallback.textContent=fallbackText;fallback.style.cssText=fallbackStyle;}
  }
  let observing=false,observationTimer;
  async function observeFinalReview(){
    if(observing||invitationEnded||!reviewOutcome.current||document.hidden)return;
    observing=true;
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),8000);
    try{
      const response=await fetch(location.pathname+"/review-state",{cache:"no-store",signal:controller.signal});
      if(response.status===410){
        invitationEnded=true;clearInterval(observationTimer);
        document.querySelector(".share-heading span").textContent="Your earlier saved share";
        status.textContent="This invitation has ended. Ask the organizer for a fresh link to check your current share.";
        detail.textContent="Receipt "+reviewOutcome.revision+" was saved at "+format(reviewOutcome.totalCents)+".";
        for(const link of document.querySelectorAll(".saved,#review-outcome,.table-join")){link.hidden=true;link.style.display="none";}
        return;
      }
      if(!response.ok)throw Error();
      const result=await response.json();
      if(result.state!=="saved"||typeof result.current!=="boolean")throw Error();
      reviewOutcome.current=result.current;
      if(!result.current){const tableJoin=document.querySelector(".table-join");if(tableJoin)tableJoin.hidden=true;}
      if(!result.current){
        clearInterval(observationTimer);
        document.querySelector(".share-heading span").textContent="Your earlier saved share";
        detail.textContent="The receipt has changed again. Open the saved outcome for details.";
        document.getElementById("review-outcome").textContent="View earlier saved share →";
        const savedLink=document.querySelector(".saved");if(savedLink)savedLink.textContent="View earlier saved share ↗";
      }
      status.textContent="Your organizer saved "+format(reviewOutcome.totalCents)+".";
    }catch{status.textContent="Cannot check whether this saved share is still current. Reconnect to check again.";}
    finally{clearTimeout(timeout);observing=false;}
  }
  async function observeReview(unconfirmed=false){
    if(reviewOutcome){await observeFinalReview();return;}
    if(!packet.live||(!unconfirmed&&(!packet.submittedAt||receiptChanged))||invitationEnded||sending||observing||document.hidden)return;
    observing=true;const sendAtStart=sendGeneration;
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),8000);
    try{
      const response=await fetch(location.pathname+"/review-state?receipt=1",{signal:controller.signal});
      if(sendAtStart!==sendGeneration)return;
      if(response.status===410&&unconfirmed)return;
      if(response.status===410&&!sending){
        clearItemShares();
        invitationEnded=true;clearInterval(observationTimer);
        const tableJoin=document.querySelector(".table-join");if(tableJoin)tableJoin.hidden=true;
        ++sequence;if(request)request.abort();readyChoices=null;
        inputs.forEach(input=>input.disabled=true);
        document.querySelector(".share-heading span").textContent="Last proposed share";
        detail.textContent="This invitation has ended. Ask the organizer for a fresh invitation; download these choices to keep a copy.";
        status.textContent="Your reply previously reached the organizer. Its current review status is unavailable.";
        button.disabled=true;button.hidden=true;button.dataset.confirmed="false";
        retry.hidden=true;if(fallback){fallback.hidden=false;fallback.textContent=receiptChanged?"Keep a copy of my choices ↓":"Download my choices ↓";fallback.style.cssText="width:100%;background:#143dc6;color:white;text-decoration:none;min-height:46px;padding:13px 16px;font-size:15px";}
        const discard=document.getElementById("discard-guest-draft");if(discard)discard.disabled=true;
        const savedLink=document.querySelector(".saved");if(savedLink)savedLink.hidden=true;
        document.getElementById("handoff").hidden=true;
        preview.setAttribute("aria-busy","false");
        return;
      }
      if(!response.ok){if(!unconfirmed)showReviewUnavailable();return;}
      const result=await response.json();
      if(unconfirmed&&result.state!=="saved")return;
      if(sending||sendAtStart!==sendGeneration)return;
      if(result.state==="pending"){
        const received=result.responseItems;
        const valid=typeof result.submittedAt==="string"&&Array.isArray(received)&&received.length===inputs.length&&new Set(received.map(item=>item?.id)).size===inputs.length&&received.every(item=>typeof item?.selected==="boolean"&&inputs.some(input=>input.dataset.item===item.id));
        if(valid&&(result.submittedAt!==packet.submittedAt||received.some(item=>item.selected!==packet.responseItems?.find(old=>old.id===item.id)?.selected))){
          const hadFurtherChoices=!receivedChoices();
          packet.responseItems=received;packet.submittedAt=result.submittedAt;
          if(!hadFurtherChoices)for(const input of inputs)input.checked=received.find(item=>item.id===input.dataset.item).selected;
          const hasFurtherChoices=!receivedChoices();
          if(!hasFurtherChoices){draftStore.clear();unbackedChoices=false;if(recovery)recovery.hidden=true;}
          else keepChoices();
          if(reviewUnavailable)restoreReviewConnection();
          document.getElementById("handoff").hidden=true;
          updateStatus();
          status.textContent=hasFurtherChoices?"Your reply was updated in another tab. Your further choices are kept here; review and Send to update the organizer.":"Your latest received choices are shown. Updated in another tab; awaiting organizer review.";
          void checkShare();
          return;
        }
        if(reviewUnavailable){restoreReviewConnection();updateStatus();void checkShare();}
        return;
      }
      if(result.state==="changed"){showReviewUnavailable("This receipt has changed. Ask the organizer for a fresh invitation; your choices remain here.",true);return;}
      if(result.state!=="saved"||!Number.isSafeInteger(result.totalCents)){if(!unconfirmed)showReviewUnavailable();return;}
      const received=result.responseItems;
      if(typeof result.submittedAt!=="string"||!Array.isArray(received)||received.length!==inputs.length||
        new Set(received.map(item=>item?.id)).size!==inputs.length||
        received.some(item=>typeof item?.selected!=="boolean"||!inputs.some(input=>input.dataset.item===item.id))){if(!unconfirmed)showReviewUnavailable();return;}
      if(unconfirmed){
        packet.responseItems=received;packet.submittedAt=result.submittedAt;
        keepChoices();receiptChanged=false;restoreReviewConnection();
      }else{
        const hadFurtherChoices=!receivedChoices();
        packet.responseItems=received;packet.submittedAt=result.submittedAt;
        if(!hadFurtherChoices)for(const input of inputs)input.checked=received.find(item=>item.id===input.dataset.item).selected;
        keepChoices();if(reviewUnavailable)restoreReviewConnection();
      }
      clearItemShares();
      reviewOutcome=result;if(!result.current)clearInterval(observationTimer);
      {const tableJoin=document.querySelector(".table-join");if(tableJoin)tableJoin.hidden=true;}
      ++sequence;if(request)request.abort();
      const hasFurtherChoices=!receivedChoices();
      if(hasFurtherChoices)markReceiptChanged(true);
      amount.textContent=format(result.totalCents);
      document.querySelector(".share-heading span").textContent=result.current?"Your saved share":"Your earlier saved share";
      detail.textContent=hasFurtherChoices?"Keep a copy of your further choices, then ask for a fresh form.":result.current?"Receipt "+result.revision+" is ready to view.":"The receipt has changed again. Open the saved outcome for details.";
      status.textContent="Your organizer saved "+format(result.totalCents)+".";
      document.getElementById("handoff").hidden=true;
      button.hidden=true;retry.hidden=true;checkReceipt.hidden=true;
      inputs.forEach(input=>input.disabled=true);
      document.querySelector(".identity h2").textContent=hasFurtherChoices?"Your further choices":"Choices you sent";
      document.querySelectorAll(".item-name small").forEach(hint=>hint.remove());
      if(fallback)fallback.hidden=!hasFurtherChoices;
      const discard=document.getElementById("discard-guest-draft");if(discard)discard.disabled=true;
      const savedLink=document.querySelector(".saved");if(savedLink){savedLink.textContent="View saved share ↗";savedLink.href=location.pathname;}
      const link=document.createElement("a");link.id="review-outcome";link.href=location.pathname;link.textContent="View saved share →";link.style.cssText="display:block;text-align:center;padding:13px 16px;text-decoration:none;font-weight:700;min-height:46px;"+(hasFurtherChoices?"background:transparent;color:#143dc6;border:1px solid #143dc6":"background:#143dc6;color:white");button.after(link);
      preview.setAttribute("aria-busy","false");
    }catch{if(!unconfirmed&&sendAtStart===sendGeneration)showReviewUnavailable();}finally{clearTimeout(timeout);observing=false;}
  }
  if(packet.receiptChanged){
    markReceiptChanged();showItemShares(null,"unavailable");amount.textContent="Unavailable";
    document.querySelector(".share-heading span").textContent="Your earlier choices";
    detail.textContent="This receipt has changed. Ask the organizer for a fresh invitation; your choices remain here.";
  }
  if(packet.live){
    observationTimer=setInterval(()=>void observeReview(),5000);
    document.addEventListener("visibilitychange",()=>{if(!document.hidden)void observeReview();});
    window.addEventListener("online",()=>void observeReview());
    void observeReview();
  }
  inputs.forEach(input=>input.addEventListener("change",()=>{
    document.getElementById("handoff").hidden=true;
    keepChoices();if(recovery&&!draftStore.load())recovery.hidden=true;
    updateStatus();void checkShare();
  }));
  if(retry)retry.addEventListener("click",()=>void checkShare());
  checkReceipt.addEventListener("click",async()=>{
    if(sending||checkReceipt.disabled||invitationEnded||receiptChanged||reviewOutcome)return;
    checkReceipt.disabled=true;checkReceipt.textContent="Checking receipt…";syncSend();
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),8000);
    try{
      const response=await fetch(location.pathname+"/review-state?receipt=1",{signal:controller.signal});
      if(response.status===410){markInvitationEnded();status.textContent="This invitation has ended. Keep a copy of your choices and ask for a fresh invitation.";return;}
      if(!response.ok)throw Error();
      const result=await response.json();
      if(result.state==="saved"){await observeReview(true);checkReceipt.hidden=!!reviewOutcome;return;}
      if(result.state==="changed"){markReceiptChanged();status.textContent="The receipt has changed. Keep your choices and ask for a fresh invitation.";return;}
      if(result.state!=="pending")throw Error();
      if(result.submittedAt===null){status.textContent="The organizer has not received a reply through this invitation. Review your choices and Send when ready.";return;}
      const received=result.responseItems;
      if(typeof result.submittedAt!=="string"||!Array.isArray(received)||received.length!==inputs.length||new Set(received.map(item=>item?.id)).size!==inputs.length||received.some(item=>typeof item?.selected!=="boolean"||!inputs.some(input=>input.dataset.item===item.id)))throw Error();
      packet.responseItems=received;packet.submittedAt=result.submittedAt;
      if(receivedChoices()){draftStore.clear();unbackedChoices=false;if(recovery)recovery.hidden=true;if(fallback)fallback.hidden=true;status.textContent="Received by organizer at "+new Date(result.submittedAt).toLocaleTimeString()+". Awaiting their review.";}
      else{keepChoices();status.textContent="Your earlier choices reached the organizer. Your further changes are still here; review and Send to update your reply.";}
      checkReceipt.hidden=true;syncSend();
    }catch{status.textContent="Cannot check receipt right now. Your choices are still here. Reconnect and check again.";}
    finally{clearTimeout(timeout);checkReceipt.disabled=false;checkReceipt.textContent="Check receipt";syncSend();}
  });

  updateStatus();void checkShare();
  button.addEventListener("click",async()=>{
    const response=responsePacket();
    if(packet.live){
      if(sending||reviewOutcome||invitationEnded||receivedChoices())return;
      if(readyChoices!==JSON.stringify(response.items)){void checkShare();return;}
      sendGeneration++;sending=true;checkReceipt.hidden=true;syncSend();inputs.forEach(input=>input.disabled=true);status.textContent="Sending your choices…";
      let checkSaved=false;
      const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);
      try{
        const r=await fetch(location.pathname+"/response",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({items:response.items}),signal:controller.signal});
        const result=await r.json();if(!r.ok){const error=Error(result.error||"The response did not arrive.");error.status=r.status;throw error;}
        draftStore.clear();unbackedChoices=false;showBackupState();if(recovery)recovery.hidden=true;
        packet.responseItems=response.items;packet.submittedAt=result.submittedAt;if(fallback)fallback.hidden=true;
        document.getElementById("handoff").textContent=result.message;document.getElementById("handoff").hidden=false;
        status.textContent="Received by organizer at "+new Date(result.submittedAt).toLocaleTimeString()+". Awaiting their review.";
      }catch(error){if(error.status===409){checkSaved=true;markReceiptChanged();}if(error.status===410)markInvitationEnded();if(error.status===409||error.status===410){showItemShares(null,"unavailable");readyChoices=null;amount.textContent="Unavailable";detail.textContent="This invitation is no longer current. Ask the organizer for a fresh link; your choices are still here.";retry.hidden=true;status.textContent="These choices were not accepted through this invitation.";}else{checkReceipt.hidden=false;status.textContent="Could not confirm receipt. Check whether your choices reached the organizer before sending again."; }if(fallback)fallback.hidden=false;}
      finally{clearTimeout(timeout);sending=false;syncSend();inputs.forEach(input=>input.disabled=false);if(checkSaved)void observeReview(true);}
      return;
    }
    downloadChoices();
  });
}
export function renderGuestReview(packet){
  const data=JSON.stringify(packet).replace(/</g,"\\u003c");
  const live=Boolean(packet.live);
  const tableJoin=live&&!packet.receiptChanged&&packet.tableJoinUrl?'<a class="table-join" href="'+esc(packet.tableJoinUrl)+'">Choose a different name</a>':'';
  const saved=live&&packet.checkoutUrl?'<a class="saved" href="'+esc(packet.checkoutUrl)+'">Saved share '+money(packet.totalCents)+' ↗</a>':'<span class="saved">Saved share '+money(packet.totalCents)+'</span>';
  const rows=packet.items.map(i=>'<label class="item"><input type="checkbox" data-item="'+esc(i.id)+'" '+(i.selected?'checked':'')+'><span class="item-name"><b>'+esc(i.name)+'</b><small>'+(i.selected?'Saved: '+money(i.shareCents)+(i.portionCount?' · '+i.portionCount+' of '+i.totalPortions+' portions':i.sharedCount>1?' · '+i.sharedCount+' diners':''):'Not in your saved share')+'</small></span><span class="item-price"><strong>'+money(i.cents)+'</strong><small>whole item</small></span></label>').join('');
  const preview=(live||packet.offlineEstimate)?'<section id="share-preview" aria-live="polite" aria-atomic="true"><div class="share-heading"><span>'+(live?'Your proposed share':'Your estimated share')+'</span><strong id="proposed-total">Checking…</strong></div><p id="proposed-detail">Calculating your choices.</p><button id="preview-retry" type="button" hidden>Retry total</button></section>':'';
  const fileRecovery=live&&!packet.submittedAt&&!packet.receiptChanged?'<details id="guest-file-recovery"><summary>Load saved choices</summary><label for="guest-choices-file">Tabloom response file</label><input id="guest-choices-file" type="file" accept=".json,application/json"><p id="guest-file-status" role="status"></p></details>':'';
  const dishFinder=packet.items.length>=12?'<section id="guest-dish-finder"><label for="guest-item-search">Find a dish</label><div class="dish-search-row"><input id="guest-item-search" type="search" placeholder="Dish name" autocomplete="off"><button id="clear-guest-item-search" type="button" hidden>Clear</button></div><p id="guest-item-search-status" role="status" hidden></p></section>':'';
  const css='#guest-dish-finder{margin:16px 0 8px}#guest-dish-finder label{display:block;font-size:13px;font-weight:650;margin-bottom:6px}.dish-search-row{display:flex;align-items:center;gap:8px}.dish-search-row input{flex:1;min-width:0;width:100%;height:44px;padding:9px 11px;border:1px solid #9ba9ba;background:#fff;color:#102858;font:16px system-ui}#clear-guest-item-search{flex:none;width:auto;min-height:44px;background:transparent;color:#143dc6;padding:8px 10px;font-size:14px;text-decoration:underline}#guest-item-search-status{font-size:13px;color:#425661;margin:8px 0 12px}.item[hidden]{display:none}.table-join{display:inline-flex;align-items:center;min-height:44px;margin:4px 0;color:#143dc6;text-underline-offset:3px;font-size:14px}.table-join[hidden]{display:none}#guest-file-recovery{margin:12px 0;font-size:13px}#guest-file-recovery summary{min-height:44px;display:list-item;padding:12px 0;cursor:pointer;color:#143dc6}#guest-file-recovery input{display:block;width:100%;min-height:44px;margin:8px 0}#guest-file-status{color:#8b2d1b}#earlier-guest-choices{padding:10px 0 14px;border-bottom:1px solid #cbd1cd}#earlier-guest-choices p{font-size:13px;margin:0 0 8px}#earlier-guest-choices button{font-size:14px;min-height:44px;background:white;color:#143dc6;border:1px solid #143dc6}#guest-draft-recovery{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:10px 0;padding:8px 0;border-bottom:1px solid #cbd1cd;font-size:12px}#guest-draft-recovery[hidden]{display:none}#discard-guest-draft{width:auto;background:transparent;color:#143dc6;padding:5px;min-height:32px;font-size:12px;text-decoration:underline}*{box-sizing:border-box}body{margin:0;background:#f5f3ed;color:#17232d;font:15px/1.45 system-ui,sans-serif}main{max-width:720px;margin:auto;padding:19px 24px calc(var(--review-footer-height,190px) + 20px)}header{display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:2px solid #17232d;padding-bottom:10px;font-size:11px;color:#58666e}header b{color:#b7452e;font-size:13px;letter-spacing:.1em}h1{font:26px/1.15 Georgia,serif;margin:17px 0 12px;overflow-wrap:anywhere}.identity{display:flex;align-items:baseline;justify-content:space-between;gap:8px;flex-wrap:wrap;padding-bottom:12px;border-bottom:1px solid #b7c2c4}.identity h2{font-size:15px;margin:0;font-weight:700}.saved{color:#425661;font-size:13px;text-underline-offset:3px}.item{display:grid;grid-template-columns:22px minmax(0,1fr) auto;gap:10px;align-items:start;padding:13px 0;border-bottom:1px solid #cbd1cd;cursor:pointer;min-height:69px}.item input{width:21px;height:21px;accent-color:#123d58;margin:1px 0}.item-name b{font-weight:650;overflow-wrap:anywhere}.item small{display:block;color:#58666e;font-size:11px;line-height:1.4;margin-top:3px}.item small[hidden]{display:none}.item-price{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.item-price strong{font-size:14px;font-weight:650}.bottom{position:fixed;bottom:0;left:0;right:0;background:#f5f3ed;border-top:2px solid #123d58;padding:12px 24px 15px;padding-bottom:max(15px,env(safe-area-inset-bottom))}.bottom>div{max-width:672px;margin:auto}.share-heading{display:flex;align-items:baseline;justify-content:space-between;gap:12px}.share-heading span{font-size:13px;font-weight:650}.share-heading strong{font-size:28px;line-height:1.15;font-variant-numeric:tabular-nums}#proposed-detail{font-size:12px;line-height:1.4;margin:5px 0 9px;color:#425661}#status{font-size:12px;color:#425661;margin:8px 0}button{padding:13px 16px;background:#123d58;border:0;color:white;font:700 15px system-ui;cursor:pointer;width:100%;min-height:46px}button:disabled{opacity:.6;cursor:wait}#download-response[data-confirmed="true"]{cursor:default}button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid #b7452e;outline-offset:3px}#preview-retry,#download-offline-response{width:auto;min-height:36px;font-size:13px;padding:7px 0;background:transparent;color:#123d58;text-decoration:underline}#handoff{padding:13px 0;color:#285946;font-size:13px}.offline main{padding-bottom:calc(var(--review-footer-height,210px) + 20px)}.offline-note{font-size:13px;color:#425661;margin-top:18px}[hidden]{display:none}@media(min-width:700px){main{padding-bottom:22px}.bottom{position:sticky;max-width:720px;margin:0 auto;border-top-width:1px}}@media(max-width:360px){main{padding-left:17px;padding-right:17px}h1{font-size:24px}.bottom{padding-left:17px;padding-right:17px}.item{gap:8px}.identity{gap:5px}}@media(max-height:540px){main,.offline main{padding-bottom:20px}.bottom{position:static}}';
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; connect-src \'self\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'; object-src \'none\'"><title>'+esc(packet.title)+' — '+esc(packet.guestName)+' choices</title><style>'+css+''+guestIdentityStyles+'</style></head><body class="'+(live?'live':'offline')+'"><main><header><b>TABLOOM</b><span>Receipt '+esc(packet.revision)+'</span></header><h1>'+esc(packet.title)+'</h1><div class="identity"><h2>'+esc(packet.guestName)+'’s choices</h2>'+saved+'</div>'+tableJoin+dishFinder+'<div id="guest-draft-recovery" hidden><span id="guest-draft-status" role="status">Unsent choices restored.</span><button id="discard-guest-draft" type="button">Discard</button></div>'+'<div aria-label="Receipt item choices">'+rows+'</div>'+fileRecovery+'<p id="handoff" hidden>Response downloaded. Send the JSON file to your organizer.</p>'+(!live?'<p class="offline-note">Select your items, download your choices, then send the file to the organizer.</p>':'')+'</main><div class="bottom"><div>'+preview+'<p id="status" role="status"></p>'+(live?'<button id="download-offline-response" type="button" hidden>Download choices to send manually ↓</button>':'')+'<button id="download-response" type="button">'+(live?'Send choices to organizer →':'Download my response ↓')+'</button></div></div><script id="review-data" type="application/json">'+data+'</script><script>const guestFileName=('+guestFileName.toString()+');const allocateExactCents=('+allocateExactCents.toString()+');const estimateOfflineChoices=('+estimateOfflineChoices.toString()+');const createGuestDraftStore=('+createGuestDraftStore.toString()+');const readGuestChoices=('+readGuestChoices.toString()+');('+guestPage.toString()+')();</script></body></html>';
}

function savedChoiceRecovery(){
  const packet=JSON.parse(document.getElementById("saved-recovery-data").textContent);
  if(!packet)return;
  let storage;try{storage=window.localStorage;}catch{}
  const store=createGuestDraftStore(storage,packet,location.pathname),choices=store.load()||store.priorReply()?.items;
  if(!choices||choices.every(choice=>choice.selected===(packet.responseItems?.find(item=>item.id===choice.id)?.selected??packet.items.find(item=>item.id===choice.id)?.selected)))return;
  const panel=document.getElementById("saved-choice-recovery");panel.hidden=false;
  const list=document.getElementById("further-choice-list");
  for(const item of packet.items){const row=document.createElement("li"),name=document.createElement("strong"),selection=document.createElement("span");name.textContent=item.name;selection.textContent=choices.find(choice=>choice.id===item.id)?.selected?"Selected":"Not selected";row.append(name,selection);list.append(row);}
  document.getElementById("keep-further-choices").addEventListener("click",()=>{
    const text=[packet.title,packet.guestName+"’s choices from receipt "+packet.revision,"","Use this list with a fresh form from your organizer.","","Selected",...packet.items.filter(item=>choices.find(choice=>choice.id===item.id)?.selected).map(item=>"- "+item.name),"","Not selected",...packet.items.filter(item=>!choices.find(choice=>choice.id===item.id)?.selected).map(item=>"- "+item.name),""].join("\n");
    const url=URL.createObjectURL(new Blob([text],{type:"text/plain;charset=utf-8"})),link=document.createElement("a");link.href=url;link.download=guestFileName(packet,"choices","txt");link.click();setTimeout(()=>URL.revokeObjectURL(url),5000);
    document.getElementById("further-choice-status").textContent="Choice summary downloaded. Ask your organizer for a fresh form.";
  });
}

function observeSavedShare(){
  const state=JSON.parse(document.getElementById("saved-share-data").textContent);
  if(!state.current||!/^\/guest\/[a-f0-9]{48}$/.test(location.pathname))return;
  const notice=document.getElementById("saved-share-status"),payment=document.querySelector(".payment"),paymentNext=document.getElementById("payment-next"),tableJoin=document.querySelector(".table-join");
  let pending=false,ended=false,interval;
  async function check(){
    if(pending||ended||document.visibilityState==="hidden")return;
    pending=true;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);
    try{
      const response=await fetch(location.pathname+"/review-state",{cache:"no-store",signal:controller.signal});
      if(response.status===410){ended=true;notice.textContent="This invitation has ended. Ask the organizer for a fresh link to check your current share.";if(payment)payment.hidden=true;if(paymentNext)paymentNext.hidden=true;if(tableJoin)tableJoin.hidden=true;notice.hidden=false;return;}
      if(!response.ok)throw Error();const result=await response.json();
      if(result.state!=="saved"||typeof result.current!=="boolean")throw Error();
      if(!result.current){ended=true;document.querySelector("h1").textContent=state.guestName+"’s earlier share";notice.textContent="The receipt has changed. Ask the organizer for your current share.";if(payment)payment.hidden=true;if(paymentNext)paymentNext.hidden=true;if(tableJoin)tableJoin.hidden=true;notice.hidden=false;}
      else{notice.hidden=true;if(payment)payment.hidden=false;}
    }catch{notice.textContent="Cannot check whether this share is still current. Reconnect to check again.";notice.hidden=false;}
    finally{clearTimeout(timer);pending=false;if(ended)clearInterval(interval);}
  }
  document.addEventListener("visibilitychange",()=>{if(document.visibilityState!=="hidden")void check();});
  window.addEventListener("online",()=>void check());
  const resume=()=>{clearInterval(interval);if(!ended)interval=setInterval(()=>void check(),5000);void check();};
  window.addEventListener("pagehide",()=>clearInterval(interval));window.addEventListener("pageshow",resume);resume();
}

export function renderGuestOutcome(packet){
  const date=new Date(packet.savedAt);
  const when=date.toLocaleString("en-US",{timeZone:"UTC",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})+" UTC";
  const items=packet.items.filter(item=>item.selected).map(item=>{
    const portion=item.portionCount?item.portionCount+" of "+item.totalPortions+" portions":item.sharedCount>1?"Shared "+item.sharedCount+" ways":"";
    return '<li><div><strong>'+esc(item.name)+'</strong>'+(portion?'<small>'+esc(portion)+'</small>':'')+'</div><span>'+money(item.shareCents)+'</span></li>';
  }).join("");
  const tableJoin=packet.current&&packet.tableJoinUrl?'<a class="table-join" href="'+esc(packet.tableJoinUrl)+'">Choose a different name</a>':'';
  const payment=packet.current&&packet.checkoutUrl?'<a class="payment" href="'+esc(packet.checkoutUrl)+'">View my payment status <span aria-hidden="true">→</span></a>':'';
  const paymentNext=packet.current&&packet.reviewOnly&&packet.totalCents>0?'<p id="payment-next">Ask your organizer for your personal payment invitation.</p>':'';
  const recovery='<section id="saved-choice-recovery" hidden aria-labelledby="further-heading"><h2 id="further-heading">Your further choices</h2><p id="further-choice-status" role="status">These choices were not in the saved reply. Keep a copy and ask your organizer for a fresh form.</p><button id="keep-further-choices" type="button">Keep a copy of my choices ↓</button><details><summary>See my further choices</summary><ul id="further-choice-list"></ul></details></section>';
  const recoveryData=JSON.stringify(packet.recoveryPacket??null).replace(/</g,"\\u003c");
  const changed='<p id="saved-share-status" class="changed" role="status"'+(packet.current?' hidden':'')+'>'+(packet.current?'':'The receipt has changed. Ask the organizer for your current share.')+'</p>';
  const shareData=JSON.stringify({current:!!packet.current,guestName:packet.guestName}).replace(/</g,"\\u003c");
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+esc(packet.title)+' — '+esc(packet.guestName)+'’s saved share</title><style>'+
    '*{box-sizing:border-box}body{margin:0;background:#f5f3ed;color:#17232d;font:16px/1.45 system-ui,sans-serif}main{max-width:600px;margin:0 auto;padding:24px 22px 40px}header{display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #17232d;padding-bottom:16px}.brand{font:700 25px/1 Georgia,serif;letter-spacing:-1px}.sandbox{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#68757a}.meal{margin:26px 0 6px;color:#526067;font-size:15px;overflow-wrap:anywhere}h1{font:30px/1.15 Georgia,serif;margin:0 0 12px;overflow-wrap:anywhere}.amount{font-size:52px;line-height:1.1;font-weight:750;letter-spacing:-2px;font-variant-numeric:tabular-nums;margin:0 0 8px}.saved-at{margin:0;color:#526067;font-size:13px}.payment{display:flex;justify-content:space-between;gap:16px;align-items:center;min-height:52px;background:#17232d;color:#fff;text-decoration:none;padding:13px 16px;margin:22px 0 28px;font-weight:650}.payment:hover{background:#31444f}.payment:focus-visible{outline:3px solid #ff644e;outline-offset:4px}.payment span{color:#ff907a;font-size:22px}.changed{border-left:3px solid #ff644e;padding-left:12px;margin:22px 0;color:#526067}h2{margin:26px 0 0;font-size:14px;font-weight:650}ul{list-style:none;padding:0;margin:0}li{display:flex;justify-content:space-between;gap:22px;padding:16px 0;border-bottom:1px solid #cbd1cd}li div{min-width:0}li strong{font-weight:550;overflow-wrap:anywhere}li span{white-space:nowrap;font-variant-numeric:tabular-nums}small{display:block;color:#68757a;font-size:12px;margin-top:3px}dl{margin:20px 0 0}dl div{display:flex;justify-content:space-between;gap:20px;padding:5px 0;font-size:14px}dd{margin:0;white-space:nowrap;font-variant-numeric:tabular-nums}.total{border-top:2px solid #17232d;margin-top:12px;padding-top:14px!important;font-size:18px!important;font-weight:700}footer{margin-top:25px;color:#68757a;font-size:12px}@media(min-width:700px){main{padding-top:38px}.amount{font-size:60px}h1{font-size:36px}}'+
    '#payment-next{margin:20px 0;color:#425661;font-size:14px;line-height:1.5}[hidden]{display:none}.table-join{display:inline-flex;align-items:center;min-height:44px;margin:8px 0;color:#143dc6;text-underline-offset:3px;font-size:14px}.table-join[hidden]{display:none}#saved-choice-recovery{border:1px solid #143dc6;padding:14px 16px;margin:20px 0}#saved-choice-recovery h2{margin:0}#saved-choice-recovery p{font-size:14px;margin:8px 0 12px}#keep-further-choices{background:#143dc6;color:white;border:0;min-height:46px;width:100%;padding:12px;font:700 14px system-ui;cursor:pointer}#saved-choice-recovery details{margin-top:12px;font-size:13px}#saved-choice-recovery summary{cursor:pointer}#saved-choice-recovery li{font-size:13px;gap:12px}'+guestIdentityStyles+'</style></head><body><main><header><span class="brand">Tabloom</span><span class="sandbox">Sandbox</span></header><p class="meal">'+esc(packet.title)+'</p><h1>'+esc(packet.guestName)+'’s '+(packet.current?'saved share':'earlier share')+'</h1><p class="amount">'+money(packet.totalCents)+'</p><p class="saved-at">Saved <time datetime="'+esc(date.toISOString())+'">'+esc(when)+'</time></p>'+tableJoin+changed+recovery+payment+paymentNext+'<section aria-labelledby="items-heading"><h2 id="items-heading">Your items</h2><ul>'+items+'</ul></section><dl><div><dt>Items</dt><dd>'+money(packet.itemsCents)+'</dd></div>'+(packet.discountCents?'<div><dt>Receipt discount</dt><dd>−'+money(packet.discountCents)+'</dd></div>':'')+'<div><dt>Tax</dt><dd>'+money(packet.taxCents)+'</dd></div><div><dt>Tip</dt><dd>'+money(packet.tipCents)+'</dd></div><div class="total"><dt>Total</dt><dd>'+money(packet.totalCents)+'</dd></div></dl><footer>Saved by your organizer · Receipt '+packet.revision+'</footer></main><script id="saved-recovery-data" type="application/json">'+recoveryData+'</script><script id="saved-share-data" type="application/json">'+shareData+'</script><script>const guestFileName=('+guestFileName.toString()+');const createGuestDraftStore=('+createGuestDraftStore.toString()+');('+savedChoiceRecovery.toString()+')();('+observeSavedShare.toString()+')();</script></body></html>';
}
