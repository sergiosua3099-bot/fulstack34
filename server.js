/**************************************************
 INNOTIVA BACKEND — FLUX IA REAL (RUNWARE FIX)
**************************************************/

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fetch = require("node-fetch");
const cloudinary = require("cloudinary").v2;

// ==========================
// BASE
// ==========================
const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const upload = multer({ storage: multer.memoryStorage() });

console.log("🚀 INNOTIVA — Backend listo para IA REAL FLUX");

// ==========================
// CLOUDINARY
// ==========================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

async function uploadBufferToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      { folder: "innotiva/rooms", resource_type: "image" },
      (err, result) => err ? reject(err) : resolve(result.secure_url)
    ).end(buffer);
  });
}

// ==========================
// SHOPIFY
// ==========================
const SHOPIFY_DOMAIN = "innotiva-vision.myshopify.com";
const SHOPIFY_TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN;

async function getShopifyProducts() {
  const query = `{ products(first:100){edges{node{title handle id}}}}`;

  const res = await fetch(`https://${SHOPIFY_DOMAIN}/api/2024-01/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type":"application/json",
      "X-Shopify-Storefront-Access-Token": SHOPIFY_TOKEN
    },
    body: JSON.stringify({ query })
  });

  const json = await res.json();
  return json.data.products.edges.map(e => ({
    id:e.node.handle,
    name:e.node.title,
    url:`https://${SHOPIFY_DOMAIN}/products/${e.node.handle}`
  }));
}

async function obtenerProducto(id) {
  const list = await getShopifyProducts();
  return list.find(p => String(p.id)===String(id)) || null;
}

// ==========================
// IA REAL FLUX (RUNWARE) 🔥
// ==========================
async function generarImagenIA(roomImageUrl, productName, idea) {

  const prompt = `
  Interior realista del mismo cuarto.
  Producto ${productName} añadido correctamente, con proporción real,
  sombras coherentes, sin deformación del entorno.

  Estilo premium catálogo, iluminación natural.
  Detalle solicitado: ${idea||"composición estética neutra"}
  `;

  console.log("📡 Enviando solicitud RUNWARE...");

  try {
    const response = await fetch("https://api.runware.ai/v1/flux-img2img", {
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "Authorization":`Bearer ${process.env.RUNWARE_API_KEY}`
      },
      body: JSON.stringify([
        {
          image_url: roomImageUrl,
          prompt,
          guidance_scale:5,
          steps:28,
          image_size:"normal"
        }
      ]) // 🔥 ARRAY — FIX CRÍTICO
    });

    const result = await response.json();

    console.log("🔍 RAW RUNWARE:",JSON.stringify(result,null,2));

    const img = result?.[0]?.output?.[0];
    if(!img) throw new Error("Runware no devolvió imagen");

    return img;
  }
  catch(e){
    console.log("❌ ERROR FLUX:",e.message);
    return null;
  }
}

// ==========================
// RUTA MAIN
// ==========================
app.post("/experiencia-premium", upload.single("roomImage"), async (req,res)=>{
  try{
    if(!req.file) return res.status(400).json({error:"Imagen no recibida"});

    const { productId, productName, idea, productUrl } = req.body;

    // 🔍 producto de Shopify
    const p = await obtenerProducto(productId);

    // 📤 subir imagen usuario
    const beforeUrl = await uploadBufferToCloudinary(req.file.buffer);

    // 🔥 generar AFTER real
    const afterUrl = await generarImagenIA(beforeUrl, productName, idea);

    if(!afterUrl) return res.status(500).json({success:false, error:"IA no respondió"});

    return res.json({
      success:true,
      message:`Así se vería "${productName}" en tu espacio 🏡✨`,
      userImageUrl: beforeUrl,
      generatedImageUrl: afterUrl,
      productName,
      productUrl: productUrl || p?.url
    });

  }catch(e){
    console.log("💥 ERROR /experiencia-premium:",e.message);
    res.status(500).json({success:false,error:"Fallo interno"});
  }
});

// ==========================
app.listen(PORT,()=>console.log(`🔥 RUNWARE ACTIVE — URL READY`));
