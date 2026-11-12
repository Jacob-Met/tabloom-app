import {guestIdentityStyles} from './guest-identity.js';
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function checkoutPage() {
  const initial = JSON.parse(document.getElementById("checkout-data").textContent);
  let packet = initial, busy = false, unavailable = false, providerUnavailable = false, ended = false, checkedUncertain = false, approvalOpened = new URLSearchParams(location.search).get("returned")==="1";
  const panel = document.getElementById("payment");
  const notice = document.getElementById("notice");
  const money = cents => "$" + (cents / 100).toFixed(2);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const button = (action, text, secondary = false) => '<button type="button" data-action="'+action+'"'+(secondary?' class="secondary"':'')+(busy?' disabled':'')+'>'+text+'</button>';
  function approvalUrl() {
    try { const u=new URL(packet.payment?.approvalUrl); return u.protocol==="https:" && ["sandbox.paypal.com","www.sandbox.paypal.com"].includes(u.hostname) && !u.username && !u.password && !u.port ? u.href : null; } catch { return null; }
  }
  function render() {
    const p = packet.payment, state = p?.status;
    let title, detail, actions="";
    if (ended) {title="Ask for a fresh payment link";detail="Ask the organizer to share your payment again.";}
    else if (p?.providerFailure) {
      title="Payment needs organizer review";
      const reasons={not_found:"PayPal could not find this request. Ask the organizer to review the original payment.",connection_changed:"The organizer needs to reconnect the original PayPal app.",order_mismatch:"The provider response did not match your saved payment. Ask the organizer to review it.",unavailable:"The latest PayPal status could not be confirmed."};
      detail=reasons[p.providerFailure.reason]||reasons.unavailable;
      actions=p.orderId?button("reconcile","Check original payment status",true):p.providerFailure.reason==="connection_changed"&&p.retryAllowed!==false?button("order","Retry with original connection",true):"";
    }
    else if (unavailable) {title="Payment status unavailable";detail=providerUnavailable?"The latest PayPal status could not be confirmed.":"Reconnect to check your payment.";actions=button(providerUnavailable?"reconcile":"refresh","Check latest status");}
    else if (packet.totalCents===0&&!p) {title="No payment due";detail="Your share is $0.00.";}
    else if (!p) {title="Waiting for the organizer";detail="Your payment link will appear here.";actions=button("refresh","Check for payment request",true);}
    else if (state==="captured") {title="Payment complete";detail=money(p.amountCents)+" confirmed by PayPal.";}
    else if (p.providerStatus==="VOIDED") {title="This payment request has ended";detail="PayPal has voided this order. Ask the organizer to review it.";}
    else if (["creating","unknown_order","capture_unknown"].includes(state)&&p.retryAllowed===false) {title="This payment needs organizer review";detail="The original request is unresolved. Ask the organizer to review it before another attempt.";actions=p.orderId?button("reconcile","Check original payment status",true):"";}
    else if (!packet.paypalReady) {title="Checkout unavailable";detail="Ask the organizer to reconnect PayPal.";actions=button("refresh","Check connection",true);}
    else if (state==="awaiting_approval") {
      const approved=p.providerStatus==="APPROVED", observed=!!p.providerStatus;
      title=approved?"Finish your payment":"Pay your share";
      detail=approved?"PayPal confirmed your approval. Finish this payment.":observed?"PayPal has not confirmed approval. Continue to PayPal to approve this payment.":approvalOpened?"Check PayPal status after approving your payment.":"";
      const url=approvalUrl();
      const prioritizeFinish=approved||(!observed&&approvalOpened);
      const approve=url?'<a class="'+(prioritizeFinish?'secondary text-action':'primary')+'" id="paypal-approval" href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">'+(prioritizeFinish?'Reopen PayPal ↗':'Continue to PayPal ↗')+'</a>':'';
      if(!url)detail="Ask the organizer for your payment link.";
      actions=prioritizeFinish?button("capture","Finish payment")+approve:approve+(!observed?button("capture","Already approved? Finish payment",true):"");
      actions+=button("reconcile","Check payment status",true);
    } else if (state==="unknown_order" || state==="creating") {title="Resume your payment";detail="Continue the existing payment request.";actions=button("order","Retry existing request")+button("refresh","Refresh status",true);}
    else if (state==="capture_unknown" && checkedUncertain) {title="Complete the approved payment";detail="Your approval is ready. Finish the same payment.";actions=button("capture","Finish payment")+button("reconcile","Check PayPal again",true);}
    else {title="Payment needs a status check";detail="Check PayPal before continuing.";actions=button("reconcile","Check payment");}
    panel.innerHTML='<div class="state-heading"><span class="state-mark" aria-hidden="true">'+(state==="captured"&&!unavailable&&!ended?'✓':'→')+'</span><h2>'+title+'</h2></div>'+(detail?'<p>'+detail+'</p>':'')+
      (unavailable||p?.providerFailure?'<p class="last-known">Last known: '+esc((state||"not requested").replaceAll("_"," "))+'</p>':'')+
      (p?.providerFailure?.checkedAt&&Number.isFinite(Date.parse(p.providerFailure.checkedAt))?'<p class="last-known">Last unsuccessful check <time datetime="'+esc(p.providerFailure.checkedAt)+'">'+esc(new Date(p.providerFailure.checkedAt).toLocaleString())+'</time></p>':'')+
      (p?.providerCheckedAt&&Number.isFinite(Date.parse(p.providerCheckedAt))?'<p class="last-known">PayPal checked <time datetime="'+esc(p.providerCheckedAt)+'">'+esc(new Date(p.providerCheckedAt).toLocaleString())+'</time></p>':'')+
      (p?.captureId?'<dl class="reference"><dt>Sandbox capture reference</dt><dd>'+esc(p.captureId)+'</dd></dl>':'')+
      '<div class="actions">'+actions+'</div>';
    panel.setAttribute("aria-busy",String(busy));
  }
  async function requestCheckout(action){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
    try{
      const response=await fetch(initial.checkoutUrl+"/"+(action==="refresh"?"state":action),action==="refresh"?{cache:"no-store",signal:controller.signal}:{method:"POST",headers:{"content-type":"application/json"},body:"{}",signal:controller.signal});
      let result;try{result=await response.json();}catch(error){if(controller.signal.aborted)throw error;throw Error("The organizer's app did not return a readable payment status.");}
      return {response,result};
    }catch(error){if(controller.signal.aborted)throw Error(action==="refresh"?"The status check timed out. Reconnect and try again.":"The payment response timed out. Check the existing payment before continuing.");throw error;}
    finally{clearTimeout(timer);}
  }
  async function request(action) {
    if(busy||ended)return;
    busy=true;notice.textContent=action==="capture"?"Completing your payment…":action==="reconcile"?"Checking the existing PayPal payment…":action==="order"?"Recovering the existing payment request…":"Checking your latest payment status…";render();
    try {
      const {response,result}=await requestCheckout(action);
      if(!response.ok) {if(response.status===409||response.status===410){ended=response.status===410 || /receipt|fresh|expired|stopped|changed/i.test(result.error||"");}throw Error(result.error||"The payment status could not be checked.");}
      packet=result;checkedUncertain=action==="reconcile"&&packet.payment?.status==="capture_unknown";unavailable=false;providerUnavailable=false;notice.textContent=packet.payment?.status==="captured"?"Payment confirmed.":action==="refresh"?"":action==="reconcile"?"PayPal status checked.":"The saved payment status has been updated.";
    } catch(error) {
      checkedUncertain=false;
      // A failed mutation can have reached PayPal. Read local persisted status; never automatically retry it.
      if(action!=="refresh"&&!ended) {
        try {const read=await requestCheckout("refresh");if(!read.response.ok)throw Error();packet=read.result;unavailable=false;}
        catch {unavailable=true;}
      } else if(!ended) unavailable=true;
      if(action==="reconcile"&&!ended){unavailable=true;providerUnavailable=true;}
      notice.textContent=!ended&&!unavailable&&packet.payment?.status==="capture_unknown"?"Payment outcome is still unknown. Check payment before continuing.":error.message;
    } finally {busy=false;render();}
  }
  panel.addEventListener("click",event=>{if(event.target.closest("#paypal-approval")){approvalOpened=true;setTimeout(render,0);return;}const target=event.target.closest("[data-action]");if(target)void request(target.dataset.action);});
  render();
  // Return query parameters are display hints only; neither loading nor returning captures a payment.
  if(new URLSearchParams(location.search).get("cancel")==="1")notice.textContent="Approval cancelled. You can continue when you’re ready.";
  void request("refresh");
}
export function renderGuestCheckout(packet) {
  const cents=n=>Number.isSafeInteger(n)&&n>=0;
  if(!packet||!Array.isArray(packet.lineItems)||![packet.totalCents,packet.itemsCents,packet.discountCents||0,packet.taxCents,packet.tipCents].every(cents)||packet.lineItems.some(l=>!cents(l.shareCents)||!cents(l.fullCents))||packet.lineItems.reduce((sum,l)=>sum+l.shareCents,0)!==packet.itemsCents||packet.itemsCents-(packet.discountCents||0)+packet.taxCents+packet.tipCents!==packet.totalCents)throw Error("Guest checkout does not reconcile to the saved share");
  if(packet.payment && packet.payment.amountCents!==packet.totalCents)throw Error("Payment amount does not match the saved share");
  if(!/^\/guest\/[a-f0-9]{48}\/checkout$/.test(new URL(packet.checkoutUrl,"http://local").pathname))throw Error("Invalid guest checkout route");
  const e=escapeHtml,m=n=>"$"+(n/100).toFixed(2);
  const rows=packet.lineItems.map(l=>'<tr><td><strong>'+e(l.name)+'</strong><small>'+(l.portionCount?e(l.portionCount)+' of '+e(l.totalPortions)+' portions':l.sharedCount>1?'Shared '+e(l.sharedCount)+' ways':'Your item')+'</small></td><td>'+m(l.shareCents)+'</td></tr>').join("");
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; connect-src \'self\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'; object-src \'none\'"><title>'+e(packet.guestName)+' — '+e(packet.title)+' checkout</title><style>'+
  '*{box-sizing:border-box}body{margin:0;background:#f2f0e9;color:#202d2b;font:16px/1.45 system-ui,-apple-system,sans-serif}main{max-width:960px;margin:40px auto;padding:26px 40px 36px;background:#fffef9;border:1px solid #e1dfd5;border-radius:18px}header{display:flex;justify-content:space-between;align-items:center;gap:12px;padding-bottom:24px;font-size:12px;font-weight:750}header b{color:#ac442f;font-size:15px;letter-spacing:.11em}header span{padding:4px 9px;background:#f0eee5;border-radius:20px;color:#5c655d;font-size:11px;letter-spacing:.02em}h1{font:normal 36px/1.12 Georgia,serif;margin:0 0 8px;letter-spacing:-.03em;overflow-wrap:anywhere}.guest{margin:0 0 24px;color:#647168;font-size:14px}.layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:52px}.amount{padding:0 0 20px;border-bottom:1px solid #dedfd5}.amount small{font-weight:650;color:#647168;font-size:12px;letter-spacing:.06em}.amount strong{display:block;font-size:56px;font-weight:650;letter-spacing:-.06em;line-height:1.2;margin-top:4px}.amount p{display:none}h2{font-size:19px;line-height:1.25;margin:0;font-weight:650;letter-spacing:-.02em}.state-heading{display:flex;gap:9px;align-items:center}.state-mark{font-size:22px;color:#36735a}#payment{padding:22px 0 0}#payment p{font-size:14px;color:#647168;margin:9px 0 15px}.actions{display:grid;gap:4px;margin-top:16px}button,.primary{font:650 15px/1.4 system-ui,sans-serif;padding:13px 14px;border:1px solid #244d3f;background:#244d3f;color:#fff;cursor:pointer;text-align:center;text-decoration:none;width:100%;display:block;border-radius:8px;min-height:48px}.secondary{background:transparent;color:#405b4d;border-color:transparent;font-weight:550;padding:9px 10px;font-size:13px;min-height:40px}.text-action{text-align:center;text-decoration:none}[data-action=refresh].secondary{color:#67786d;font-size:12px;min-height:36px;padding:7px 10px}button:disabled{opacity:.6;cursor:wait}button:hover,.primary:hover{filter:brightness(.94)}button:focus-visible,a:focus-visible{outline:3px solid #b7452e;outline-offset:3px}#notice{font-size:13px;color:#56695c;margin:8px 0 0;overflow-wrap:anywhere}#notice:empty{display:none}.receipt{padding-top:0}.receipt h2{font-size:15px;margin:0 0 12px;color:#647168;font-weight:550}table{width:100%;border-collapse:collapse;font-size:14px}td{padding:14px 0;border-bottom:1px solid #e8e8df;vertical-align:top}td strong{font-weight:600}td:last-child{text-align:right;white-space:nowrap;padding-left:12px;font-variant-numeric:tabular-nums}td small{display:block;font-size:12px;color:#7a837b;margin-top:3px}tfoot td{padding:6px 0;border:0;color:#647168;font-size:13px}tfoot tr:first-child td{padding-top:17px}tfoot tr:last-child td{font-weight:650;color:#202d2b;font-size:15px;border-top:1px solid #dedfd5;padding-top:13px}.reference{font-size:11px;margin:16px 0 0;color:#647168}.reference dd{margin:4px 0 0;font:12px/1.5 ui-monospace,monospace;overflow-wrap:anywhere}@media(max-width:650px){body{background:#fffef9}main{margin:0;border:0;border-radius:0;padding:21px 24px 30px}.layout{display:block}header{padding-bottom:22px}h1{font-size:30px}.guest{margin-bottom:20px}.amount{padding-bottom:15px}.amount strong{font-size:48px}#payment{padding-top:18px}.actions{margin-top:13px}.receipt{padding-top:24px;border-top:1px solid #dedfd5;margin-top:19px}.receipt h2{margin-bottom:2px}td{padding:11px 0}}@media print{.actions,#notice{display:none}body,main{background:white}main{border:0}}'+
  ''+guestIdentityStyles+'</style></head><body><main><header><b>TABLOOM</b><span>Sandbox · USD</span></header><h1>'+e(packet.title)+'</h1><p class="guest">'+e(packet.guestName)+' · receipt '+e(packet.revision)+'</p><div class="layout"><section><div class="amount"><small>YOUR SHARE</small><strong>'+m(packet.totalCents)+'</strong><p>Items '+m(packet.itemsCents)+(packet.discountCents?' · discount −'+m(packet.discountCents):'')+' · tax '+m(packet.taxCents)+' · tip '+m(packet.tipCents)+'</p></div><section id="payment" aria-label="Your Sandbox payment"></section><p id="notice" role="status" aria-live="polite"></p><noscript>Enable JavaScript to check and complete your Sandbox payment. No payment is made by opening this page.</noscript></section><section class="receipt"><h2>Your receipt</h2><table><tbody>'+rows+'</tbody><tfoot><tr><td>Items</td><td>'+m(packet.itemsCents)+'</td></tr>'+(packet.discountCents?'<tr><td>Receipt discount</td><td>−'+m(packet.discountCents)+'</td></tr>':'')+'<tr><td>Sales tax</td><td>'+m(packet.taxCents)+'</td></tr><tr><td>Tip</td><td>'+m(packet.tipCents)+'</td></tr><tr><td>Your total</td><td>'+m(packet.totalCents)+'</td></tr></tfoot></table></section></div></main><script id="checkout-data" type="application/json">'+JSON.stringify(packet).replace(/</g,"\\u003c")+'</script><script>('+checkoutPage.toString()+')();</script></body></html>';
}

/** Recovery page for a real browser return to an unavailable invitation; never a payment assertion. */
export function renderGuestCheckoutUnavailable() {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'; object-src \'none\'"><title>Payment link unavailable — Tabloom</title><style>*{box-sizing:border-box}body{margin:0;background:#f5f3ed;color:#17232d;font:16px/1.6 system-ui,sans-serif}main{max-width:680px;margin:auto;padding:24px 22px 50px}header{display:flex;justify-content:space-between;gap:12px;border-bottom:2px solid #17232d;padding-bottom:14px;font-size:12px;font-weight:800}header b{color:#b7452e}h1{font:36px/1.15 Georgia,serif;margin:35px 0 18px}p{color:#425661}'+guestIdentityStyles+'</style></head><body><main><header><b>TABLOOM</b><span>PAYPAL SANDBOX</span></header><h1>This payment link is no longer current</h1><p>Ask the organizer to reopen the existing dinner and share a fresh guest link for you.</p><p>If you already approved in PayPal, ask them to check that original payment before you continue.</p></main></body></html>';
}
