const esc=value=>String(value).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const money=cents=>"$"+(cents/100).toFixed(2);

export function createGuestResponseView(host, handlers) {
  const stylesheet=document.createElement("link");
  stylesheet.rel="stylesheet";
  stylesheet.href=new URL("./guest-response-view.css",import.meta.url).href;
  document.head.append(stylesheet);
  const dialog=document.createElement("dialog");
  dialog.id="guest-review-dialog";
  dialog.className="guest-review-dialog";
  dialog.setAttribute("aria-labelledby","guest-review-title");
  host.removeAttribute("role");
  host.removeAttribute("aria-live");
  dialog.append(host);
  document.body.append(dialog);
  let busy=false,recovery=null,returnFocus=null;
  const button=id=>dialog.querySelector("#"+id);
  function close(){
    if(dialog.open)dialog.close();
    if(returnFocus?.isConnected)returnFocus.focus({preventScroll:true});
  }
  function dismiss(){if(busy)return;handlers.onDismiss();close();}
  dialog.addEventListener("cancel",event=>{event.preventDefault();dismiss();});
  dialog.addEventListener("click",event=>{
    const id=event.target.closest("button")?.id;
    if(!id||busy)return;
    if(id==="dismiss-guest-response")dismiss();
    if(id==="save-guest-response")handlers.onSave();
    if(id==="resolve-guest-response")handlers.onResolve();
    if(id==="refresh-reviewed-responses")handlers.onRefresh();
    if(id==="check-reviewed-save")handlers.onCheck();
    if(id==="close-reviewed-response")dismiss();
  });
  function setBusy(value){
    busy=value;
    dialog.setAttribute("aria-busy",String(value));
    for(const control of dialog.querySelectorAll("button"))control.disabled=value;
    if(button("save-guest-response"))button("save-guest-response").textContent=value?"Saving…":"Save reviewed split";
  }
  function showError(message,action="refresh"){
    recovery=action;
    const status=button("guest-review-status");
    status.textContent=message;
    status.hidden=false;
    status.setAttribute("role","alert");
    const primary=dialog.querySelector(".guest-review-commit");
    if(primary)primary.hidden=true;
    button("guest-review-recovery").innerHTML=action==="refresh"?'<button id="refresh-reviewed-responses" class="primary" type="button">Review latest replies</button>':action==="check"?'<button id="check-reviewed-save" class="primary" type="button">Check saved receipt</button>':'<button id="close-reviewed-response" class="primary" type="button">Back to receipt</button>';
    status.focus({preventScroll:true});
    setBusy(busy);
  }
  function show({preview,before,source}) {
    recovery=null;
    const reviews=preview.reviews??[{guest:preview.guest,changes:preview.changes}];
    const oldAmounts=new Map(before.calculated.dues.map(d=>[d.guestId,d.totalCents]));
    const resets=preview.bill.items.filter(item=>before.bill.items.find(old=>old.id===item.id)?.portions&&!item.portions);
    const names=reviews.map(review=>review.guest);
    const heading=names.length===1?"Review "+names[0]+"’s choices":"Review replies";
    const choices='<dl class="response-choices">'+reviews.map(review=>'<div><dt>'+esc(review.guest)+'</dt><dd>'+(review.changes.length?'<ul>'+review.changes.map(change=>'<li><span class="reply-change-sign" aria-label="'+(change.selected?"Added":"Removed")+'">'+(change.selected?"+":"−")+'</span><span>'+esc(change.name)+'</span></li>').join("")+'</ul>':'<span class="reply-unchanged">Same choices</span>')+'</dd></div>').join("")+'</dl>';
    const totals=preview.unresolved.length?'<section class="reply-unassigned"><h3>Who shared these?</h3><ul>'+preview.unresolved.map(item=>'<li>'+esc(item.name)+'</li>').join("")+'</ul></section>':
      '<section class="reply-amounts"><h3>Updated shares</h3><table class="response-totals"><thead><tr><th scope="col">Diner</th><th scope="col">Saved</th><th scope="col">With replies</th></tr></thead><tbody>'+preview.calculated.dues.map(d=>'<tr'+(oldAmounts.get(d.guestId)!==d.totalCents?' class="reply-amount-changed"':'')+'><th scope="row">'+esc(d.name)+'</th><td>'+money(oldAmounts.get(d.guestId))+'</td><td>'+money(d.totalCents)+'</td></tr>').join("")+'</tbody><tfoot><tr><th scope="row">Total</th><td>'+money(before.calculated.totalCents)+'</td><td>'+money(preview.calculated.totalCents)+'</td></tr></tfoot></table><p class="reply-charges">Tax '+money(preview.bill.taxCents)+' · tip '+money(preview.bill.tipCents)+(preview.bill.discountCents?' · discount −'+money(preview.bill.discountCents):'')+' included</p></section>';
    host.innerHTML='<header class="guest-review-heading"><div><p>'+esc(before.bill.title)+'</p><h2 id="guest-review-title" tabindex="-1">'+esc(heading)+'</h2></div><button id="dismiss-guest-response" type="button" aria-label="Close reply review">×</button></header><div class="guest-review-body"><section class="reply-changes"><h3>Item changes</h3>'+choices+(resets.length?'<p class="reply-portions">'+resets.map(item=>esc(item.name)).join(", ")+' → equal shares</p>':'')+'</section>'+totals+'</div><footer class="guest-review-actions"><p id="guest-review-status" tabindex="-1" hidden></p><div id="guest-review-recovery"></div><div class="guest-review-commit">'+(preview.unresolved.length?'<button id="resolve-guest-response" class="primary" type="button">Assign '+preview.unresolved.length+' '+(preview.unresolved.length===1?'item':'items')+'</button>':'<button id="save-guest-response" class="primary" type="button">Save reviewed split</button>')+'</div></footer>';
    if(!dialog.open){returnFocus=document.activeElement;dialog.showModal();}
    host.scrollTop=0;
    setBusy(false);
    button("guest-review-title").focus({preventScroll:true});
  }
  return {show,close,setBusy,showError,isOpen:()=>dialog.open};
}
