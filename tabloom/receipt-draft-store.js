const DB_NAME = "tabloom-receipt-drafts-v1";
const conflict = () => new Error("This receipt correction changed in another tab. Reopen it before continuing; this tab has not overwritten it.");
export function receiptDraftContext(value) {
  if (!value || typeof value.table !== "string" || !value.table || value.table.length > 200 || typeof value.base !== "string" || value.base.length > 200000) throw Error("The dinner is not ready for receipt recovery.");
  return { table: value.table, base: value.base };
}
export function validateReceiptDraft(value) {
  if (!value || value.version !== 1 || typeof value.sourceText !== "string" || typeof value.text !== "string" || value.sourceText.length > 20000 || value.text.length > 20000) throw Error("This saved correction cannot be opened by this build.");
  if (!Array.isArray(value.rows) || value.rows.length > 60 || value.rows.some(row => !row || typeof row.name !== "string" || row.name.length > 96 || typeof row.price !== "string" || row.price.length > 500)) throw Error("The saved receipt rows are incomplete.");
  for (const key of ["discount","tax","tip","printed","printed-subtotal"]) if (typeof value.amounts?.[key] !== "string" || value.amounts[key].length > 500) throw Error("The saved receipt amounts are incomplete.");
  if (typeof value.remainingText !== "string" || value.remainingText.length>40000) throw Error("The saved remaining receipt text is incomplete.");
  if (!Array.isArray(value.excluded) || value.excluded.length > 1000 || value.excluded.some(line => typeof line !== "string" || line.length > 20000)) throw Error("The saved receipt text is incomplete.");
  if (!Array.isArray(value.inline) || value.inline.length > 1000 || value.inline.some(row => !Number.isInteger(row.index) || row.index < 0 || typeof row.value !== "string" || row.value.length > 500)) throw Error("The saved source edits are incomplete.");
  if (![0,90,180,270].includes(value.rotation) || !["replace","append"].includes(value.mode)) throw Error("The saved receipt settings are incomplete.");
  if (value.printedTotalBeforeTip !== undefined && typeof value.printedTotalBeforeTip !== "boolean") throw Error("The saved printed-total choice is incomplete.");
  if (value.optionsSummary !== undefined && typeof value.optionsSummary !== "boolean") throw Error("The saved reading options are incomplete.");
  for (const key of ["parsed","manual","model","visible","sourceOpen","optionsOpen"]) if (typeof value[key] !== "boolean") throw Error("The saved correction is incomplete.");
  if (JSON.stringify(value).length > 250000) throw Error("The receipt correction is too large to keep locally.");
  return value;
}
export function createReceiptDraftStore(indexedDB = globalThis.indexedDB) {
  let opening;
  const open = () => opening ||= new Promise((resolve,reject) => {
    if (!indexedDB) { reject(Error("Local receipt recovery is unavailable in this browser.")); return; }
    const request = indexedDB.open(DB_NAME,1);
    request.onupgradeneeded = () => { for (const name of ["records","photos"]) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name); };
    request.onsuccess = () => { const db=request.result; db.onversionchange=()=>db.close(); resolve(db); };
    request.onerror = () => reject(request.error || Error("Local receipt recovery could not open."));
    request.onblocked = () => reject(Error("Close older Tabloom tabs to enable receipt recovery."));
  });
  async function transact(mode, action) {
    const db=await open();
    return new Promise((resolve,reject) => {
      const transaction=db.transaction(["records","photos"],mode); let result, problem;
      transaction.oncomplete=()=>resolve(result);
      transaction.onabort=()=>reject(problem || transaction.error || Error("The correction could not be kept on this device."));
      transaction.onerror=()=>{};
      try { action(transaction, value=>{result=value;}, error=>{problem=error;transaction.abort();}); }
      catch(error) { problem=error;transaction.abort(); }
    });
  }
  return {
    async read(input) {
      const context=receiptDraftContext(input);
      return transact("readonly",(tx,done,fail)=>{
        const request=tx.objectStore("records").get(context.table);
        request.onsuccess=()=>{
          const record=request.result;
          if (!record) { done(null); return; }
          try { if(record.version!==1 || typeof record.base!=="string" || typeof record.revision!=="string")throw Error("The saved correction record is incomplete."); validateReceiptDraft(record.snapshot); } catch(error) { fail(error); return; }
          const photoRequest=tx.objectStore("photos").get(context.table);
          photoRequest.onsuccess=()=>{
            const photo=photoRequest.result || null;
            if (record.photoId && (!(photo instanceof Blob) || !["image/jpeg","image/png","image/webp"].includes(photo.type) || photo.size>20*1024*1024)) { fail(Error("The original photo is unavailable; this correction was not restored."));return; }
            done({...record,photo});
          };
        };
      });
    },
    async write(input,snapshot,photo,photoId,expectedRevision) {
      const context=receiptDraftContext(input);validateReceiptDraft(snapshot);
      if (photo && (!(photo instanceof Blob) || !["image/jpeg","image/png","image/webp"].includes(photo.type) || photo.size>20*1024*1024 || !photoId)) throw Error("The original photo cannot be kept locally.");
      return transact("readwrite",(tx,done,fail)=>{
        const records=tx.objectStore("records"), request=records.get(context.table);
        request.onsuccess=()=>{
          const previous=request.result;
          if ((previous?.revision || null)!==expectedRevision) { fail(conflict());return; }
          const revision=crypto.randomUUID();
          const record={version:1,base:context.base,snapshot,photoId:photo?photoId:null,revision,updatedAt:Date.now()};
          records.put(record,context.table);
          if (photo && previous?.photoId!==photoId) tx.objectStore("photos").put(photo,context.table);
          else if (!photo) tx.objectStore("photos").delete(context.table);
          done(revision);
        };
      });
    },
    async remove(input,expectedRevision) {
      const context=receiptDraftContext(input);
      return transact("readwrite",(tx,done,fail)=>{
        const request=tx.objectStore("records").get(context.table);
        request.onsuccess=()=>{
          if ((request.result?.revision || null)!==expectedRevision) {fail(conflict());return;}
          tx.objectStore("records").delete(context.table);tx.objectStore("photos").delete(context.table);done(null);
        };
      });
    }
  };
}
