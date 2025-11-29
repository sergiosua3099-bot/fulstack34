// ===========================
//  INNOTIVA BACKEND PRO 🏛🔥
//  Experiencia Premium + Reposición + Integración Visual Real
// ===========================

require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const sharp = require("sharp");
const crypto = require("crypto");
const OpenAI = require("openai");
const cloudinary = require("cloudinary").v2;
const fetch = global.fetch; // nativo en Node 18+

// ================== CONFIG BÁSICA ==================

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const PORT = process.env.PORT || 10000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_STOREFRONT_TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN;
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const REPLICATE_MODEL_SLUG = process.env.REPLICATE_MODEL_SLUG || "black-forest-labs/flux-fill-dev";

// ================== MIDDLEWARE ==================
app.use(cors());
app.use(express.json());

// ================== HEALTH ==================
app.get("/",(req,res)=>res.send("⚡ INNOTIVA BACKEND LISTO"));
app.get("/health",(req,res)=>res.json({ok:true,time:new Date().toISOString()}));

// ================== HELPERS ==================
function logStep(msg,obj={}){ console.log("\n[INNOTIVA] " + msg,obj); }

function buildShopifyProductGid(id){
  if(String(id).startsWith("gid://")) return id;
  return `gid://shopify/Product/${id}`;
}

function safeParseJSON(txt){
  try{
    return JSON.parse(txt.replace(/```json|```/g,"").trim());
  }catch(e){ return null; }
}

// ================== CLOUDINARY ==================
function uploadBufferToCloudinary(buffer,folder,name="img"){
  return new Promise((resolve,reject)=>{
    cloudinary.uploader.upload(
      `data:image/jpeg;base64,${buffer.toString("base64")}`,
      {folder,public_id:`${name}-${Date.now()}`},
      (e,r)=>{if(e)reject(e);else resolve(r);}
    );
  });
}

function uploadUrlToCloudinary(url,folder,name="ext-img"){
  return new Promise((resolve,reject)=>{
    cloudinary.uploader.upload(
      url,{folder,public_id:`${name}-${Date.now()}`},
      (e,r)=>{if(e)reject(e);else resolve(r);}
    );
  });
}

function buildThumbs(publicId){
  return {
    low:cloudinary.url(publicId,{secure:true,width:400,crop:"fill",quality:70}),
    med:cloudinary.url(publicId,{secure:true,width:1080,crop:"fill",quality:85})
  };
}

// ================== SHOPIFY ==================
async function fetchProductFromShopify(productId){
  const gid = buildShopifyProductGid(productId);

  const query = `
    query GetProduct($id: ID!) {
      product(id:$id){
        id title productType description
        featuredImage{url}
      }
    }
  `;

  const r = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/api/2024-01/graphql.json`,{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "X-Shopify-Storefront-Access-Token":SHOPIFY_STOREFRONT_TOKEN
    },
    body:JSON.stringify({query,variables:{id:gid}})
  });

  const j = await r.json();
  if(!j.data?.product) throw new Error("ShopifyProductNotFound");

  return {
    id:j.data.product.id,
    title:j.data.product.title,
    productType:j.data.product.productType||"generic",
    img:j.data.product.featuredImage?.url
  };
}

// ================== 🔥 OPENAI VISION (con fallback seguro) ==================
async function analyzeRoomAndProduct({roomImageUrl,productImageUrl,ideaText,productName,productType}){

  logStep("Vision: analizando cuarto + producto...");

  const prompt = `
  Analiza la habitación y determina dónde integrar el producto.
  Devuelve *solo JSON exacto*:

  {
    "imageWidth":number,
    "imageHeight":number,
    "roomStyle":"texto",
    "placement":{"x":n,"y":n,"width":n,"height":n},
    "finalPlacement":{"x":n,"y":n,"width":n,"height":n},
    "product":{"normalizedType":"cuadro"|"lampara"|"otro"}
  }

  Intención:"${ideaText||""}"
  Producto:"${productName||""}" tipo="${productType||""}"
  NO EXPLIQUES — SOLO JSON.
  `;

  try{
    const ai = await openai.responses.create({
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

    const raw = ai.output?.[0]?.content?.find(c=>c.type==="output_text")?.text?.trim();
    const json = safeParseJSON(raw);

    if(!json || !json.finalPlacement){
      logStep("⚠ JSON vacío — fallback usado");
      return {
        imageWidth:1200,imageHeight:800,roomStyle:"neutral",
        placement:{x:420,y:240,width:440,height:360},
        finalPlacement:{x:420,y:240,width:440,height:360},
        product:{normalizedType:"otro"}
      };
    }
    return json;

  }catch(e){
    logStep("❌ Vision error — fallback activado");
    return{
      imageWidth:1200,imageHeight:800,roomStyle:"auto-fallback",
      placement:{x:430,y:250,width:420,height:350},
      finalPlacement:{x:430,y:250,width:420,height:350},
      product:{normalizedType:"otro"}
    };
  }
}

// ================== GENERAR MÁSCARA ==================
async function generateMask(analysis){
  const {imageWidth,imageHeight,finalPlacement:p}=analysis;

  const mask = Buffer.alloc(imageWidth*imageHeight,0);
  for(let y=p.y;y<p.y+p.height;y++){
    for(let x=p.x;x<p.x+p.width;x++){
      mask[y*imageWidth + x]=255;
    }
  }

  return (await sharp(mask,{
    raw:{width:imageWidth,height:imageHeight,channels:1}
  }).png().toBuffer()).toString("base64");
}

// ================== COMPONER PNG PRODUCTO SOBRE HABITACIÓN ==================
async function composeProductOnRoom({roomImageUrl,productImageUrl,placement}){

  const room = Buffer.from(await(await fetch(roomImageUrl)).arrayBuffer());
  const product = Buffer.from(await(await fetch(productImageUrl)).arrayBuffer());

  const resized = await sharp(product).resize({width:placement.width,fit:"contain"}).png().toBuffer();

  const composed = await sharp(room).composite([{input:resized,top:placement.y,left:placement.x}]).jpeg({quality:96}).toBuffer();
  const up = await uploadBufferToCloudinary(composed,"innotiva/composed","room-plus-product");
  return up.secure_url;
}

// ================== COPY EMOCIONAL ==================
function buildCopy(style,name,idea){
  return `Diseñamos esta propuesta pensando en ${style||"tu espacio"}. `
    +`Integrando ${name}, buscamos equilibrio estético y calidez. `
    +(idea?`Se respetó tu idea: "${idea}". `:"")
    +`Así puedes visualizar cómo se vería en tu hogar.`;
}

// ********************************************************************************************
//                                      ENDPOINT PRINCIPAL
// ********************************************************************************************

app.post("/experiencia-premium", upload.single("roomImage"),async(req,res)=>{
  try{
    const {productId,productName,productUrl,idea} = req.body;
    if(!req.file) return res.json({error:"Falta roomImage"});
    if(!productId) return res.json({error:"Falta productId"});

    logStep("Nueva experiencia-premium");

    const upRoom = await uploadBufferToCloudinary(req.file.buffer,"innotiva/rooms","room");
    const userImage = upRoom.secure_url;
    const roomID = upRoom.public_id;

    const product = await fetchProductFromShopify(productId);
    const productImg = product.img;
    if(!productImg) throw new Error("Producto sin imagen en shopify");

    const analysis = await analyzeRoomAndProduct({
      roomImageUrl:userImage,
      productImageUrl:productImg,
      ideaText:idea,productName,productType:product.productType
    });

    const placement = analysis.finalPlacement;
    const composed = await composeProductOnRoom({roomImageUrl:userImage,productImageUrl:productImg,placement});

    const mask = await generateMask(analysis);

    logStep("🔮 Llamando a FLUX INTEGRACIÓN");

    const flux = await fetch(`https://api.replicate.com/v1/models/${REPLICATE_MODEL_SLUG}/predictions`,{
      method:"POST",
      headers:{
        Authorization:`Bearer ${REPLICATE_API_TOKEN}`,
        "Content-Type":"application/json"
      },
      body:JSON.stringify({
        input:{
          image:composed,mask:`data:image/png;base64,${mask}`,
          prompt:`Integra el producto suavizando bordes, sombras y luz. No borres ni reemplaces el producto.`,
          guidance:5.5,num_inference_steps:24,output_format:"webp",megapixels:"1"
        }
      })
    }).then(r=>r.json());

    let status=flux;
    while(status.status!=="succeeded"&&status.status!=="failed"){
      await new Promise(r=>setTimeout(r,1600));
      status = await fetch(`https://api.replicate.com/v1/predictions/${flux.id}`,{
        headers:{Authorization:`Bearer ${REPLICATE_API_TOKEN}`}
      }).then(r=>r.json());
    }
    if(!status.output?.[0]) throw new Error("Flux no generó salida");

    const finalUp = await uploadUrlToCloudinary(status.output[0],"innotiva/generated","room-generated");
    const finalIMG = finalUp.secure_url;

    return res.json({
      ok:true,
      room_image:userImage,
      ai_image:finalIMG,
      product_url:productUrl||null,
      product_name:productName||product.title,
      message:buildCopy(analysis.roomStyle,productName||product.title,idea),
      analysis
    });

  }catch(e){
    console.error("❌ ERROR /experiencia-premium",e);
    res.json({ok:false,error:"Fallo en generación"});
  }
});

// ********************************************************************************************
//                                  REPOSICIÓN MANUAL (CLICK)
// ********************************************************************************************
app.post("/experiencia-premium-reposicion",async(req,res)=>{
  try{
    const {roomImage,ai_image_prev,productId,x,y,width,height,idea} = req.body;
    if(x==null||y==null) return res.json({error:"faltan coordenadas"});
    const base = ai_image_prev||roomImage;

    let ptype="decor";
    try{ptype=(await fetchProductFromShopify(productId)).productType}catch{}

    const analysis={imageWidth:width,imageHeight:height,finalPlacement:{
      x:Math.floor(x-width*0.12),y:Math.floor(y-height*0.12),
      width:Math.floor(width*0.24),height:Math.floor(height*0.24)
    }};

    const m = await generateMask(analysis);

    const call = await fetch(`https://api.replicate.com/v1/models/${REPLICATE_MODEL_SLUG}/predictions`,{
      method:"POST",
      headers:{Authorization:`Bearer ${REPLICATE_API_TOKEN}`,"Content-Type":"application/json"},
      body:JSON.stringify({
        input:{
          image:base,
          mask:`data:image/png;base64,${m}`,
          prompt:`Reubica el producto (${ptype}) manteniendo realismo y cohesión de luz.`,
          guidance:4.6,
          num_inference_steps:20,
          output_format:"webp",
          megapixels:"1"
        }
      })
    }).then(r=>r.json());

    let s=call;
    while(s.status!=="succeeded"&&s.status!=="failed"){
      await new Promise(r=>setTimeout(r,1500));
      s=await fetch(`https://api.replicate.com/v1/predictions/${call.id}`,{
        headers:{Authorization:`Bearer ${REPLICATE_API_TOKEN}`}
      }).then(r=>r.json());
    }

    const up = await uploadUrlToCloudinary(s.output[0],"innotiva/repositions","repo-v2");

    return res.json({ok:true,ai_image:up.secure_url});

  }catch(e){
    return res.json({ok:false,error:"No se pudo reposicionar"});
  }
});

// ================== SERVIDOR ==================
app.listen(PORT,()=>console.log(`⚡ INNOTIVA BACKEND LISTO: http://localhost:${PORT}`));
