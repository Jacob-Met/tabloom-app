/** Explicit selection over the existing photo; original bytes are never changed. */
export function createReceiptPhotoCrop({dialog,figure,onRead}) {
  const panel=document.createElement("section");panel.id="receipt-crop";panel.hidden=true;
  panel.innerHTML='<h3>Choose the receipt area</h3><p>Drag a box around all items and printed totals. Keep the whole receipt text inside.</p><canvas id="receipt-crop-canvas" aria-label="Receipt photo: drag to select the reading area"></canvas><p id="receipt-crop-selection" role="status"></p><details><summary>Adjust edges with the keyboard</summary><div class="receipt-crop-edges">'+["left","top","right","bottom"].map(edge=>'<label>'+edge[0].toUpperCase()+edge.slice(1)+'<input type="range" min="0" max="1000" step="1" data-crop-edge="'+edge+'" aria-label="Crop '+edge+' edge"></label>').join("")+'</div></details><div class="receipt-crop-actions"><button type="button" id="read-receipt-crop" class="primary">Read selected area</button><button type="button" id="cancel-receipt-crop" class="text-button">Cancel crop</button></div>';
  figure.append(panel);
  const canvas=panel.querySelector("canvas"),context=canvas.getContext("2d"),read=panel.querySelector("#read-receipt-crop");
  let bitmap=null,bounds={left:0,top:0,right:1,bottom:1},pointer=null,generation=0,source=null;
  function paint(){
    if(!bitmap)return;
    const w=canvas.width,h=canvas.height,l=bounds.left*w,t=bounds.top*h,r=bounds.right*w,b=bounds.bottom*h;
    context.clearRect(0,0,w,h);context.drawImage(bitmap,0,0,w,h);context.fillStyle="rgba(10,20,40,.55)";
    context.fillRect(0,0,w,t);context.fillRect(0,b,w,h-b);context.fillRect(0,t,l,b-t);context.fillRect(r,t,w-r,b-t);
    context.strokeStyle="#1659ff";context.lineWidth=Math.max(3,w/180);context.strokeRect(l,t,r-l,b-t);
    for(const [x,y]of[[l,t],[r,t],[l,b],[r,b]]){context.fillStyle="white";context.fillRect(x-5,y-5,10,10);}
    const valid=bounds.right-bounds.left>=.05&&bounds.bottom-bounds.top>=.05;read.disabled=!valid;
    panel.querySelector("#receipt-crop-selection").textContent=valid?"Original photo stays available for checking.":"Choose a larger area.";
    for(const input of panel.querySelectorAll("[data-crop-edge]"))input.value=String(Math.round(bounds[input.dataset.cropEdge]*1000));
  }
  const position=e=>{const r=canvas.getBoundingClientRect();return{x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))};};
  canvas.addEventListener("pointerdown",e=>{if(!bitmap)return;e.preventDefault();const p=position(e),r=canvas.getBoundingClientRect();
    const corners=[{x:bounds.left,y:bounds.top,opposite:{x:bounds.right,y:bounds.bottom}},{x:bounds.right,y:bounds.top,opposite:{x:bounds.left,y:bounds.bottom}},{x:bounds.left,y:bounds.bottom,opposite:{x:bounds.right,y:bounds.top}},{x:bounds.right,y:bounds.bottom,opposite:{x:bounds.left,y:bounds.top}}];
    const corner=corners.find(c=>Math.hypot((p.x-c.x)*r.width,(p.y-c.y)*r.height)<22);
    pointer=corner?corner.opposite:p;canvas.setPointerCapture(e.pointerId);if(!corner)bounds={left:p.x,top:p.y,right:p.x,bottom:p.y};paint();});
  canvas.addEventListener("pointermove",e=>{if(!pointer)return;const p=position(e);bounds={left:Math.min(pointer.x,p.x),right:Math.max(pointer.x,p.x),top:Math.min(pointer.y,p.y),bottom:Math.max(pointer.y,p.y)};paint();});
  const end=()=>{pointer=null;};canvas.addEventListener("pointerup",end);canvas.addEventListener("pointercancel",end);
  panel.addEventListener("input",e=>{const edge=e.target.dataset.cropEdge;if(!edge)return;const value=Number(e.target.value)/1000;bounds[edge]=value;
    if(bounds.left>bounds.right)bounds[edge==="left"?"right":"left"]=value;
    if(bounds.top>bounds.bottom)bounds[edge==="top"?"bottom":"top"]=value;paint();
  });
  function close(focus=false){generation++;pointer=null;bitmap?.close();bitmap=null;source=null;canvas.width=canvas.height=0;panel.hidden=true;dialog.classList.remove("cropping-receipt-photo");if(focus)figure.querySelector("#crop-receipt-photo")?.focus();}
  panel.querySelector("#cancel-receipt-crop").addEventListener("click",()=>close(true));
  dialog.addEventListener("cancel",event=>{if(!panel.hidden){event.preventDefault();event.stopImmediatePropagation();close(true);}});
  read.addEventListener("click",()=>{if(read.disabled||!source)return;const original=source,selection={...bounds};close();onRead(original,selection);});
  return {close,async open(file,rotation){
    close();const epoch=generation;const decoded=await createImageBitmap(file);
    if(epoch!==generation||!dialog.open){decoded.close();return;}
    const angle=((rotation%360)+360)%360,scale=Math.min(1,1600/Math.max(decoded.width,decoded.height)),w=Math.round(decoded.width*scale),h=Math.round(decoded.height*scale);
    canvas.width=angle%180?h:w;canvas.height=angle%180?w:h;
    context.save();context.translate(canvas.width/2,canvas.height/2);context.rotate(angle*Math.PI/180);context.drawImage(decoded,-w/2,-h/2,w,h);context.restore();decoded.close();
    const prepared=await createImageBitmap(canvas);
    if(epoch!==generation||!dialog.open){prepared.close();return;}
    bitmap=prepared;source=file;bounds={left:0,top:0,right:1,bottom:1};panel.hidden=false;dialog.classList.add("cropping-receipt-photo");paint();panel.scrollIntoView({block:"start",behavior:"instant"});read.focus({preventScroll:true});
  }};
}
