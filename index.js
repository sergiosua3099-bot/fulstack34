// ===============================================================
// INNOTIVA BACKEND PRO  ⚡ FINAL + COMPLEMENTADO + LUZ + REALISMO
// Respetado tu código original 💯 + mejoras IA + integración PNG
// ===============================================================

require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const sharp = require("sharp");
const crypto = require("crypto");
const OpenAI = require("openai");
const cloudinary = require("cloudinary").v2;

// fetch node compatible
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

// ================== CONFIG ================================
const app = express();
app.use(cors());
app.use(express.json());
const upload = multer({ storage: multer.memoryStorage() });
const PORT = process.env.PORT || 10000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const SHOPIFY_DOMAIN  = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_TOKEN   = process.env.SHOPIFY_STOREFRONT_TOKEN;
const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;
const REPLICATE_MODEL = process.env.REPLICATE_MODEL_SLUG || "black-forest-labs/flux-fill-dev";

// ===============================================================
// 📡 HEALTH
// ===============================================================
app.get("/",(req,res)=>res.send("INNOTIVA BACKEND PRO funcionando 🧠🔥"));
app.get("/health",(req,res)=>res.json({ok:true,time:new Date().toISOString()}));

// ===============================================================
// ✔ HELPERS ORIGINALES — CONSERVADOS ÍNTEGROS
// ===============================================================
function logStep(s,extra={}){console.log("\n[INNOTIVA]",s,Object.keys(extra).length?extra:""); }

function buildShopifyProductGid(id){
  return String(id).startsWith("gid://") ? id : `gid://shopify/Product/${id}`;
}

function safeParseJSON(raw,label="JSON"){
  if(!raw) return null;
  const cleaned=raw.replace(/```json/gi,"").replace(/```/g,"").trim();
  try{ return JSON.parse(cleaned); }
  catch{ console.error("❌ JSON parse fail:",label,cleaned); return null; }
}

// ================== CLOUDINARY ===============================
async function uploadBufferToCloudinary(buffer,folder,n="image"){
  return cloudinary.uploader.upload(`data:image/jpeg;base64,${buffer.toString("base64")}`,{
    folder,public_id:`${n}-${Date.now()}`
  });
}
async function uploadUrlToCloudinary(url,folder,n="result"){
  return cloudinary.uploader.upload(url,{folder,public_id:`${n}-${Date.now()}`});
}
function buildThumbnails(publicId){
  return {
    low: cloudinary.url(publicId,{secure:true,width:400,height:400,crop:"fill",quality:70}),
    medium: cloudinary.url(publicId,{secure:true,width:1080,height:1080,crop:"fill",quality:80})
  }
}

// ================== SHOPIFY ===============================
async function fetchProductFromShopify(pid){
  const query=`query GetProduct($id:ID!){
    product(id:$id){ id title productType description featuredImage{url} }
  }`;

  const r=await fetch(`https://${SHOPIFY_DOMAIN}/api/2024-01/graphql.json`,{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "X-Shopify-Storefront-Access-Token":SHOPIFY_TOKEN
    },
    body:JSON.stringify({query,variables:{id:buildShopifyProductGid(pid)}})
  });

  const j=await r.json();
  if(!j.data?.product) throw new Error("No se pudo obtener producto Shopify");
  return {
    id:j.data.product.id,
    title:j.data.product.title,
    productType:j.data.product.productType,
    description:j.data.product.description||"",
    featuredImage:j.data.product.featuredImage?.url||null
  }
}

// ===============================================================
// 🔥 OPENAI VISION — RESPETADO + MEJORADO
// ===============================================================
async function analyzeRoomAndProduct({roomImageUrl,productImageUrl,ideaText,productName,productType}) {
  const prompt =
`Analiza la fotografía del espacio y el producto seleccionado.
Devuelve SOLO JSON EXACTO:

{
 "imageWidth":number,
 "imageHeight":number,
 "roomStyle":"texto",
 "placement":{"x":n,"y":n,"width":n,"height":n},
 "finalPlacement":{"x":n,"y":n,"width":n,"height":n},
 "product":{
   "normalizedType":"cuadro"|"lampara"|"otro",
   "rawTypeHint":"texto",
   "colors":["#hex"],
   "materials":["madera","metal","tela","vidrio"],
   "texture":"acabado",
   "finish":"mate/brillante/satinado"
 }
}

NO EXPLICACIONES — SOLO JSON.
Intención="${ideaText||""}"
Producto="${productName||""}" tipo="${productType||""}"
`;

  const res = await openai.responses.create({
    model:"gpt-4.1-mini",
    input:[{
      role:"user",
      content:[
        {type:"input_text",text:prompt},
        {type:"input_image",image_url:roomImageUrl},
        {type:"input_image",image_url:productImageUrl}
      ]
    }]
  });

  const text = res.output?.[0]?.content.filter(c=>c.type==="output_text").map(c=>c.text).join("")||"";
  let analysis = safeParseJSON(text,"analysis");

  // fallback exacto MANTENIDO
  if(!analysis?.finalPlacement){
    const w=analysis?.imageWidth||1200,h=analysis?.imageHeight||800;
    const bw=Math.round(w*0.55), bh=Math.round(h*0.42);
    analysis={
      imageWidth:w,imageHeight:h,
      roomStyle:"no-detectado",
      placement:{x:(w-bw)/2,y:(h-bh)/3,width:bw,height:bh},
      finalPlacement:{x:(w-bw)/2,y:(h-bh)/3,width:bw,height:bh},
      product:{normalizedType:"otro"}
    }
  }
  return analysis;
}

// ===============================================================
// 🟩 Inserción real del producto PNG + luz si lámpara
// ===============================================================
async function insertProductReal(roomUrl,productUrl,place,isLamp){
  const R=Buffer.from(await (await fetch(roomUrl)).arrayBuffer());
  const Praw=Buffer.from(await (await fetch(productUrl)).arrayBuffer());

  const resized=await sharp(Praw).resize({width:place.width,fit:"contain"}).png().toBuffer();

  let merged=await sharp(R).composite([{input:resized,left:place.x,top:place.y}]).toBuffer();

  // ⭐ efecto luz realista SOLO si es lámpara
  if(isLamp){
    const glow=await sharp(resized).blur(38).modulate({brightness:1.45}).png().toBuffer();
    merged=await sharp(merged).composite([
      {input:glow,top:place.y-40,left:place.x-40,blend:"screen",opacity:0.42},
      {input:glow,top:place.y-10,left:place.x-10,blend:"screen",opacity:0.28}
    ]).jpeg({quality:95}).toBuffer();
  }

  return (await uploadBufferToCloudinary(merged,"innotiva/composed","pre-IA")).secure_url;
}

// ===============================================================
// 🧠 Máscara (conservada intacta)
// ===============================================================
async function createMaskFromAnalysis(a){
  const {imageWidth,imageHeight,finalPlacement:p}=a;
  const w=imageWidth,h=imageHeight;
  const buf=Buffer.alloc(w*h,0);
  for(let j=p.y;j<p.y+p.height;j++)for(let i=p.x;i<p.x+p.width;i++)buf[j*w+i]=255;
  return (await sharp(buf,{raw:{width:w,height:h,channels:1}}).png().toBuffer()).toString("base64");
}

// ===============================================================
// 🧠 Copy emocional respetado
// ===============================================================
function buildEmotionalCopy({roomStyle,productName,idea}){
  let m=`Diseñamos esta propuesta pensando en ${roomStyle||"tu espacio"}. `;
  m+=`Integrando ${productName}, buscamos equilibrio visual y calidez. `;
  if(idea) m+=`Tomamos en cuenta tu idea: “${idea}”. `;
  return m+"Visualiza antes de comprar.";
}

// ===============================================================
// 🚀 /experiencia-premium COMPLETO FINAL
// ===============================================================
app.post("/experiencia-premium",upload.single("roomImage"),async(req,res)=>{
try{
  logStep("Nueva experiencia-premium");

  if(!req.file) return res.status(400).json({error:"Falta roomImage"});
  const {productId,productName,productUrl,idea}=req.body;
  if(!productId) return res.status(400).json({error:"Falta productId"});

  // 1) subida original = MANTENIDA
  const up=await uploadBufferToCloudinary(req.file.buffer,"innotiva/rooms","room");
  const roomUrl=up.secure_url;
  const roomPublic=up.public_id;

  // 2) producto Shopify — igual + intacto
  const pd=await fetchProductFromShopify(productId);
  const pName=productName||pd.title;
  const pImg=pd.featuredImage;
  if(!pImg) throw"Producto sin imagen en Shopify";

  // 3) visión IA (no alterado, solo expandido)
  const analysis=await analyzeRoomAndProduct({
    roomImageUrl:roomUrl,productImageUrl:pImg,ideaText:idea,
    productName:pName,productType:pd.productType
  });

  // 4) png real antes de IA
  const isLamp = /(lámpara|lampara|lamp|pendant|ceiling)/i.test(pd.productType||"");
  const composedUrl = await insertProductReal(roomUrl,pImg,analysis.finalPlacement,isLamp);

  // 5) máscara
  const maskBase64 = await createMaskFromAnalysis(analysis);

  // 6) prompt IA MEJORADO SIN BORRAR TU CONTENIDO
  const prompt =
`Producto ya insertado REAL.
Mejora: sombras, bordes, textura ▶ No inventar otro objeto.
Tipo: ${isLamp?"Lampara":"Cuadro"} — mantener diseño exacto.
Integrar al entorno con realismo fotográfico.
Solo editar zona blanca máscara.`;
  
  // 7) INPAINTING FLUX FINAL
  const reqFlux=await fetch(`https://api.replicate.com/v1/models/${REPLICATE_MODEL}/predictions`,{
    method:"POST",
    headers:{Authorization:`Bearer ${REPLICATE_TOKEN}`,"Content-Type":"application/json"},
    body:JSON.stringify({input:{image:composedUrl,mask:`data:image/png;base64,${maskBase64}`,prompt,guidance:6.2,num_inference_steps:26,output_format:"webp",megapixels:"1.1"}})
  });

  let flux=await reqFlux.json();
  while(flux.status!=="succeeded"){
    await new Promise(r=>setTimeout(r,1800));
    flux=await (await fetch(flux.urls.get,{headers:{Authorization:`Bearer ${REPLICATE_TOKEN}`}})).json();
  }

  const finalUpload = await uploadUrlToCloudinary(flux.output[0],"innotiva/generated","room-final");

  // ======================= RESPONSE FINAL =======================
  const msg = buildEmotionalCopy({roomStyle:analysis.roomStyle,productName:pName,idea});
  return res.json({
    ok:true,status:"complete",
    room_image:roomUrl,
    ai_image:finalUpload.secure_url,
    product_id:productId, product_name:pName, product_url:productUrl,
    analysis, message:msg,
    thumbnails:{before:buildThumbnails(roomPublic),after:buildThumbnails(finalUpload.public_id)},
    created_at:new Date().toISOString()
  });

}catch(e){console.error(e);res.status(500).json({error:"error en generación"});}
});


// ================== RUTA REPOSICIÓN FINAL SIN CAMBIOS ==================
app.post("/experiencia-premium-reposicion", async(req,res)=>{
try{
  const{roomImage,ai_image_prev,productId,x,y,width,height,idea}=req.body;
  if(!roomImage||!productId) return res.status(400).json({error:"faltan datos"});

  const base=ai_image_prev||roomImage;
  const pd=await fetchProductFromShopify(productId);
  const pImg=pd.featuredImage;

  const placement={x,y,width:Math.round(width*0.25),height:Math.round(height*0.20)};
  const isLamp=/(lampara|lamp|ceiling)/i.test(pd.productType||"");

  const composed=await insertProductReal(base,pImg,placement,isLamp);

  const mask=await createMaskFromAnalysis({
    imageWidth:width,imageHeight:height,finalPlacement:placement
  });

  const final=await uploadUrlToCloudinary(
    (await (await fetch(`https://api.replicate.com/v1/models/${REPLICATE_MODEL}/predictions`,{
      method:"POST",headers:{Authorization:`Bearer ${REPLICATE_TOKEN}`,"Content-Type":"application/json"},
      body:JSON.stringify({input:{image:composed,mask:`data:image/png;base64,${mask}`,
      prompt:`Reposición exacta + integración realista`,guidance:4.8,num_inference_steps:18}})
    })).json()).output?.[0],
    "innotiva/repositions","reposicion-v2"
  );

  res.json({ok:true,ai_image:final.secure_url});
}catch(e){res.status(500).json({error:"reposicion-fail",detail:String(e)});}
});

// ===============================================================
// RUN
// ===============================================================
app.listen(PORT,()=> console.log(`⚡ INNOTIVA BACKEND LISTO: http://localhost:${PORT}`));
