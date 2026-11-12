import { createReceiptPhotoCrop } from "./receipt-photo-crop.js";
import { parseReceiptText } from "./receipt-intake.js";
import { createReceiptDraftStore, validateReceiptDraft } from "./receipt-draft-store.js";
import { reconcileReceiptAmounts } from "./receipt-reconciliation.js";
/** Fit existing editable name fields without changing their value or focus. */
export function fitTextareas(fields) {
  for (const field of fields) {
    field.style.height = "auto";
    field.style.height = (field.scrollHeight + 2) + "px";
  }
}

const arithmeticIssue = issue => ["subtotal","total"].includes(issue.kind) && Number.isSafeInteger(issue.differenceCents);

const money = cents => "$" + (cents / 100).toFixed(2);
const decimal = cents => (cents / 100).toFixed(2);
const escape = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const cents = value => {
  if (!/^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/.test(value.trim())) throw Error("Use a USD amount with at most 2 decimal places.");
  const [whole, fraction = ""] = value.trim().split(".");
  return Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
};

/** Review a receipt locally; onUse only copies the reviewed result into the draft. */
function createReceiptImportView(dialog, { onUse, getDraftContext, onDraftChange, onRecoveryError }) {
  dialog.innerHTML = '<div class="receipt-import-heading"><h2 id="receipt-import-title">Add a receipt</h2><button id="receipt-photo-jump" type="button" class="text-button" hidden>Photo</button><button id="cancel-receipt-import" type="button" class="text-button">Cancel</button></div>' +
    '<div class="receipt-import-body"><div id="receipt-import-error" class="receipt-import-error" role="alert"></div><section class="receipt-source">' +
    '<div id="receipt-source-start"><button id="choose-receipt-photo" type="button" class="outline">Choose a receipt photo</button><input id="receipt-photo-file" type="file" accept="image/jpeg,image/png,image/webp" hidden><p class="receipt-local-note">Photo reading stays on this device.</p></div>' +
    '<figure id="receipt-photo-source" hidden><div class="receipt-photo-frame"><img id="receipt-photo-image" alt="Your original receipt, for checking the read amounts"></div><figcaption><a id="open-receipt-photo" target="_blank" rel="noopener">Full size ↗</a><button id="receipt-photo-tools-toggle" type="button" class="text-button" aria-expanded="false" aria-controls="receipt-photo-tool-buttons">Photo tools</button><span id="receipt-photo-tool-buttons"><button id="rotate-receipt-photo" type="button" class="text-button">Rotate &amp; read again</button><button id="crop-receipt-photo" type="button" class="text-button">Crop &amp; read again</button><button id="zoom-receipt-photo" type="button" class="text-button" aria-pressed="false">Zoom photo</button><button id="enter-receipt-items" type="button" class="text-button">Enter items yourself</button><button id="change-receipt-photo" type="button" class="text-button">Change photo</button></span></figcaption></figure>' +
    '<details id="receipt-reading-options" open><summary id="receipt-reading-options-summary" hidden>Reading options &amp; original text</summary>' +
    '<div id="receipt-local-reader" hidden><button id="read-receipt-local" type="button" class="outline">Read with local model</button><p id="receipt-local-reader-note" class="receipt-local-note"></p></div>' +
    '<div id="receipt-smaller-copy" hidden><p class="receipt-local-note">This photo is too large for the local reader. You can read a smaller copy of the whole photo; the original stays available for checking every amount.</p><button id="read-receipt-smaller" type="button" class="outline">Read a smaller copy</button></div>' +
    '<div id="receipt-photo-reading" hidden><p id="receipt-photo-status" role="status"></p><progress id="receipt-photo-progress" max="1"></progress><button id="stop-receipt-photo" type="button" class="text-button">Stop reading</button></div>' +
    '<details id="receipt-text-source" open><summary>Paste receipt text</summary><label for="receipt-text">One item and its printed line total per line</label><textarea id="receipt-text" rows="7" maxlength="20000" spellcheck="false" placeholder="Udon 12.00&#10;Dumplings 9.00&#10;Tea 6.00&#10;Tax 2.70&#10;Tip 5.40&#10;Total 35.10"></textarea><button id="preview-receipt" type="button" class="outline">Review items</button></details></details>' +
    '</section><section id="receipt-review" class="receipt-review" hidden aria-label="Review receipt amounts"><p class="receipt-review-intro">Check each item against your receipt. You can correct amounts here.</p>' +
    '<div id="receipt-review-items"></div><button id="add-receipt-review-item" type="button" class="text-button">+ Add a missing item</button>' +
    '<div class="receipt-review-charges"><label>Receipt discount<input id="receipt-review-discount" inputmode="decimal"></label><label>Tax<input id="receipt-review-tax" inputmode="decimal"></label><label>Tip<input id="receipt-review-tip" inputmode="decimal"></label></div>' +
    '<button id="receipt-no-discount-tip" type="button" class="outline" hidden>No discount or tip</button>' +
    '<div class="receipt-printed-totals"><label id="receipt-printed-subtotal-label">Printed subtotal<input id="receipt-review-printed-subtotal" inputmode="decimal"></label><label>Printed total<input id="receipt-review-printed" inputmode="decimal" placeholder="Not printed"></label></div><label id="receipt-tip-basis-label" class="receipt-tip-basis" hidden><input id="receipt-tip-before-total" type="checkbox">Printed total is before this tip</label><div id="receipt-excluded-lines"></div><label id="receipt-model-confirmation" class="receipt-model-confirmation" hidden><input id="confirm-receipt-model" type="checkbox">I checked every item and amount against the photo (including missing or $0). Use USD.</label></section>' +
    '<div id="receipt-correction-status" class="receipt-correction-status" role="status" hidden></div></div>' +
    '<div id="receipt-import-footer" class="receipt-import-footer" hidden><div class="receipt-review-total"><span id="receipt-preview-total-label">Calculated total</span><strong id="receipt-preview-total">—</strong><small id="receipt-reconciliation" aria-live="polite"></small><button id="undo-receipt-item-removal" type="button" class="text-button" hidden>Undo item removal</button></div>' +
    '<label id="receipt-import-mode-label">Use these items to<select id="receipt-import-mode"><option value="replace">Replace current receipt</option><option value="append">Add to current receipt</option></select></label>' +
    '<button id="use-receipt" type="button" class="primary">Use receipt</button><p>Choose people after importing. Save when the split is ready.</p></div>';
  dialog.setAttribute("aria-labelledby", "receipt-import-title");
  const $ = id => dialog.querySelector("#" + id);
  let parsed = null, sourceText = "", itemCount = 0, photo = null, photoUrl = null, rotation = 0, readRequest = null;
  let previouslyFocused = null, manualEntry = false, modelReview = false, readerSettings = null, settingsGeneration = 0;
  let excludedSourceLines = [], correctionUndo = null, removedReviewItem = null, importRequest = null;
  let lastReceiptFocus = null, photoReturn = null;

  const draftStore = createReceiptDraftStore();
  const draftRecovery = document.createElement("section");
  draftRecovery.id = "receipt-draft-recovery"; draftRecovery.hidden = true;
  draftRecovery.innerHTML = '<p id="receipt-draft-recovery-text"></p><button id="resume-receipt-draft" type="button" class="primary">Resume correction</button><button id="discard-saved-receipt-draft" type="button" class="text-button">Discard saved correction</button>';
  const draftStatus = document.createElement("p");
  draftStatus.id = "receipt-draft-status"; draftStatus.className = "receipt-local-note"; draftStatus.hidden = true;
  dialog.querySelector(".receipt-import-heading").after(draftRecovery,draftStatus);
  let draftContext=null,draftRevision=null,draftPhotoId=null,draftPhoto=null,draftEpoch=0;
  let draftReady=false,pendingDraft=null,draftQueue=Promise.resolve(),lastDraftJSON="",draftFailed=false;
  const lockDraftBody = locked => {
    dialog.querySelector(".receipt-import-body").inert=locked;
    $("receipt-import-footer").inert=locked;
    dialog.setAttribute("aria-busy",String(locked && !pendingDraft));
    dialog.classList.toggle("receipt-draft-pending",locked);
  };
  function draftSnapshot() {
    return {
      version:1, sourceText, text:$("receipt-text").value, parsed:Boolean(parsed),
      printedTotalBeforeTip:$("receipt-tip-before-total").checked,
      manual:manualEntry,model:modelReview,visible:!$("receipt-review").hidden,
      rows:[...$("receipt-review-items").children].map(row=>({name:row.querySelector(".receipt-review-name").value,price:row.querySelector(".receipt-review-price").value})),
      amounts:Object.fromEntries(["discount","tax","tip","printed","printed-subtotal"].map(field=>[field,$("receipt-review-"+field).value])),
      excluded:[...excludedSourceLines],remainingText:(()=>{const box=$("receipt-excluded-lines"),lines=[...box.querySelectorAll("li")];return lines.length?[box.querySelector("summary")?.textContent,box.querySelector("p")?.textContent,...lines.map(line=>line.textContent)].filter(Boolean).join("\n"):box.textContent;})(),
      inline:[...$("receipt-import-error").querySelectorAll("[data-edit-source-line]")].map(input=>({index:Number(input.dataset.editSourceLine),value:input.value,open:input.closest("details").open})),
      rotation,mode:$("receipt-import-mode").value,sourceOpen:$("receipt-text-source").open,optionsOpen:$("receipt-reading-options").open,optionsSummary:!$("receipt-reading-options-summary").hidden
    };
  }
  function keepDraft() {
    if (!dialog.open || !draftReady || pendingDraft || draftFailed || importRequest) return;
    let snapshot;
    try { snapshot=draftSnapshot();validateReceiptDraft(snapshot); } catch(problem) { draftStatus.hidden=false;draftStatus.textContent=problem.message+" Keep this page open.";return; }
    if (!photo && !snapshot.text.trim() && !snapshot.rows.some(row=>row.name||row.price)) return;
    if (photo!==draftPhoto) { draftPhoto=photo;draftPhotoId=photo?crypto.randomUUID():null; }
    const encoded=JSON.stringify(snapshot)+draftPhotoId;
    if (encoded===lastDraftJSON) return;
    lastDraftJSON=encoded;
    const context=draftContext,epoch=draftEpoch,originalPhoto=photo,photoId=draftPhotoId;
    draftStatus.hidden=false;draftStatus.textContent="Keeping correction on this device…";
    draftQueue=draftQueue.then(async()=>{
      if (draftFailed) return;
      draftRevision=await draftStore.write(context,snapshot,originalPhoto,photoId,draftRevision);onDraftChange(true);
      if (epoch===draftEpoch && encoded===lastDraftJSON) draftStatus.textContent="Correction kept on this device.";
    }).catch(problem=>{
      if(epoch===draftEpoch){draftFailed=true;draftStatus.hidden=false;draftStatus.textContent=problem.message+" Keep this page open; your latest edits are still here.";}
    });
  }
  async function forgetDraft() {
    draftReady=false;
    await draftQueue;
    if (draftFailed) throw Error("The correction changed or could not be kept. Reopen it before discarding its saved copy.");
    await draftStore.remove(draftContext,draftRevision);
    draftRevision=null;pendingDraft=null;lastDraftJSON="";draftRecovery.hidden=true;draftStatus.hidden=true;onDraftChange(false);
  }
  function restoreDraft(record) {
    const state=validateReceiptDraft(record.snapshot);
    clearPhoto();clearCorrectionUndo();resetPhotoNavigation();
    photo=record.photo;draftPhoto=photo;draftPhotoId=record.photoId;
    if(photo){
      photoUrl=URL.createObjectURL(photo);$("receipt-photo-image").src=photoUrl;$("open-receipt-photo").href=photoUrl;
      $("receipt-photo-source").hidden=false;$("receipt-source-start").hidden=true;dialog.classList.add("has-receipt-photo");
      $("receipt-local-reader").hidden=!readerSettings?.configured;
    }
    rotation=state.rotation;$("receipt-photo-image").style.transform="rotate("+rotation+"deg)";
    excludedSourceLines=[...state.excluded];$("receipt-text").value=state.sourceText;
    if(state.parsed)preview();else invalidateReview();
    if(state.manual){manualEntry=false;enterItems();}
    sourceText=state.sourceText;$("receipt-text").value=state.text;
    manualEntry=state.manual;modelReview=Boolean(photo)||state.model;
    dialog.classList.toggle("manual-receipt-entry",manualEntry);
    $("rotate-receipt-photo").textContent=manualEntry?"Rotate photo":"Rotate & read again";
    if(state.manual && state.remainingText){$("receipt-excluded-lines").textContent=state.remainingText;$("receipt-excluded-lines").style.whiteSpace="pre-line";}
    if(state.visible){
      parsed ||= {items:[],issues:[],ignored:[]};
      $("receipt-review-items").innerHTML=state.rows.map(itemRow).join("");
      for(const [field,value]of Object.entries(state.amounts))$("receipt-review-"+field).value=value;
      $("receipt-review").hidden=false;$("receipt-import-footer").hidden=false;
      $("receipt-printed-subtotal-label").hidden=false;
      $("receipt-model-confirmation").hidden=!modelReview;
      $("receipt-import-title").textContent="Check the receipt";
    }
    $("confirm-receipt-model").checked=false;
    $("receipt-tip-before-total").checked=state.printedTotalBeforeTip===true;
    $("receipt-import-mode").value=state.mode;
    $("receipt-text-source").open=state.sourceOpen;$("receipt-reading-options").open=state.optionsOpen;
    $("receipt-reading-options-summary").hidden=!(state.optionsSummary ?? !state.optionsOpen);
    for(const edit of state.inline){
      const input=$("receipt-import-error").querySelector('[data-edit-source-line="'+edit.index+'"]');
      if(input){input.value=edit.value;input.closest("details").open=Boolean(edit.open)||input.closest("details").classList.contains("receipt-direct-edit");}
    }
    pendingDraft=null;draftRecovery.hidden=true;draftReady=true;lockDraftBody(false);
    refreshTotal();lastDraftJSON="";keepDraft();
    (receiptTargetFallback()||$("receipt-text")).focus();
  }
  $("resume-receipt-draft").addEventListener("click",()=>{
    if(!pendingDraft)return;
    try{restoreDraft(pendingDraft);}catch(problem){draftStatus.hidden=false;draftStatus.textContent=problem.message;}
  });
  $("discard-saved-receipt-draft").addEventListener("click",async()=>{
    try{await forgetDraft();draftReady=true;lockDraftBody(false);$("receipt-import-title").textContent="Add a receipt";$("choose-receipt-photo").focus();}
    catch(problem){draftStatus.hidden=false;draftStatus.textContent=problem.message;}
  });
  for(const event of ["input","change","click","toggle"])dialog.addEventListener(event,()=>queueMicrotask(keepDraft));
  const draftObserver=new MutationObserver(()=>keepDraft());
  draftObserver.observe(dialog.querySelector(".receipt-import-body"),{childList:true,subtree:true,attributes:true,attributeFilter:["hidden","open","src"]});

  function resetPhotoNavigation() {
    lastReceiptFocus = null; photoReturn = null;
    $("receipt-photo-jump").hidden = true;
    dialog.classList.remove("comparing-receipt-photo");
    $("receipt-photo-jump").textContent = "Photo";
    $("receipt-photo-jump").setAttribute("aria-label", "Check the original receipt photo");
  }
  function refreshPhotoNavigation() {
    $("receipt-photo-jump").hidden = !photo || !parsed || ($("receipt-review").hidden && !$("receipt-import-error").textContent.trim());
  }
  function currentReceiptTarget(target) {
    return target?.isConnected && dialog.contains(target) && target.checkVisibility()
      && (target.closest("#receipt-review") || target.closest("#receipt-import-error"));
  }
  function receiptTargetFallback() {
    if (!$("receipt-review").hidden) return $("receipt-review-items").querySelector(".receipt-review-name") || $("add-receipt-review-item");
    const target = [...$("receipt-import-error").querySelectorAll("input,button,summary")].find(node => node.checkVisibility());
    if (target) return target;
    $("receipt-import-error").tabIndex = -1;
    return $("receipt-import-error");
  }
  dialog.addEventListener("focusin", event => {
    if (event.target.matches("input,textarea,button,summary") && currentReceiptTarget(event.target)) lastReceiptFocus = event.target;
  });
  $("receipt-photo-jump").addEventListener("click", () => {
    if ($("receipt-photo-jump").hidden) return;
    if (photoReturn) {
      const remembered = photoReturn;
      const target = remembered.photo === photo && currentReceiptTarget(remembered.input)
        ? remembered.input : receiptTargetFallback();
      photoReturn = null;
      dialog.classList.remove("comparing-receipt-photo");
      $("receipt-photo-jump").textContent = "Photo";
      $("receipt-photo-jump").setAttribute("aria-label", "Check the original receipt photo");
      target.focus({ preventScroll: true });
      if (target === remembered.input && remembered.start !== null) {
        try { target.setSelectionRange(remembered.start, remembered.end); } catch {}
      }
      target.scrollIntoView({ block: "center", behavior: "instant" });
      return;
    }
    const input = currentReceiptTarget(lastReceiptFocus)
      ? lastReceiptFocus : receiptTargetFallback();
    photoReturn = { photo, input, start: input?.selectionStart ?? null, end: input?.selectionEnd ?? null };
    dialog.classList.add("comparing-receipt-photo");
    $("receipt-photo-jump").textContent = "Back";
    $("receipt-photo-jump").setAttribute("aria-label", "Return to the receipt field you were checking");
    const frame = $("receipt-photo-source").querySelector(".receipt-photo-frame");
    frame.tabIndex = -1;
    frame.focus({ preventScroll: true });
    frame.scrollIntoView({ block: "start", behavior: "instant" });
  });
  function showReadingOptionsSummary(show) {
    $("receipt-reading-options").open = !show;
    $("receipt-reading-options-summary").hidden = !show;
  }
  $("receipt-photo-tools-toggle").addEventListener("click", () => {
    const toggle = $("receipt-photo-tools-toggle");
    const expanded = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", String(expanded));
    $("receipt-photo-tool-buttons").classList.toggle("expanded", expanded);
  });
  const stopReading = () => { readRequest?.abort(); readRequest = null; $("receipt-photo-reading").hidden = true; $("receipt-smaller-copy").hidden = true; $("read-receipt-local").hidden = false; };
  const cropPhoto = createReceiptPhotoCrop({dialog,figure:$("receipt-photo-source"),onRead(original,bounds){if(photo===original)readPhoto(photo,true,bounds);}});
  async function openCrop() {if(!photo)return;stopReading();try{await cropPhoto.open(photo,rotation);}catch(problem){error(problem.message||"The photo could not be opened for cropping.");}}
  $("crop-receipt-photo").addEventListener("click",openCrop);
  const clearPhoto = () => {
    cropPhoto.close();
    resetPhotoNavigation(); $("receipt-photo-jump").hidden = true;
    importRequest?.abort(); importRequest=null;
    stopReading(); showReadingOptionsSummary(false);
    $("receipt-photo-source").classList.remove("receipt-photo-zoomed"); $("zoom-receipt-photo").textContent = "Zoom photo"; $("zoom-receipt-photo").setAttribute("aria-pressed", "false");
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    photoUrl = null; photo = null; rotation = 0; $("receipt-local-reader").hidden = true;
    $("receipt-photo-image").removeAttribute("src");
    $("open-receipt-photo").removeAttribute("href");
    $("receipt-photo-source").hidden = true; dialog.classList.remove("has-receipt-photo");
    $("receipt-source-start").hidden = false;
  };
  const error = message => { $("receipt-import-error").textContent = message; refreshPhotoNavigation(); if(message)requestAnimationFrame(()=>$("receipt-import-error").scrollIntoView({block:"nearest"})); };
  function readingProblem(message) {
    if(!$("receipt-import-error").querySelector("[data-edit-source-line]")) {error(message);return;}
    let notice=$("receipt-import-error").querySelector("[data-reading-notice]");
    if(!notice){notice=document.createElement("p");notice.dataset.readingNotice="";notice.setAttribute("role","status");$("receipt-import-error").prepend(notice);}
    notice.textContent=message;
  }
  function clearCorrectionUndo() {
    correctionUndo = null; removedReviewItem = null;
    $("undo-receipt-item-removal").hidden = true;
    $("receipt-correction-status").hidden = true;
    $("receipt-correction-status").replaceChildren();
  }
  function showIssues(issues) {
    const noReadItems = Boolean(photo && parsed && !parsed.items.length);
    const currencyGuidance = photo && issues.some(issue => issue.message === "Use a USD receipt.") ? '<p class="receipt-currency-guidance">Check the read currency against the photo. Enter USD amounts.</p>' : "";
    $("receipt-import-error").innerHTML = (noReadItems ? '<h3>No item prices were read</h3><p>Try selecting the receipt area, or enter the items and printed totals yourself.</p><button type="button" class="primary" data-crop-receipt-photo>Crop &amp; read again</button><button type="button" class="outline" data-enter-receipt-items>Enter items yourself</button>' : '<h3>Check these lines</h3>') + currencyGuidance + issues.filter(issue => !noReadItems || issue.text).map(issue => {
      const suggestion = issue.suggestion, index = parsed.issues.indexOf(issue);
      const action = suggestion && ["exclude", "replace"].includes(suggestion.action) ? '<button type="button" class="outline" data-repair-issue="' + index + '" data-repair-action="' + escape(suggestion.action) + '">' + escape(suggestion.label) + '</button>' : "";
      const direct = !suggestion;
      const edit = typeof issue.text === "string" && Number.isInteger(issue.line) && issue.line > 0 ? '<details class="receipt-inline-edit' + (direct ? ' receipt-direct-edit" open' : '"') + '><summary>Edit this line</summary><label>Line ' + issue.line + '<input data-edit-source-line="' + index + '" aria-label="Edit receipt source line ' + issue.line + '" value="' + escape(issue.text) + '" maxlength="500"></label><button type="button" class="outline" data-apply-source-line="' + index + '">Apply line edit</button></details>' : "";
      const sourceLines = [suggestion?.context, ...(direct && edit ? [] : [issue])].filter(line => line && typeof line.text === "string");
      return '<div class="receipt-line-issue">' + sourceLines.map(line => '<p class="receipt-read-line"><span>Line ' + line.line + '</span> ' + escape(line.text) + '</p>').join("") + (photo && issue.message === "Use a USD receipt." ? "" : '<p>' + escape(issue.message) + '</p>') + action + edit + '</div>';
    }).join("");
    refreshPhotoNavigation();
    requestAnimationFrame(() => $("receipt-import-error").scrollIntoView({ block: "nearest" }));
  }
  function captureSourceEditors() {
    return [...$("receipt-import-error").querySelectorAll("[data-edit-source-line]")].map(input => {
      const issue = parsed?.issues[Number(input.dataset.editSourceLine)];
      return issue ? { line: issue.line, text: issue.text, value: input.value, open: input.closest("details").open } : null;
    }).filter(Boolean);
  }
  function restoreSourceEditors(edits) {
    for (const edit of edits) {
      const index = parsed?.issues.findIndex(issue => issue.line === edit.line && issue.text === edit.text);
      if (index === undefined || index < 0) continue;
      const input = $("receipt-import-error").querySelector('[data-edit-source-line="' + index + '"]');
      if (!input) continue;
      input.value = edit.value;
      input.closest("details").open = edit.open || input.closest("details").classList.contains("receipt-direct-edit");
    }
  }
  function invalidateReview() {
    $("receipt-tip-before-total").checked=false;
    resetPhotoNavigation(); $("receipt-photo-jump").hidden = true;
    manualEntry = false; modelReview = false; showReadingOptionsSummary(false); $("receipt-model-confirmation").hidden = true; $("confirm-receipt-model").checked = false; dialog.classList.remove("manual-receipt-entry");
    $("rotate-receipt-photo").textContent = "Rotate & read again";
    parsed = null; $("receipt-review").hidden = true; $("receipt-import-footer").hidden = true;
    if(!photo)$("receipt-source-start").hidden=false;
    $("receipt-import-title").textContent = "Add a receipt";
  }
  function itemRow(item, index) {
    return '<div class="receipt-review-item"><span class="receipt-review-number" aria-hidden="true">' + (index + 1) + '</span><textarea class="receipt-review-name" rows="1" placeholder="Item name" aria-label="Receipt item ' + (index + 1) + ' name" maxlength="96">' + escape(item.name) + '</textarea><input class="receipt-review-price" placeholder="0.00" aria-label="Line total for receipt item ' + (index + 1) + ' in USD" inputmode="decimal" value="' + escape(item.price ?? decimal(item.cents)) + '"><button type="button" class="text-button" data-remove-receipt-item aria-label="Remove receipt item ' + (index + 1) + '">×</button></div>';
  }
  function reviewAmount(input, label, allowNoCharge = false) {
    try { return cents(input.value); }
    catch {
      const missing = !input.value.trim();
      const message = missing
        ? "Enter " + label.toLowerCase() + (allowNoCharge ? ", or 0.00 if none applies." : ".")
        : "Check " + label.toLowerCase() + ": use an amount with at most 2 decimal places.";
      const problem = new Error(message);
      problem.receiptInput = input;
      throw problem;
    }
  }
  function reviewedReceipt(requireConfirmation = true) {
    if (!parsed || (!manualEntry && parsed.issues.some(issue => !arithmeticIssue(issue))) || sourceText !== $("receipt-text").value) throw Error("Review the changed receipt text before importing.");
    const items = [...$("receipt-review-items").children].map((row, index) => {
      const name = row.querySelector(".receipt-review-name").value.trim();
      const amount = reviewAmount(row.querySelector(".receipt-review-price"), "Item " + (index + 1) + " line total");
      if (!name || name.length > 96 || !amount || amount > 10000000) throw Error("Each item needs a name and a positive line total within the receipt limit.");
      return { name, cents: amount };
    });
    if (!items.length || items.length > 60) throw Error("Keep between 1 and 60 receipt items.");
    const receipt = { items, discountCents: reviewAmount($("receipt-review-discount"), "Discount", true), taxCents: reviewAmount($("receipt-review-tax"), "Tax", true), tipCents: reviewAmount($("receipt-review-tip"), "Tip", true) };
    const printed = $("receipt-review-printed").value.trim(), printedSubtotal = $("receipt-review-printed-subtotal").value.trim();
    receipt.printedTotalCents = printed ? reviewAmount($("receipt-review-printed"), "Printed total") : null;
    receipt.printedSubtotalCents = printedSubtotal ? reviewAmount($("receipt-review-printed-subtotal"), "Printed subtotal") : null;
    receipt.printedTotalBeforeTip = $("receipt-tip-before-total").checked;
    const reconciliation = reconcileReceiptAmounts(receipt);
    if (reconciliation.status === "invalid") throw Error(reconciliation.issues[0]?.message || "Check the receipt amounts.");
    if (reconciliation.totalCents > 10000000 || [receipt.discountCents, receipt.taxCents, receipt.tipCents].some(value => value > 10000000)) throw Error("The receipt exceeds the $100,000 limit.");
    if (requireConfirmation && modelReview && !$("confirm-receipt-model").checked) throw Error("Check every amount against the photo and choose USD before using this reading.");
    return { ...receipt, reconciliation, subtotalCents: reconciliation.subtotalCents, totalCents: reconciliation.totalCents };
  }
  function sizeReviewNames() {
    if (dialog.open && !$("receipt-review").hidden) fitTextareas($("receipt-review-items").querySelectorAll(".receipt-review-name"));
  }
  window.addEventListener("resize", sizeReviewNames);
  function refreshTotal() {
    refreshPhotoNavigation();
    sizeReviewNames();
    const tipText=$("receipt-review-tip").value.trim(), printedText=$("receipt-review-printed").value.trim();
    $("receipt-tip-basis-label").hidden=$("receipt-review").hidden || !printedText || !/^\d+(?:\.\d{1,2})?$/.test(tipText) || Number(tipText)<=0;
    if (!printedText || tipText==="" || Number(tipText)===0) $("receipt-tip-before-total").checked=false;
    $("receipt-no-discount-tip").hidden = !modelReview || $("receipt-review").hidden || $("receipt-review-discount").value.trim() !== "" || $("receipt-review-tip").value.trim() !== "";
    $("receipt-review").querySelectorAll("[aria-invalid]").forEach(input => input.removeAttribute("aria-invalid"));
    $("use-receipt").disabled = true;
    try {
      const result = reviewedReceipt(false), comparison = result.reconciliation;
      const awaitingConfirmation = modelReview && !$("confirm-receipt-model").checked;
      $("receipt-preview-total-label").textContent = result.printedTotalBeforeTip ? "Total with tip" : comparison.status === "matched" ? "Receipt total" : "Calculated total";
      $("receipt-preview-total").textContent = money(result.totalCents);
      const difference = comparison.comparisons.find(row => row.differenceCents);
      $("receipt-reconciliation").textContent = difference ? money(Math.abs(difference.differenceCents)) + (difference.differenceCents > 0 ? " over" : " short of") + " the printed " + difference.kind : comparison.status === "matched" ? "Matches the printed " + (result.printedTotalCents !== null ? "total" : "subtotal") : "No printed total entered — check the amounts.";
      if (!difference && comparison.status === "matched" && result.printedTotalBeforeTip) $("receipt-reconciliation").textContent = money(result.printedTotalCents) + " printed + " + money(result.tipCents) + " tip";
      $("receipt-reconciliation").classList.toggle("mismatch", comparison.status === "mismatch");
      if (awaitingConfirmation && comparison.status !== "mismatch") $("receipt-reconciliation").textContent = comparison.status === "matched" ? $("receipt-reconciliation").textContent + ". Review the photo." : "No printed total — review the photo.";
      $("use-receipt").disabled = comparison.status === "mismatch" || awaitingConfirmation;
      $("use-receipt").textContent = "Use " + result.items.length + (result.items.length === 1 ? " item" : " items");
      return result;
    } catch (problem) {
      $("receipt-preview-total-label").textContent = "Calculated total";
      $("receipt-preview-total").textContent = "—";
      $("receipt-reconciliation").textContent = problem.message;
      if (problem.receiptInput) {
        problem.receiptInput.setAttribute("aria-invalid", "true");
        const action = document.createElement("button");
        action.type = "button"; action.id = "receipt-review-fix"; action.className = "text-button receipt-review-fix";
        action.textContent = problem.message;
        action.addEventListener("click", () => problem.receiptInput.focus());
        $("receipt-reconciliation").replaceChildren(action);
      }
      $("receipt-reconciliation").classList.add("mismatch");
    }
  }
  function preview() {
    $("receipt-tip-before-total").checked=false;
    resetPhotoNavigation();
    manualEntry = false; modelReview = Boolean(photo); showReadingOptionsSummary(false); $("receipt-model-confirmation").hidden = !photo; $("confirm-receipt-model").checked = false; dialog.classList.remove("manual-receipt-entry");
    $("rotate-receipt-photo").textContent = "Rotate & read again";
    stopReading(); error("");
    sourceText = $("receipt-text").value;
    try { parsed = parseReceiptText(sourceText); }
    catch (problem) { invalidateReview(); $("receipt-text-source").open = true; error(problem.message); return; }
    $("receipt-import-title").textContent = "Check the receipt";
    $("receipt-review").querySelector(".receipt-review-intro").textContent = photo ? "Check every item against the photo and add anything missing. Enter 0.00 only when no charge applies." : "Check each item against your receipt. You can correct amounts here.";
    $("receipt-text-source").querySelector("summary").textContent = "Edit receipt text";
    $("receipt-source-start").hidden = Boolean(photo || sourceText.trim());
    const blockingIssues = parsed.issues.filter(issue => !arithmeticIssue(issue));
    if (blockingIssues.length) {
      $("receipt-review").hidden = true; $("receipt-import-footer").hidden = true;
      $("receipt-text-source").open = (!photo || Boolean(sourceText.trim())) && blockingIssues.some(issue => !issue.suggestion);
      showIssues(blockingIssues);
      return;
    }
    $("receipt-review-items").innerHTML = parsed.items.map(itemRow).join("");
    for (const field of ["discount", "tax", "tip"]) $("receipt-review-" + field).value = photo && !parsed.printedCharges?.[field] && !parsed[field + "Cents"] ? "" : decimal(parsed[field + "Cents"] || 0);
    $("receipt-review-printed").value = parsed.printedTotalCents == null ? "" : decimal(parsed.printedTotalCents);
    $("receipt-review-printed-subtotal").value = parsed.printedSubtotalCents == null ? "" : decimal(parsed.printedSubtotalCents);
    $("receipt-printed-subtotal-label").hidden = parsed.printedSubtotalCents == null;
    const excluded = [...parsed.ignored.map(line => typeof line === "string" ? line : line.text), ...excludedSourceLines.map(line => "Excluded by you: " + line)];
    $("receipt-excluded-lines").innerHTML = excluded.length ? '<details' + (photo ? ' open' : '') + '><summary>' + excluded.length + (excluded.length === 1 ? ' other line' : ' other lines') + ' — check excluded text</summary><ul>' + excluded.map(line => '<li>' + escape(line) + '</li>').join("") + '</ul></details>' : "";
    $("receipt-review").hidden = false; $("receipt-import-footer").hidden = false; $("receipt-text-source").open = false;
    $("receipt-source-start").hidden = true;
    $("receipt-text-source").querySelector("summary").textContent = "Edit receipt text";
    $("receipt-import-title").textContent = "Check the receipt";
    $("receipt-import-mode-label").hidden = itemCount === 0;
    $("receipt-import-mode").querySelector('[value="replace"]').textContent = "Replace current " + itemCount + (itemCount === 1 ? " item" : " items");
    $("receipt-import-mode").querySelector('[value="append"]').textContent = "Add to current " + itemCount + (itemCount === 1 ? " item" : " items");
    refreshTotal();
    $("receipt-review").scrollIntoView({ block: "nearest" });
  }
  function enterItems() {
    if (manualEntry) { ($("receipt-review-items").querySelector(".receipt-review-name") || $("add-receipt-review-item")).focus(); return; }
    resetPhotoNavigation();
    const recovered = photo && parsed?.items.length && sourceText === $("receipt-text").value ? parsed : null;
    const reviewed = recovered && !$("receipt-review").hidden ? {
      items: [...$("receipt-review-items").children].map(row => ({ name: row.querySelector(".receipt-review-name").value, price: row.querySelector(".receipt-review-price").value })),
      amounts: Object.fromEntries(["discount", "tax", "tip", "printed", "printed-subtotal"].map(field => [field, $("receipt-review-" + field).value]))
    } : null;
    if (!reviewed) $("receipt-tip-before-total").checked=false;
    stopReading(); clearCorrectionUndo(); error("");
    manualEntry = true; modelReview = Boolean(recovered); showReadingOptionsSummary(false); $("receipt-model-confirmation").hidden = !recovered; $("confirm-receipt-model").checked = false; dialog.classList.add("manual-receipt-entry");
    $("rotate-receipt-photo").textContent = "Rotate photo";
    sourceText = $("receipt-text").value;
    parsed = recovered || { items: [], issues: [], ignored: [] };
    $("receipt-import-title").textContent = recovered ? "Correct receipt items" : "Enter receipt items";
    $("receipt-review").querySelector(".receipt-review-intro").textContent = recovered ? "Keep what was read. Check every row against the photo and add anything missing." : "Copy each item and its line total from the photo.";
    $("receipt-review-items").innerHTML = recovered ? (reviewed?.items || recovered.items).map(itemRow).join("") : itemRow({ name: "", price: "" }, 0);
    for (const field of ["discount", "tax", "tip"]) {
      const edited = reviewed?.amounts[field];
      $("receipt-review-" + field).value = edited !== undefined ? edited : recovered ? (recovered.printedCharges?.[field] || recovered[field + "Cents"] ? decimal(recovered[field + "Cents"] || 0) : "") : "0.00";
    }
    $("receipt-review-printed").value = reviewed ? reviewed.amounts.printed : recovered?.printedTotalCents == null ? "" : decimal(recovered.printedTotalCents);
    $("receipt-review-printed-subtotal").value = reviewed ? reviewed.amounts["printed-subtotal"] : recovered?.printedSubtotalCents == null ? "" : decimal(recovered.printedSubtotalCents);
    $("receipt-printed-subtotal-label").hidden = false;
    const unresolved = recovered ? [...recovered.issues.filter(issue => !arithmeticIssue(issue)).map(issue => issue.text || issue.message), ...recovered.ignored.map(line => typeof line === "string" ? line : line.text), ...excludedSourceLines.map(line => "Excluded by you: " + line)].filter(Boolean) : [];
    $("receipt-excluded-lines").innerHTML = unresolved.length ? '<details open><summary>Check the remaining read text</summary><p>These lines were not copied into the items. Add missing dishes and charges from the photo.</p><ul>' + unresolved.map(line => '<li>' + escape(line) + '</li>').join("") + '</ul></details>' : "";
    $("receipt-text-source").open = false;
    $("receipt-text-source").querySelector("summary").textContent = "Original read text";
    $("receipt-review").hidden = false; $("receipt-import-footer").hidden = false;
    $("receipt-import-mode-label").hidden = itemCount === 0;
    $("receipt-import-mode").querySelector('[value="replace"]').textContent = "Replace current " + itemCount + (itemCount === 1 ? " item" : " items");
    $("receipt-import-mode").querySelector('[value="append"]').textContent = "Add to current " + itemCount + (itemCount === 1 ? " item" : " items");
    refreshTotal();
    ($("receipt-review-items").querySelector(".receipt-review-name") || $("add-receipt-review-item")).focus();
  }
  async function readPhoto(file, rotate = false, crop = null) {
    cropPhoto.close();
    stopReading(); if(!rotate)error("");
    if (!rotate) {
      clearCorrectionUndo(); excludedSourceLines = [];
      sourceText = ""; $("receipt-text").value = "";
      invalidateReview();
      clearPhoto(); photo = file; photoUrl = URL.createObjectURL(file);
      $("receipt-photo-image").src = photoUrl;
      $("open-receipt-photo").href = photoUrl;
    }
    $("receipt-local-reader").hidden = !readerSettings?.configured;
    $("receipt-photo-image").style.transform = "rotate(" + rotation + "deg)";
    $("receipt-photo-source").hidden = false; $("receipt-source-start").hidden = true; dialog.classList.add("has-receipt-photo");
    $("receipt-text-source").open = false;
    const request = new AbortController(); readRequest = request;
    $("receipt-photo-reading").hidden = false; $("receipt-photo-status").textContent = "Reading your receipt…";
    $("receipt-photo-progress").removeAttribute("value");
    try {
      const { readReceiptPhoto } = await import("./receipt-ocr.js");
      if (request.signal.aborted) return;
      const result = await readReceiptPhoto(file, { signal: request.signal, rotation, crop, onProgress: (fraction, status) => {
        if (readRequest !== request || request.signal.aborted) return;
        const progress = typeof fraction === "number" ? fraction : fraction?.fraction;
        const label = typeof status === "string" ? status : fraction?.status;
        if (Number.isFinite(progress)) $("receipt-photo-progress").value = Math.min(1, Math.max(0, progress));
        $("receipt-photo-status").textContent = label === "reading" ? "Reading item names and prices…" : label === "opening" ? "Opening your photo…" : "Preparing the receipt reader…";
      } });
      if (readRequest !== request || request.signal.aborted || !dialog.open) return;
      clearCorrectionUndo(); excludedSourceLines = [];
      $("receipt-text").value = result.text; readRequest = null; $("receipt-photo-reading").hidden = true;
      preview();
    } catch (problem) {
      if (readRequest !== request || request.signal.aborted) return;
      readRequest = null; $("receipt-photo-reading").hidden = true; $("receipt-text-source").open = !parsed || $("receipt-review").hidden;
      readingProblem(problem.message || "The photo could not be read. Your corrections are still here.");
    }
  }
  async function readLocalPhoto(allowResize = false) {
    if (!photo || !readerSettings?.configured) return;
    stopReading();
    if (!parsed || $("receipt-review").hidden) invalidateReview();
    error("");
    const request = new AbortController(); readRequest = request;
    $("receipt-photo-reading").hidden = false;
    $("receipt-photo-status").textContent = "Reading with the configured local model…";
    $("receipt-photo-progress").removeAttribute("value");
    $("read-receipt-local").disabled = true;
    try {
      const { prepareReceiptPhoto } = await import("./receipt-photo-input.js");
      const prepared = await prepareReceiptPhoto(photo, { rotation, signal: request.signal, encodedLimit: readerSettings.encodedImageLimit, allowResize });
      if (request.signal.aborted) return;
      if (prepared.kind === "needs-resize") {
        $("read-receipt-local").hidden = true;
        $("receipt-smaller-copy").hidden = false;
        $("receipt-smaller-copy").scrollIntoView({ block: "nearest" });
        return;
      }
      const image = prepared.image;
      const response = await fetch("/tabloom/api/receipt-reader", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image }), signal: request.signal });
      const result = await response.json();
      if (!response.ok) throw Error(result.error || "The local reader could not finish. Try the browser reader or enter items yourself.");
      if (readRequest !== request || request.signal.aborted || !dialog.open) return;
      if (result.kind !== "tabloom-receipt-vision-review" || !Array.isArray(result.items) || result.items.length > 60) throw Error("The local reader returned an incomplete review. Enter the amounts from the photo.");
      readRequest = null;
      manualEntry = false;
      enterItems();
      modelReview = true;
      showReadingOptionsSummary(true);
      $("receipt-model-confirmation").hidden = false;
      $("confirm-receipt-model").checked = false;
      $("receipt-tip-before-total").checked=false;
      sourceText = String(result.rawResponse || "");
      $("receipt-text").value = sourceText;
      $("receipt-text-source").querySelector("summary").textContent = "Original model reading";
      $("receipt-import-title").textContent = "Check the model reading";
      $("receipt-review").querySelector(".receipt-review-intro").textContent = "Compare every line with the original photo. Correct missing or uncertain readings; enter 0.00 only when you have checked that no charge applies.";
      const rawAmount = value => Number.isSafeInteger(value?.cents) ? decimal(value.cents) : String(value?.raw ?? "");
      $("receipt-review-items").innerHTML = result.items.map(item => ({ name: String(item.name || ""), price: rawAmount(item.price) })).map(itemRow).join("");
      for (const field of ["discount", "tax", "tip"]) $("receipt-review-" + field).value = rawAmount(result.printed?.["printed_" + field]);
      $("receipt-review-printed").value = rawAmount(result.printed?.printed_total);
      $("receipt-review-printed-subtotal").value = rawAmount(result.printed?.printed_subtotal);
      $("receipt-excluded-lines").textContent = (result.issues || []).map(issue => issue.field + ": " + issue.message + (issue.raw ? " (read: " + issue.raw + ")" : "")).join("\n");
      refreshTotal();
      $("receipt-review").scrollIntoView({ block: "nearest" });
    } catch (problem) {
      if (readRequest !== request || request.signal.aborted) return;
      error(problem.message || "The local reader could not finish. Enter items yourself or use the browser reader.");
    } finally {
      if (readRequest === request) { readRequest = null; $("receipt-photo-reading").hidden = true; }
      $("read-receipt-local").disabled = false;
    }
  }
  $("read-receipt-local").addEventListener("click", () => readLocalPhoto());
  $("read-receipt-smaller").addEventListener("click", () => readLocalPhoto(true));
  const closeChoice = document.createElement("div");
  closeChoice.id = "receipt-close-choice"; closeChoice.className = "receipt-close-choice"; closeChoice.hidden = true;
  closeChoice.innerHTML = '<strong>Keep this receipt for later?</strong><div><button id="keep-receipt-later" type="button" class="primary">Keep for later</button><button id="keep-receipt-checking" type="button" class="text-button">Keep checking</button><button id="discard-receipt-import" type="button" class="text-button">Discard receipt</button></div>';
  dialog.querySelector(".receipt-import-heading").after(closeChoice);
  let closeFocus = null, closePending = false;
  const setClosePending = pending => {
    closePending=pending;
    closeChoice.querySelectorAll("button").forEach(button=>{button.disabled=pending;});
    $("cancel-receipt-import").disabled=pending;
    dialog.querySelector(".receipt-import-body").inert=pending;
    $("receipt-import-footer").inert=pending;
  };
  const keepChecking = () => { if(closePending)return;closeChoice.hidden = true; const target = closeFocus?.isConnected ? closeFocus : $("cancel-receipt-import"); target.focus(); };
  const requestClose = () => {
    if(closePending)return;
    if (importRequest || !(photo || $("receipt-text").value.trim() || (!$("receipt-review").hidden && $("receipt-review-items").childElementCount))) { dialog.close(); return; }
    if (!closeChoice.hidden) { $("keep-receipt-checking").focus(); return; }
    closeFocus = currentReceiptTarget(lastReceiptFocus)?lastReceiptFocus:document.activeElement; stopReading();
    closeChoice.hidden = false; $("keep-receipt-later").focus(); closeChoice.scrollIntoView({ block: "nearest" });
  };
  $("keep-receipt-checking").addEventListener("click", keepChecking);
  $("keep-receipt-later").addEventListener("click",async()=>{
    if(closePending)return;
    setClosePending(true);$("keep-receipt-later").textContent="Keeping…";
    try{
      stopReading();
      await draftQueue;
      if(draftFailed){
        const record=await draftStore.read(draftContext);
        if((record?.revision||null)!==draftRevision)throw Error("Another tab changed the saved correction. Your current edits have not replaced it.");
        draftFailed=false;
      }
      // Write even an unchanged view: a newer tab must win instead of a stale close claiming success.
      lastDraftJSON="";keepDraft();await draftQueue;
      if(draftFailed||!draftRevision)throw Error(draftStatus.textContent||"The correction could not be kept.");
      dialog.close();
    }catch(problem){
      draftStatus.hidden=false;draftStatus.textContent="Could not keep this correction. "+problem.message;
      $("keep-receipt-later").textContent="Try keeping again";
    }finally{
      setClosePending(false);
      if(!dialog.open)$("keep-receipt-later").textContent="Keep for later";
    }
  });
  $("discard-receipt-import").addEventListener("click", async () => {
    if(closePending)return;
    setClosePending(true);
    try { await forgetDraft(); }
    catch { onRecoveryError(Error("This tab’s correction was discarded. Any saved recovery copy was left untouched.")); }
    finally { dialog.close();setClosePending(false); }
  });
  $("cancel-receipt-import").addEventListener("click", requestClose);
  dialog.addEventListener("cancel", event => { event.preventDefault(); requestClose(); });
  dialog.addEventListener("close", () => {
    draftReady=false;setClosePending(false);$("keep-receipt-later").textContent="Keep for later";
    closeChoice.hidden = true; closeFocus = null;
    settingsGeneration++;
    clearPhoto();
    $("receipt-photo-file").value = "";
    previouslyFocused?.focus();
  });
  $("receipt-text").addEventListener("input", () => { clearCorrectionUndo(); excludedSourceLines = excludedSourceLines.filter(line => !$("receipt-text").value.split(/\r?\n/).some(current => current.trim() === line.trim())); stopReading(); invalidateReview(); error(""); });
  $("preview-receipt").addEventListener("click", preview);
  $("choose-receipt-photo").addEventListener("click", () => $("receipt-photo-file").click());
  $("change-receipt-photo").addEventListener("click", () => { $("receipt-photo-file").value = ""; $("receipt-photo-file").click(); });
  $("receipt-photo-file").addEventListener("change", () => {
    const file = $("receipt-photo-file").files[0];
    if (file) readPhoto(file);
  });
  $("zoom-receipt-photo").addEventListener("click", () => {
    const zoomed = $("receipt-photo-source").classList.toggle("receipt-photo-zoomed");
    $("zoom-receipt-photo").textContent = zoomed ? "Fit photo" : "Zoom photo";
    $("zoom-receipt-photo").setAttribute("aria-pressed", String(zoomed));
    const frame = $("receipt-photo-source").querySelector(".receipt-photo-frame");
    if (zoomed) { frame.scrollLeft = (frame.scrollWidth - frame.clientWidth) / 2; frame.scrollTop = frame.scrollHeight * .2; }
  });
  $("enter-receipt-items").addEventListener("click", enterItems);
  $("rotate-receipt-photo").addEventListener("click", () => {
    if (!photo) return;
    rotation = (rotation + 90) % 360;
    if (manualEntry) {
      $("receipt-photo-image").style.transform = "rotate(" + rotation + "deg)";
      $("receipt-review-items").querySelector(".receipt-review-name")?.focus();
      return;
    }
    readPhoto(photo, true);
  });
  $("stop-receipt-photo").addEventListener("click", () => {
    stopReading(); const hasReview = Boolean(parsed && (!$("receipt-review").hidden || $("receipt-import-error").querySelector("[data-edit-source-line]"))); $("receipt-text-source").open = !hasReview;
    readingProblem(hasReview ? "Reading stopped. Your corrections are still here." : "Reading stopped. You can paste receipt text or choose another photo.");
  });
  $("receipt-review").addEventListener("input", event => { if(event.target.id==="receipt-review-printed") $("receipt-tip-before-total").checked=false; stopReading(); if (modelReview && event.target.id !== "confirm-receipt-model") $("confirm-receipt-model").checked = false; clearCorrectionUndo(); error(""); refreshTotal(); });
  $("receipt-no-discount-tip").addEventListener("click", () => {
    const discount = $("receipt-review-discount"), tip = $("receipt-review-tip");
    if (!dialog.open || $("receipt-review").hidden || $("receipt-no-discount-tip").hidden || discount.value.trim() || tip.value.trim()) return;
    discount.value = "0.00"; tip.value = "0.00";
    discount.dispatchEvent(new Event("input", { bubbles: true }));
    const next = $("receipt-review").querySelector("[aria-invalid=true]") || $("confirm-receipt-model");
    next.scrollIntoView({ block: "center", behavior: "auto" });
    next.focus({ preventScroll: true });
  });
  function renumberReviewItems() {
    [...$("receipt-review-items").children].forEach((item, index) => {
      const number = index + 1;
      item.querySelector(".receipt-review-number").textContent = number;
      item.querySelector(".receipt-review-name").setAttribute("aria-label", "Receipt item " + number + " name");
      item.querySelector(".receipt-review-price").setAttribute("aria-label", "Line total for receipt item " + number + " in USD");
      item.querySelector("[data-remove-receipt-item]").setAttribute("aria-label", "Remove receipt item " + number);
    });
  }
  $("receipt-review-items").addEventListener("click", event => {
    if (!event.target.closest("[data-remove-receipt-item]")) return;
    stopReading(); clearCorrectionUndo();
    const row = event.target.closest(".receipt-review-item");
    const focusRow = row.nextElementSibling || row.previousElementSibling;
    removedReviewItem = { index: [...row.parentElement.children].indexOf(row), name: row.querySelector(".receipt-review-name").value, price: row.querySelector(".receipt-review-price").value };
    row.remove();
    $("undo-receipt-item-removal").hidden = false;
    if (modelReview) $("confirm-receipt-model").checked = false;
    renumberReviewItems();
    error(""); refreshTotal();
    (focusRow?.querySelector(".receipt-review-name") || $("add-receipt-review-item")).focus();
  });
  $("undo-receipt-item-removal").addEventListener("click", () => {
    if (!removedReviewItem) return;
    stopReading();
    const removed = removedReviewItem, rows = $("receipt-review-items");
    const template = document.createElement("template");
    template.innerHTML = itemRow(removed, removed.index);
    const restored = template.content.firstElementChild;
    rows.insertBefore(restored, rows.children[removed.index] || null);
    clearCorrectionUndo(); renumberReviewItems();
    if (modelReview) $("confirm-receipt-model").checked = false;
    error(""); refreshTotal();
    restored.querySelector(".receipt-review-name").focus();
  });
  $("add-receipt-review-item").addEventListener("click", () => {
    stopReading();
    const rows = $("receipt-review-items").children;
    if (rows.length >= 60) { error("A receipt can contain at most 60 items."); return; }
    if (modelReview) $("confirm-receipt-model").checked = false;
    clearCorrectionUndo(); $("receipt-review-items").insertAdjacentHTML("beforeend", itemRow({ name: "", price: "" }, rows.length));
    $("receipt-review-items").lastElementChild.querySelector(".receipt-review-name").focus(); refreshTotal();
  });
  $("receipt-import-error").addEventListener("input", event => { if (event.target.matches("[data-edit-source-line]")) { stopReading(); event.target.setCustomValidity(""); clearCorrectionUndo(); } });
  $("receipt-import-error").addEventListener("click", event => {
    if (event.target.closest("[data-crop-receipt-photo]")) { openCrop(); return; }
    if (event.target.closest("[data-enter-receipt-items]")) { enterItems(); return; }
    if (event.target.closest("[data-enter-receipt-text]")) {
      $("receipt-text-source").open = true;
      $("receipt-text").focus();
      $("receipt-text").scrollIntoView({ block: "center" });
      return;
    }
    const button = event.target.closest("[data-repair-issue], [data-apply-source-line]");
    if (!button || !parsed) return;
    const issueIndex = Number(button.dataset.repairIssue ?? button.dataset.applySourceLine);
    const issue = parsed.issues[issueIndex];
    let suggestion = issue?.suggestion;
    if (button.hasAttribute("data-apply-source-line")) {
      const input = $("receipt-import-error").querySelector('[data-edit-source-line="' + issueIndex + '"]');
      if (!input) return;
      if (!input.value.trim()) { input.setCustomValidity("Enter the corrected line, or use the receipt text editor to remove it."); input.reportValidity(); return; }
      suggestion = { action: "replace", text: input.value, label: "Edited line " + issue.line };
    }
    if (!suggestion || !["exclude", "replace"].includes(suggestion.action)) return;
    const before = $("receipt-text").value, lines = before.split(/\r?\n/), index = issue.line - 1;
    if (before !== sourceText || !Number.isInteger(index) || !lines[index] || lines[index].trim() !== issue.text.trim()) {
      error("The receipt text changed. Review it again before correcting a line.");
      return;
    }
    let contextToConsume = null;
    if (suggestion.context) {
      const context = suggestion.context, contextIndex = context.line - 1;
      if (!Number.isInteger(contextIndex) || typeof context.text !== "string" || !lines[contextIndex] || lines[contextIndex].trim() !== context.text.trim()) {
        error("The supporting receipt line changed. Review the receipt text again before correcting this line.");
        return;
      }
      if (context.consume === true) {
        if (suggestion.action !== "replace" || contextIndex !== index - 1) {
          error("The item name is no longer beside this price. Review the receipt text again.");
          return;
        }
        contextToConsume = contextIndex;
      }
    }
    const previousExcluded = [...excludedSourceLines], inline = captureSourceEditors();
    if (suggestion.action === "exclude") excludedSourceLines.push(lines.splice(index, 1)[0]);
    else {
      if (typeof suggestion.text !== "string" || /[\r\n]/.test(suggestion.text)) { error("Edit this line in the receipt text."); return; }
      lines[index] = suggestion.text;
      if (contextToConsume !== null) lines.splice(contextToConsume, 1);
    }
    $("receipt-text").value = lines.join("\n");
    preview();
    const removed = [suggestion.action === "exclude" ? index : null, contextToConsume].filter(line => line !== null);
    restoreSourceEditors(inline.filter(edit => !removed.includes(edit.line - 1)).map(edit => ({ ...edit, line: edit.line - removed.filter(line => line < edit.line - 1).length })));
    correctionUndo = { text: before, after: $("receipt-text").value, excluded: previousExcluded, inline };
    $("receipt-correction-status").innerHTML = '<span>' + escape(suggestion.label) + '.</span><button type="button" id="undo-receipt-line-correction" class="text-button">Undo correction</button>';
    $("receipt-correction-status").hidden = false;
    if (parsed?.issues.some(problem => !arithmeticIssue(problem))) $("receipt-import-error").querySelector("[data-edit-source-line], [data-repair-issue]")?.focus();
    else $("receipt-review-items").querySelector(".receipt-review-name")?.focus();
  });
  $("receipt-correction-status").addEventListener("click", event => {
    if (event.target.id !== "undo-receipt-line-correction" || !correctionUndo) return;
    if ($("receipt-text").value !== correctionUndo.after) { clearCorrectionUndo(); return; }
    const previous = correctionUndo;
    $("receipt-text").value = previous.text; excludedSourceLines = previous.excluded;
    clearCorrectionUndo(); preview(); restoreSourceEditors(previous.inline || []);
  });
  $("use-receipt").addEventListener("click", async () => {
    if(importRequest)return;
    stopReading();
    const request=new AbortController();importRequest=request;
    const controls=[...dialog.querySelectorAll("input,select,textarea,button")].filter(control=>control.id!=="cancel-receipt-import");
    const previousDisabled=controls.map(control=>control.disabled);
    error("");
    try {
      const result = reviewedReceipt();
      if (result.reconciliation.status === "mismatch") throw Error("Make the entered amounts match the printed receipt before importing.");
      controls.forEach(control=>{control.disabled=true;});
      $("use-receipt").textContent=photo?"Keeping original photo…":"Importing…";
      const applied=await onUse(result, itemCount > 0 && $("receipt-import-mode").value === "append",photo,request.signal);
      if(!request.signal.aborted&&applied!==false){
        try{await forgetDraft();}catch(problem){onRecoveryError(Error("Receipt imported, but its local recovery copy could not be removed. "+problem.message));}
        dialog.close();
      }
    } catch (problem) { if(!request.signal.aborted)error(problem.message); }
    finally{controls.forEach((control,index)=>{control.disabled=previousDisabled[index];});if(importRequest===request)importRequest=null;if(dialog.open)refreshTotal();}
  });
  return {
    open({ itemCount: count }) {
      draftReady=false;pendingDraft=null;draftRecovery.hidden=true;draftStatus.hidden=true;
      draftContext=getDraftContext();const epoch=++draftEpoch;
      previouslyFocused = document.activeElement; itemCount = count;
      clearCorrectionUndo(); excludedSourceLines = [];
      clearPhoto(); invalidateReview(); error("");
      $("receipt-text").value = ""; sourceText=""; $("receipt-text-source").open = true;
      $("receipt-review-items").replaceChildren();
      for(const field of ["discount","tax","tip","printed","printed-subtotal"])$("receipt-review-"+field).value="";
      $("receipt-text-source").querySelector("summary").textContent = "Paste receipt text";
      $("receipt-import-mode").value = "replace";
      dialog.showModal(); lockDraftBody(true);draftStatus.hidden=false;draftStatus.textContent="Opening receipt correction…";
      draftQueue.then(()=>draftStore.read(draftContext)).then(record=>{
        if(epoch!==draftEpoch||!dialog.open)return;
        draftFailed=false;draftRevision=record?.revision||null;draftPhoto=null;draftPhotoId=null;lastDraftJSON="";
        if(record){
          pendingDraft=record;draftRecovery.hidden=false;draftStatus.hidden=true;dialog.setAttribute("aria-busy","false");$("receipt-import-title").textContent="Resume receipt";
          $("receipt-draft-recovery-text").textContent=record.base===draftContext.base?"Your unfinished receipt correction is kept on this device.":"This dinner changed after your correction. Review the earlier receipt before replacing or adding items.";
          $("resume-receipt-draft").focus();
        }else{draftReady=true;draftStatus.hidden=true;lockDraftBody(false);$("choose-receipt-photo").focus();}
      }).catch(problem=>{
        if(epoch!==draftEpoch||!dialog.open)return;
        draftFailed=true;draftReady=true;lockDraftBody(false);draftStatus.hidden=false;draftStatus.textContent=problem.message+" Changes will not survive a reload.";$("choose-receipt-photo").focus();
      });
      readerSettings = null; const generation = ++settingsGeneration;
      fetch("/tabloom/api/receipt-reader").then(response => response.ok ? response.json() : null).then(settings => {
        if (generation !== settingsGeneration || !dialog.open) return;
        readerSettings = settings;
        $("receipt-local-reader").hidden = !photo || !settings?.configured;
        $("receipt-local-reader-note").textContent = settings?.configured ? "Optional: sends this photo to the configured local model on the computer running Tabloom. Browser reading remains the default." : "";
      }).catch(() => {});
    },
    close() { dialog.close(); },
    checkRecovery() { return draftStore.read(getDraftContext()).then(record=>onDraftChange(Boolean(record))).catch(()=>{}); }
  };
}

export function initReceiptIntake({ button, onApply, canEdit, getDraftContext, getItemCount = () => 0, onError = () => {} }) {
  const dialog = document.createElement("dialog");
  dialog.id = "receipt-import"; dialog.className = "receipt-import-dialog";
  document.body.append(dialog);
  const buttonLabel=button.textContent;
  const view = createReceiptImportView(dialog, { getDraftContext, onDraftChange(present){button.textContent=present?"Resume receipt correction":buttonLabel;},onRecoveryError:onError,onUse(receipt, append, photo, signal) { canEdit(); return onApply(receipt, append, photo, signal); } });
  button.addEventListener("click", () => {
    try { canEdit(); view.open({ itemCount: getItemCount() }); }
    catch (problem) { onError(problem); }
  });
  return { close: () => view.close(), checkRecovery:()=>view.checkRecovery() };
}
