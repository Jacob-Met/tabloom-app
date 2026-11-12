const esc=value=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
/** Controls the guest listener only. Never reloads or edits a receipt draft. */
export function initGuestNetwork({element,api,onChange}) {
  let current=null,pending=false,selected="",message="",failed=false;
  function render() {
    const addresses=current?.addresses||[];
    if(!selected&&addresses.length)selected=addresses[0].address;
    let controls="";
    if(current?.enabled){
      let address="";try{address=new URL(current.origin).hostname;}catch{}
      controls='<p class="guest-network-state"><strong>Invitations are on</strong>'+(address?' · '+esc(address):'')+'</p><p>Choose Invite beside a diner to show their QR code.</p><button type="button" class="text-button" data-network-action="stop" '+(pending?'disabled':'')+'>Stop all guest invitations</button>';
    } else if(current?.remembered) {
      let host="";try{host=new URL(current.resumeOrigin).hostname;}catch{}
      const available=addresses.some(a=>a.address===host);
      selected=host;
      controls='<p>Saved invitations are paused at '+esc(current.resumeOrigin)+'. Resume there to keep the same guest and payment return links, or stop them before starting on a different network.</p><div class="guest-network-actions"><button type="button" class="outline" data-network-action="start" '+(pending||!available?'disabled':'')+'>Resume saved invitations</button><button type="button" class="text-button" data-network-action="stop" '+(pending?'disabled':'')+'>Stop saved invitations</button><button type="button" class="text-button" data-network-action="refresh" '+(pending?'disabled':'')+'>Refresh available addresses</button></div>';
    } else if(current) {
      controls='<p>Same network · Links last 2 hours</p>';
      if(addresses.length>1)controls+='<label class="guest-network-address">Guest network<select id="guest-network-address" '+(pending?'disabled':'')+'>'+addresses.map(a=>'<option value="'+esc(a.address)+'" '+(a.address===selected?'selected':'')+'>'+esc(a.address)+(a.name?' · '+esc(a.name):'')+'</option>').join("")+'</select></label>';
      controls+='<div class="guest-network-actions">'+(addresses.length?'<button type="button" class="outline" data-network-action="start" '+(pending?'disabled':'')+'>Enable guest invitations</button>':'<p>Connect this computer to a private network to invite other diners.</p>')+'<button type="button" class="text-button" data-network-action="refresh" '+(pending?'disabled':'')+'>Refresh available addresses</button></div>';
    } else controls='<button type="button" class="text-button" data-network-action="refresh" '+(pending?'disabled':'')+'>Check guest invitations</button>';
    element.innerHTML='<h3>Invite diners on this network</h3>'+controls+'<p id="guest-network-status" class="guest-network-status'+(failed?' error':'')+'" role="status" aria-live="polite">'+esc(message)+'</p>';
    element.setAttribute("aria-busy",String(pending));
  }
  async function requestState(path,body){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
    try{return await api(path,body,controller.signal);}
    catch(error){if(controller.signal.aborted)throw Error("The invitation response timed out.");throw error;}
    finally{clearTimeout(timer);}
  }
  async function act(action="refresh") {
    if(pending)return;
    pending=true;failed=false;message=action==="start"?"Opening guest invitations…":action==="stop"?"Stopping guest invitations…":"Checking available addresses…";render();
    try {
      current=await requestState("guest-network"+(action==="refresh"?"":"/"+action),action==="refresh"?undefined:action==="start"?{address:selected}:{});
      if(!current.addresses?.some(a=>a.address===selected))selected=current.addresses?.[0]?.address||"";
      message=action==="start"?"Guest invitations are ready.":action==="stop"?"Guest invitations stopped. Your saved receipt and payment records are still available in the organizer.":!current.remembered&&!current.localOnly&&current.addresses?.length?"":current.message||"";
      await onChange(current,action);
    } catch(error) {
      failed=true;message=error.message+" Your receipt edits are still here.";
      // A listener change can finish even if its response is lost. Read current state; never replay it.
      if(action!=="refresh"){
        try{
          current=await requestState("guest-network");await onChange(current,action);
          failed=false;message=current.enabled?"Guest invitations are on. Their current state has been checked.":"Guest invitations are stopped. Your saved receipt and payment records are still available in the organizer.";
        }catch{current=null;message="Could not confirm the current invitation state. Check guest invitations when connected. Your receipt edits are still here.";}
      }
    } finally {pending=false;render();}
  }
  element.addEventListener("change",event=>{if(event.target.id==="guest-network-address")selected=event.target.value;});
  element.addEventListener("click",event=>{const button=event.target.closest("[data-network-action]");if(button)void act(button.dataset.networkAction);});
  render();void act();
  return {refresh:()=>act()};
}
