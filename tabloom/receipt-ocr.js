const assetBase = new URL("./receipt-ocr/", import.meta.url);
let libraryPromise;
function loadReader() {
  if (globalThis.Tesseract?.createWorker) return Promise.resolve(globalThis.Tesseract);
  if (!libraryPromise) libraryPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = new URL("tesseract.min.js", assetBase).href;
    script.onload = () => globalThis.Tesseract?.createWorker ? resolve(globalThis.Tesseract) : reject(Error("The local receipt reader did not load."));
    script.onerror = () => { script.remove(); reject(Error("The local receipt reader is unavailable. Reopen Tabloom and try again.")); };
    document.head.append(script);
  }).catch(error => { libraryPromise = undefined; throw error; });
  return libraryPromise;
}

/** Local English OCR; text and confidence are observations, never verified prices. */
export async function readReceiptPhoto(file, {signal, onProgress = () => {}, rotation = 0, crop = null} = {}) {
  if (!file || !["image/jpeg","image/png","image/webp"].includes(file.type)) throw Error("Choose a JPG, PNG or WebP receipt photo.");
  if (!file.size || file.size > 20 * 1024 * 1024) throw Error("Choose a receipt photo smaller than 20 MB.");
  if (!Number.isFinite(rotation) || rotation % 90 !== 0) throw Error("Rotate the receipt in quarter turns.");
  const angle = ((rotation % 360) + 360) % 360;
  const started = performance.now();
  const stopped = new DOMException("Receipt reading stopped.", "AbortError");
  const check = () => { if (signal?.aborted) throw stopped; };
  const progress = (fraction, status) => { if (!signal?.aborted) onProgress({fraction, status}); };
  let worker, image, canvas, termination, paperCrop=null;
  const terminate = () => { if (worker && !termination) termination = worker.terminate(); return termination; };
  let rejectAbort;
  const abort = new Promise((_, reject) => { rejectAbort = reject; });
  const stop = () => { rejectAbort(stopped); void terminate(); };
  check();
  signal?.addEventListener("abort", stop, {once:true});
  const work = async () => {
    try {
      progress(0, "opening");
      image = await createImageBitmap(file);
      check();
      if (image.width * image.height > 60_000_000) throw Error("This photo is too large. Choose a smaller copy.");
      const scale = Math.min(1, 2600 / Math.max(image.width, image.height));
      const w = Math.max(1, Math.round(image.width * scale)), h = Math.max(1, Math.round(image.height * scale));
      canvas = document.createElement("canvas");
      canvas.width = angle % 180 ? h : w;
      canvas.height = angle % 180 ? w : h;
      const context = canvas.getContext("2d");
      context.fillStyle = "#fff"; context.fillRect(0,0,canvas.width,canvas.height);
      context.translate(canvas.width/2,canvas.height/2); context.rotate(angle*Math.PI/180);
      context.drawImage(image,-w/2,-h/2,w,h);
      image.close(); image = undefined;
      if(crop){
        const {left,top,right,bottom}=crop;
        if(![left,top,right,bottom].every(Number.isFinite)||left<0||top<0||right>1||bottom>1||right-left<.05||bottom-top<.05)throw Error("Choose a larger area inside the photo.");
        const l=Math.floor(left*canvas.width),t=Math.floor(top*canvas.height),r=Math.ceil(right*canvas.width),b=Math.ceil(bottom*canvas.height);
        const selected=document.createElement("canvas");selected.width=r-l;selected.height=b-t;
        selected.getContext("2d").drawImage(canvas,l,t,r-l,b-t,0,0,r-l,b-t);
        canvas.width=canvas.height=0;canvas=selected;
      }
      const pixels=canvas.getContext("2d").getImageData(0,0,canvas.width,canvas.height).data;
      const light=(x,y)=>{const i=(y*canvas.width+x)*4;return (pixels[i]+pixels[i+1]+pixels[i+2])/3>170;};
      const left=[],right=[];
      for(let y=Math.floor(canvas.height*.2);y<canvas.height*.8;y+=7){
        let x=Math.floor(canvas.width/2);if(!light(x,y))continue;
        let l=x,r=x;while(l>0&&light(l-1,y))l--;while(r<canvas.width-1&&light(r+1,y))r++;
        if(r-l>canvas.width*.45){left.push(l);right.push(r);}
      }
      if(!crop && left.length>10){
        left.sort((a,b)=>a-b);right.sort((a,b)=>a-b);
        const l=Math.max(0,left[Math.floor(left.length*.1)]-12),r=Math.min(canvas.width,right[Math.floor(right.length*.9)]+12);
        if(r-l>canvas.width*.6&&(l>canvas.width*.04||r<canvas.width*.96)){
          paperCrop={left:l,top:0,width:r-l,height:canvas.height};
          const cropped=document.createElement('canvas');cropped.width=r-l;cropped.height=canvas.height;
          cropped.getContext('2d').drawImage(canvas,l,0,r-l,canvas.height,0,0,r-l,canvas.height);
          canvas.width=canvas.height=0;canvas=cropped;
        }
      }
      // Encode before worker startup so cancellation cannot interrupt Tesseract's
      // asynchronous canvas conversion and leave a post to a terminated worker.
      const blob = await new Promise((resolve,reject) => canvas.toBlob(value => value ? resolve(value) : reject(Error("The receipt photo could not be prepared.")), "image/png"));
      check();
      const imageBytes = new Uint8Array(await blob.arrayBuffer());
      check();
      progress(.1, "initializing");
      const {createWorker, PSM} = await loadReader();
      check();
      worker = await createWorker("eng",1,{
        workerPath:new URL("worker.min.js",assetBase).href,
        corePath:new URL("core",assetBase).href,
        langPath:new URL("lang",assetBase).href,
        cacheMethod:"none",workerBlobURL:false,
        logger:message => { if(message.status === "recognizing text") progress(.35 + .65 * (message.progress || 0), "reading"); },
      });
      check();
      await Promise.race([worker.setParameters({tessedit_pageseg_mode:paperCrop?PSM.SINGLE_BLOCK:PSM.AUTO,preserve_interword_spaces:"1"}),abort]);
      check(); progress(.35,"reading"); check();
      const {data} = await Promise.race([worker.recognize(imageBytes),abort]);
      check(); progress(1,"reading");
      return {paperCrop,selectedCrop:crop?{...crop}:null,text:data.text,confidence:data.confidence,width:canvas.width,height:canvas.height,elapsedMs:performance.now()-started};
    } finally {
      image?.close();
      if(canvas) canvas.width = canvas.height = 0;
      await terminate();
    }
  };
  try { const result = await Promise.race([work(),abort]); result.elapsedMs = performance.now()-started; return result; }
  finally { signal?.removeEventListener("abort",stop); }
}
