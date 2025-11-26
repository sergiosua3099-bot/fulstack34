/**************************************************
 INNOTIVA BACKEND — VERSION B (Balanced Quality)
 FLUX IA integrado
**************************************************/

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fetch = require("node-fetch");
const cloudinary = require("cloudinary").v2;

// ==========================
// BASE APP
// ==========================
const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const upload = multer({ storage: multer.memoryStorage() });

// ==========================
// CLOUDINARY
// ==========================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

async function uploadBufferToCloudinary(buffer, folder, prefix) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: folder || "innotiva",
        public_id: `${prefix || "img"}_${Date.now()}`,
        resource_type: "image",
      },
      (err, result) => {
        if (err) return reject(err);
        return resolve(result.secure_url);
      }
    );
    stream.end(buffer);
  });
}

// ==========================
// SHOPIFY
// ==========================
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || "innotiva-vision.myshopify.com";
const SHOPIFY_STOREFRONT_TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN || "";

// obtiene productos con imágenes y título
async function getShopifyProducts() {
  const endpoint = `https://${SHOPIFY_STORE_DOMAIN}/api/2024-01/graphql.json`;

  const query = `
    {
      products(first: 80) {
        edges {
          node {
            title handle
            images(first: 1){edges{node{url}}}
          }
        }
      }
    }
  `;

  const headers = { "Content-Type": "application/json" };
  if (SHOPIFY_STOREFRONT_TOKEN) headers["X-Shopify-Storefront-Access-Token"] = SHOPIFY_STOREFRONT_TOKEN;

  const r = await fetch(endpoint, {
    method: "POST",
    headers, body: JSON.stringify({ query })
  });
  const json = await r.json();

  return json.data.products.edges.map(e => ({
    id: e.node.handle,
    title: e.node.title,
    handle: e.node.handle,
    image: e.node.images.edges[0]?.node.url
  }));
}

async function obtenerProductoPorId(id) {
  const list = await getShopifyProducts();
  return list.find(e => String(e.id) === String(id)) || null;
}

// ==========================
// IA — FLUX  Balanced Mode
// ==========================
async function generarImagenIA(roomImageUrl, productName, idea) {

  const prompt = `
  Interior realista del MISMO CUARTO de referencia.
  Mantener cámara, paredes, luz y muebles.

  Agregar producto decorativo "${productName}" en ubicación natural.
  Integrar con sombras correctas, proporción real, estilo limpio.

  Extra indicación del usuario:
  ${idea?.trim() || "Sin indicación especial, composición equilibrada."}

  Render final fotográfico estilo catálogo premium.
  `;

  try {
    const result = await fetch("https://api.runware.ai/v1/flux-img2img", {
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "Authorization":`Bearer ${process.env.RUNWARE_API_KEY}`
      },
      body:JSON.stringify({
        image_url: roomImageUrl,
        prompt,
        guidance_scale:5,
        steps:20,
        image_size:"normal"   // B = Balanced performance
      })
    }).then(r=>r.json());

    const out = result.output?.[0];
    if(!out) throw new Error("No output received");

    return out; // URL final
  }
  catch(err){
    console.error("❌ FLUX ERROR:",err);
    return "https://via.placeholder.com/1024x1024?text=FLUX+Error";
  }
}

// ==========================
// Mensaje descripción IA
// ==========================
function generarMensajePersonalizado(name,idea){
  return `
    Hemos integrado **${name}** visualmente en tu espacio para ayudarte a
    previsualizar cómo se vería antes de comprar.
    ${idea?.trim()?`Consideramos tu indicación: "${idea}".`:"Aplicamos una composición limpia y balanceada."}
  `.trim();
}

// ==========================
// RUTAS
// ==========================
app.get("/", (req,res)=>res.send("INNOTIVA — Backend Flux Balanced Running ✔"));

app.get("/productos-shopify", async (req,res)=>{
  try{ res.json({success:true,products:await getShopifyProducts()}); }
  catch(e){ res.status(500).json({success:false,error:e.message}); }
});

// ==========================
// MAIN ROUTE — IA ROOM
// ==========================
app.post("/experiencia-premium", upload.single("roomImage"), async (req,res)=>{
  try{
    if(!req.file) return res.status(400).json({error:"No llega imagen"});

    const { productId, productName, idea, productUrl } = req.body;

    const product = await obtenerProductoPorId(productId);
    const userImageUrl = await uploadBufferToCloudinary(req.file.buffer,"innotiva/rooms","room");
    const generatedImageUrl = await generarImagenIA(userImageUrl,productName,idea);

    res.json({
      success:true,
      message: generarMensajePersonalizado(productName,idea),
      userImageUrl,
      generatedImageUrl,
      productUrl: productUrl || `https://${SHOPIFY_STORE_DOMAIN}/products/${productId}`,
      productName
    })
  }
  catch(err){
    res.status(500).json({success:false,error:"Error en flujo IA"});
  }
});

// ==========================
// LAUNCH
// ==========================
app.listen(PORT,()=>console.log("🔥 Backend ONLINE · PUERTO:",PORT));
