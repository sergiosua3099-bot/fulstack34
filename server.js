/**************************************************
 INNOTIVA BACKEND — FINAL VERSION
 IA REAL · RUNWARE FLUX IMG2IMG · CLOUDINARY + SHOPIFY

 (Este sí genera imágenes IA — ya con payload correcto en ARRAY)
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
        public_id: `${prefix}_${Date.now()}`,
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
// SHOPIFY PRODUCT FETCH
// ==========================
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || "innotiva-vision.myshopify.com";
const SHOPIFY_STOREFRONT_TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN || "";

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
  }`;

  const headers = { "Content-Type": "application/json" };
  if (SHOPIFY_STOREFRONT_TOKEN) headers["X-Shopify-Storefront-Access-Token"] = SHOPIFY_STOREFRONT_TOKEN;

  const r = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ query }) });
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
  return list.find(e => e.id == id) || null;
}

// ==========================
// IA — RUNWARE FLUX IMG2IMG (FIX REAL)
// ==========================
async function generarImagenIA(roomImageUrl, productName, idea) {

  const prompt = `
  Fotografía realista del MISMO CUARTO.
  Mantener luz, cámara, estética original.
  Integrar el producto "${productName}" de manera natural y proporcionada.
  ${idea?.trim() ? "Indicaciones del usuario: " + idea : "Composición limpia y natural."}
  `;

  try {
    const response = await fetch("https://api.runware.ai/v1/flux-img2img", {
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "Authorization":`Bearer ${process.env.RUNWARE_API_KEY}`
      },
      body: JSON.stringify([
        {                                    // <<<<<< SOLUCIÓN REAL
          image_url: roomImageUrl,
          prompt,
          guidance_scale: 5,
          steps: 22,
          image_size: "normal"
        }
      ])
    });

    const data = await response.json();

    console.log("🔍 RUNWARE RAW RESPONSE:", JSON.stringify(data,null,2));

    const salida = data?.[0]?.output?.[0];
    if(!salida) throw new Error("No output generated");

    return salida; // URL IA final
  }
  catch(err){
    console.error("❌ ERROR FLUX IA:", err);
    return null;
  }
}

// ==========================
// TEXTO PERSONALIZADO
// ==========================
function mensaje(name,idea){
  return `
    Visualizamos **${name}** en tu espacio para ayudarte a decidir con claridad.
    ${idea?.trim() ? `Tomamos en cuenta tu idea: "${idea}".` : "Diseño equilibrado sin instrucciones adicionales."}
  `.trim();
}

// ==========================
// RUTAS
// ==========================
app.get("/", (req,res)=> res.send("Innotiva backend IA — Operativo ✔"));

app.get("/productos-shopify", async (req,res)=>{
  try{ res.json({success:true,products:await getShopifyProducts()}); }
  catch(e){ res.status(500).json({success:false,error:e.message}); }
});

// ==========================
// 🔥 ROUTE PRINCIPAL FLUJO IA
// ==========================
app.post("/experiencia-premium", upload.single("roomImage"), async (req,res)=>{
  console.log("📩 Nueva solicitud /experiencia-premium");
  console.log("🖼 file:", req.file?.mimetype, req.file?.size);
  console.log("📦 body:", req.body);

  try{
    if(!req.file) return res.status(400).json({error:"No llega imagen"});

    const { productId, productName, idea, productUrl } = req.body;

    const urlUser = await uploadBufferToCloudinary(req.file.buffer, "innotiva/rooms","room");
    const urlIA = await generarImagenIA(urlUser, productName, idea);

    return res.json({
      success:true,
      userImageUrl: urlUser,
      generatedImageUrl: urlIA,
      productUrl: productUrl || `https://${SHOPIFY_STORE_DOMAIN}/products/${productId}`,
      productName,
      message: mensaje(productName,idea)
    });
  }
  catch(e){
    console.error(e);
    res.status(500).json({success:false,error:"Error en servidor IA"});
  }
});

// ==========================
// START
// ==========================
app.listen(PORT,()=>console.log("🔥 Backend ONLINE · PUERTO:",PORT));
