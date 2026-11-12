import {guestIdentityStyles} from './guest-identity.js';
/** A printable, script-free guest snapshot. No network calls, payment attestations or other guests' personal details. */
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const dollars = cents => "$" + (cents/100).toFixed(2);
const validCents = n => Number.isSafeInteger(n) && n >= 0;
function verifiedSandboxLink(payment) {
  if (payment?.status !== "awaiting_approval" || typeof payment.approvalUrl !== "string") return null;
  try {
    const u = new URL(payment.approvalUrl);
    return u.protocol === "https:" && (u.hostname === "sandbox.paypal.com" || u.hostname === "www.sandbox.paypal.com") && !u.username && !u.password && u.port === "" ? u.toString() : null;
  } catch { return null; }
}
export function renderGuestReceipt(bill, due, payment, exportedAt = new Date()) {
  if (!bill || !due || !Array.isArray(due.lineItems) || !Number.isSafeInteger(bill.revision) || bill.revision < 0 || !validCents(due.discountCents||0) || !validCents(due.totalCents) || !validCents(due.itemsCents) || !validCents(due.taxCents) || !validCents(due.tipCents)) throw Error("Incomplete saved guest receipt");
  if (due.lineItems.some(l => !validCents(l.shareCents) || !validCents(l.fullCents) || !Number.isSafeInteger(l.sharedCount) || l.sharedCount < 1) || due.lineItems.reduce((sum,l)=>sum+l.shareCents,0) !== due.itemsCents || due.itemsCents-(due.discountCents||0)+due.taxCents+due.tipCents !== due.totalCents) throw Error("Guest receipt does not reconcile to the saved amount");
  const rows = due.lineItems.map(line => '<tr><td><strong>'+escapeHtml(line.name)+'</strong><small>'+(line.portionCount ? line.portionCount+" of "+line.totalPortions+" portions · whole item "+dollars(line.fullCents) : line.sharedCount === 1 ? "Individual item" : "Shared "+line.sharedCount+" ways · whole item "+dollars(line.fullCents))+'</small></td><td>'+dollars(line.shareCents)+'</td></tr>').join("");
  const sandbox = verifiedSandboxLink(payment);
  const status = payment?.status === "captured" ? "The organizer's local record says a PayPal Sandbox capture completed. This exported page is not provider confirmation." :
    payment?.status === "capture_unknown" || payment?.status === "pending" ? "A prior Sandbox capture is unresolved. Ask the organizer to reconcile it; do not pay again from this page." :
    payment?.status === "awaiting_approval" ? "A PayPal Sandbox order exists but has not been recorded as captured. Buyer approval alone is not payment." :
    payment?.status ? "The Sandbox request is not ready. Ask the organizer to check the status." :
    due.totalCents===0 ? "Nothing to pay for this saved share." : "This share is saved. Ask your organizer for a personal payment invitation.";
  const action = sandbox ? '<p class="action"><a href="'+escapeHtml(sandbox)+'" rel="noopener noreferrer">Review this order in PayPal Sandbox</a></p><p class="caution">Sandbox test only. PayPal approval does not capture the order; the organizer must verify it later.</p>' : "";
  const issued = exportedAt instanceof Date && !Number.isNaN(exportedAt.valueOf()) ? exportedAt.toISOString().replace("T"," ").replace(/\.\d{3}Z$/," UTC") : "time unavailable";
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'; object-src \'none\'">',
    '<title>Tabloom guest share — '+escapeHtml(due.name)+'</title>',
    '<style>*{box-sizing:border-box}body{margin:0;background:#f5f3ed;color:#17232d;font:16px/1.5 Arial,Helvetica,sans-serif}main{max-width:720px;margin:0 auto;padding:34px 28px 58px}header{display:flex;justify-content:space-between;gap:12px;border-bottom:2px solid #17232d;padding-bottom:15px;font-size:12px;font-weight:900;letter-spacing:1px}header b{color:#e05d41}header span{color:#58666e}h1{font:italic normal 43px/1.05 Georgia,serif;margin:32px 0 8px;overflow-wrap:anywhere}.sub{color:#58666e;margin:0 0 30px}.sum{border-left:5px solid #f36d50;background:#123d58;color:#fff;padding:23px 25px;margin-bottom:28px}.sum small{display:block;letter-spacing:1px;font-size:11px;font-weight:bold}.sum strong{display:block;font-size:56px;letter-spacing:-2px;line-height:1.15}table{width:100%;border-collapse:collapse}th{text-align:left;font-size:11px;letter-spacing:1px;color:#58666e;padding:8px 0;border-bottom:2px solid #17232d}th:last-child,td:last-child{text-align:right}td{vertical-align:top;padding:13px 0;border-bottom:1px solid #d1d6d1}td strong{display:block}td small{display:block;color:#58666e;margin-top:3px}tfoot td{font-weight:700}tfoot tr:last-child td{font-size:21px;border-top:2px solid #17232d}.state{padding:18px 0;margin-top:20px;border-top:2px solid #17232d}.state strong{font-size:13px}.state p{margin:8px 0;color:#425661;font-size:14px}.action a{display:inline-block;background:#123d58;color:white;text-decoration:none;font-weight:700;padding:14px 18px}.state .caution{font-size:12px}footer{border-top:1px solid #c5cac4;margin-top:29px;padding-top:18px;color:#58666e;font-size:12px}@media(max-width:650px){h1{font-size:30px}}@media print{body{background:#fff}main{padding:0}.sum{-webkit-print-color-adjust:exact;print-color-adjust:exact}}'+guestIdentityStyles+'</style>',
    '</head><body><main><header><b>✳ TABLOOM / GUEST COPY</b><span>REV '+bill.revision+' · USD</span></header>',
    '<h1>'+escapeHtml(due.name)+'</h1><p class="sub">'+escapeHtml(bill.title)+' — your itemized share</p>',
    '<div class="sum"><small>YOUR SHARE / USD</small><strong>'+dollars(due.totalCents)+'</strong></div>',
    '<table><thead><tr><th scope="col">What was allocated to you</th><th scope="col">Your portion</th></tr></thead><tbody>'+rows+'</tbody>',
    '<tfoot><tr><td>Items</td><td>'+dollars(due.itemsCents)+'</td></tr>'+(due.discountCents?'<tr><td>Your share of receipt discount</td><td>−'+dollars(due.discountCents)+'</td></tr>':'')+'<tr><td>Sales tax</td><td>'+dollars(due.taxCents)+'</td></tr><tr><td>Tip</td><td>'+dollars(due.tipCents)+'</td></tr><tr><td>Your total</td><td>'+dollars(due.totalCents)+'</td></tr></tfoot></table>',
    '<section class="state"><strong>PAYMENT STATUS / '+escapeHtml((payment?.status || (due.totalCents===0?"no payment due":"not requested")).replaceAll("_"," ").toUpperCase())+' · SANDBOX</strong><p>'+escapeHtml(status)+'</p>'+action+'</section>',
    '<footer>Copy exported '+escapeHtml(issued)+' · Receipt '+bill.revision+'. Check with your organizer for the latest status.</footer>',
    '</main></body></html>'
  ].join("\n");
}
