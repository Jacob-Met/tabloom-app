/** Inline identity shared by standalone guest documents; no external font or resource. */
export const guestIdentityStyles = `
body{background:#f0f3fa;color:#12285a;font-family:Arial,Helvetica,sans-serif}
main{background:#fff;border:0;border-radius:0;min-height:100vh;margin:0 auto;padding-top:0}
header{background:#ff5b26;border:0;padding:16px;margin-bottom:24px;color:#172653}
header b,header .brand{font-family:Arial,Helvetica,sans-serif;font-style:normal;font-size:23px;font-weight:900;color:#172653;letter-spacing:-1px;text-transform:uppercase}
header span,header .sandbox{color:#172653;background:transparent;border-radius:0;letter-spacing:0}
h1{font-family:Arial,Helvetica,sans-serif;font-weight:800;font-style:normal;letter-spacing:-.8px}
.amount strong,p.amount,.sum strong,.share-heading strong,.item-price,td:last-child,dd{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-variant-numeric:tabular-nums}
.sum{background:#f0f3fa;color:#12285a;border:0;border-top:6px solid #143dc6}
button,.primary,.payment,.action a{background:#143dc6;border-color:#143dc6;border-radius:0;color:#fff}
.payment span{color:#fff}.payment:hover{background:#0b2995}
.secondary{background:transparent;color:#143dc6;border-color:transparent}
.bottom{background:#fff;border-top-color:#12285a}
.item input{accent-color:#143dc6}
button:focus-visible,a:focus-visible,input:focus-visible{outline-color:#143dc6}
#preview-retry,#download-offline-response{color:#143dc6}
@media(max-width:650px){body{background:#fff}main{padding-top:0}header{margin-bottom:20px}}
@media print{body,main{background:#fff}header{background:#fff;border-bottom:2px solid #12285a}.sum{background:#fff}}
`;

/** Readable offline handoff names; packet identity remains the import authority. */
export function guestFileName(packet,kind,extension){
  const slug=(value,fallback)=>{
    const clean=String(value||"").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu,"-").replace(/^-+|-+$/g,"");
    let name="";for(const char of clean){if(new TextEncoder().encode(name+char).length>64)break;name+=char;}
    return name.replace(/-+$/g,"")||fallback;
  };
  return "tabloom-"+slug(kind,"file")+"-"+slug(packet.title,"dinner")+"-"+slug(packet.guestName,"guest")+"-"+slug(packet.guestId,"guest")+"-rev"+packet.revision+"."+slug(extension,"txt");
}
