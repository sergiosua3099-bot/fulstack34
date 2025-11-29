// =============================================
//   INNOTIVA BACKEND PRO — ESTABLE Y FUNCIONAL
// =============================================

require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const sharp = require("sharp");
const crypto = require("crypto");
const OpenAI = require("openai");
const cloudinary = require("cloudinary").v2;

// fetch en Node 18/20/22
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

// ================== CONFIGURACIÓN ==================

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });
const PORT = process.env.PORT || 10000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const STOREFRONT = process.env.SHOPIFY_STOREFRONT_TOKEN;
const DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const REPLICATE = process.env.REPLICATE_API_TOKEN;
const FLUX = "black-forest-labs/flux-fill-dev";


// ================== LOG FORMATEADO ==================

function log(s, extra=null){
  console.log("🟩 INNOTIVA >>",s, extra? extra:"");
}


// ================== SUBIDA A CLOUDINARY ==================

async function uploadBuffer(buffer,folder,name="img"){
  return new Promise((res,rej)=>{
    cloudinary.uploader.upload(
      `data:image/png;base64,${buffer.toString("base64")}`,
      {folder,public_id:`${name}-${Date.now()}`},
      (e,r)=> e?rej(e):res(r)
    );
  })
}


// ================== FETCH PRODUCTO DESDE SHOPIFY ==================

async function getProduct(id){
  const q = `
    query($id:ID!){
      product(id:$id){
        id title productType
        featuredImage{ url }
      }
    }
  `;

  const r = await fetch(`https://${DOMAIN}/api/2024-01/graphql.json`,{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "X-Shopify-Storefront-Access-Token":STOREFRONT
    },
    body:JSON.stringify({query:q,variables:{id:`gid://shopify/Product/${id}`}})
  });

  const j = await r.json();
  if(!j.data?.product) throw "Producto no encontrado";
  return j.data.product;
}


// ================== ELIMINAR FONDO DEL PRODUCTO ==================

async function removeBG(buffer){
  try{
    return await sharp(buffer)
      .png()
      .removeAlpha()
      .flatten({ background:{r:255,g:255,b:255}})
      .threshold(250)
      .toBuffer();
  }catch{
    return buffer;
  }
}


// ================== COMPOSICIÓN REAL — PNG SOBRE CUARTO ==================

async function compose(roomUrl,productUrl,placement){
  
  const roomBuf = Buffer.from(await (await fetch(roomUrl)).arrayBuffer());
  let prodBuf = Buffer.from(await (await fetch(productUrl)).arrayBuffer());

  prodBuf = await removeBG(prodBuf);

  const meta = await sharp(roomBuf).metadata();

  const resizedProd = await sharp(prodBuf).resize({
    width: Math.floor(meta.width*0.28),
    fit:"contain"
  }).png().toBuffer();

  const merged = await sharp(roomBuf)
    .composite([{input:resizedProd,left:placement.x,top:placement.y}])
    .jpeg({quality:95})
    .toBuffer();

  const up = await uploadBuffer(merged,"innotiva/composed","merge");
  return up.secure_url;
}



// =====================================================
//  🔥 GENERACIÓN PRINCIPAL — /experiencia-premium
// =====================================================

app.post("/experiencia-premium",upload.single("roomImage"), async(req,res)=>{
  try{
    const img = req.file;
    const {productId,idea} = req.body;

    if(!img) return res.json({error:"no room img"});
    if(!productId) return res.json({error:"no productId"});

    // 1) Subimos imagen del usuario
    const roomUp = await uploadBuffer(img.buffer,"innotiva/rooms","room");
    const roomUrl = roomUp.secure_url;

    // 2) Tomamos producto
    const p = await getProduct(productId);
    const productUrl = p.featuredImage;

    // 3) Tamaño real de la imagen
    const meta = await sharp(img.buffer).metadata();
    const W = meta.width;
    const H = meta.height;

    // 4) Definimos colocación estable
    const place={
      x:Math.floor(W*0.33),
      y:Math.floor(H*0.18),
      width:Math.floor(W*0.32),
      height:Math.floor(H*0.32)
    }

    // 5) Componemos PNG primero
    const composed = await compose(roomUrl,productUrl,place);

    // 6) Máscara dinámica
    const mask = Buffer.alloc(W*H,0);
    for(let j=place.y;j<place.y+place.height;j++){
      for(let i=place.x;i<place.x+place.width;i++){
        mask[j*W+i]=255;
      }
    }
    const m = await sharp(mask,{raw:{width:W,height:H,channels:1}}).png().toBuffer();

    // 7) Prompt limpio — solo mejorar integración
    const prompt = `
Integrar el producto en la escena respetando su forma,
color, brillo y sombras reales. No reemplazar el objeto,
solo pulir su integración al ambiente.`;

    // 8) Llamada a replicate
    const start= await fetch(`https://api.replicate.com/v1/models/${FLUX}/predictions`,{
      method:"POST",
      headers:{Authorization:`Bearer ${REPLICATE}`,"Content-Type":"application/json"},
      body:JSON.stringify({
        input:{
          image: composed,
          mask:`data:image/png;base64,${m.toString("base64")}`,
          prompt, guidance:5.4, num_inference_steps:22,
          output_format:"webp",megapixels:"1"
        }
      })
    }).then(r=>r.json());

    let poll=start;
    while(poll.status!=="succeeded" && poll.status!=="failed"){
      await new Promise(r=>setTimeout(r,1800));
      poll=await fetch(`https://api.replicate.com/v1/predictions/${start.id}`,{
        headers:{Authorization:`Bearer ${REPLICATE}`}
      }).then(r=>r.json());
    }

    if(!poll.output?.[0]) throw "Sin salida AI";

    const finalUp = await uploadBuffer(
      Buffer.from(await (await fetch(poll.output[0])).arrayBuffer()),
      "innotiva/generated",
      "final"
    );

    return res.json({
      ok:true,
      room_image:roomUrl,
      ai_image:finalUp.secure_url,
      product:productId,
      idea,
      placement:place
    });

  }catch(e){
    console.log("❌ ERROR:",e);
    return res.json({error:"fail"});
  }
});



// =====================================================
//         🔥 REPOSICIÓN IA — /reposicion
// =====================================================

app.post("/experiencia-premium-reposicion",async(req,res)=>{
  try{
    const {ai_image_prev,x,y}=req.body;
    if(!ai_image_prev) return res.json({error:"no img"});

    const buf = Buffer.from(await (await fetch(ai_image_prev)).arrayBuffer());
    const meta = await sharp(buf).metadata();

    const place={
      x:Math.floor(x-meta.width*0.12),
      y:Math.floor(y-meta.height*0.12),
      width:Math.floor(meta.width*0.24),
      height:Math.floor(meta.height*0.24)
    };

    const mask = Buffer.alloc(meta.width*meta.height,0);
    for(let j=place.y;j<place.y+place.height;j++){
      for(let i=place.x;i<place.x+place.width;i++){
        mask[j*meta.width+i]=255;
      }
    }

    const m= await sharp(mask,{raw:{width:meta.width,height:meta.height,channels:1}}).png().toBuffer();

    const call = await fetch(`https://api.replicate.com/v1/models/${FLUX}/predictions`,{
      method:"POST",
      headers:{Authorization:`Bearer ${REPLICATE}`,"Content-Type":"application/json"},
      body:JSON.stringify({
        input:{
          image:ai_image_prev,
          mask:`data:image/png;base64,${m.toString("base64")}`,
          prompt:"reposicionar suavemente sin borrar producto",
          guidance:4.9, num_inference_steps:18,
          output_format:"webp",megapixels:"1"
        }
      })
    }).then(r=>r.json())

    let poll=call;
    while(poll.status!=="succeeded" && poll.status!=="failed"){
      await new Promise(r=>setTimeout(r,1600));
      poll = await fetch(`https://api.replicate.com/v1/predictions/${call.id}`,{headers:{Authorization:`Bearer ${REPLICATE}`}}).then(r=>r.json());
    }

    const finalUrl=poll?.output?.[0];
    return res.json({ok:true,ai_image:finalUrl});

  }catch(e){
    return res.json({error:"reposicion fail"});
  }
});


// ================== START ==================

app.listen(PORT,()=>console.log(`⚡ INNOTIVA BACKEND LISTO: ${PORT}`));
