/**************************************************
 INNOTIVA BACKEND — FLUX 1.1 PRO ✨
 Ultra Real Interior Rendering for E-Commerce Decor
**************************************************/

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fetch = require("node-fetch");
const cloudinary = require("cloudinary").v2;

// ======================================================
//  APP BASE
// ======================================================
const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended:true }));

const upload = multer({ storage: multer.memoryStorage() });

// ======================================================
//  CLOUDINARY STORAGE
// ======================================================
cloudinary.config({
  cloud_name : process.env.CLOUDINARY_CLOUD_NAME,
  api_key    : process.env.CLOUDINARY_API_KEY,
  api_secret : process.env.CLOUDINARY_API_SECRET,
});

async function uploadCloudinary(buffer){
  return new Promise((resolve,reject)=>{
    cloudinary.uploader.upload_stream(
      { folder:"innotiva/rooms", resource_type:"image" },
      (err,res)=> err ? reject(err) : resolve(res.secure_url)
    ).end(buffer);
  });
}

// ======================================================
//  SHOPIFY PRODUCT DATA
// ======================================================
const SHOPIFY_STORE = process.env.SHOPIFY_STORE_DOMAIN || "innotiva-vision.myshopify.com";
const TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN || "";

async function fetchProductData(productId){
  const query = `
  {
    product(handle:"${productId}") {
      title
      description
      images(first:1){edges{node{url}}}
    }
  }`;

  const r = await fetch(`https://${SHOPIFY_STORE}/api/2024-01/graphql.json`,{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      ...(TOKEN && { "X-Shopify-Storefront-Access-Token": TOKEN })
    },
    body:JSON.stringify({ query })
  });

  const j = await r.json();
  return j.data?.product || null;
}

// ======================================================
//  IA — FLUX 1.1 PRO ULTRA-REALISTIC PROMPT
// ======================================================

async function generarImagenIA(originalURL, productName, ideaUser){

const prompt = `
Realistic interior render. Maintain ORIGINAL room architecture, walls, surfaces, reflections,
objects, lighting, shadow directions, color temperature and furniture placement.

Insert product: "${productName}" into the room with real-world scale.
It must look physically installed, not floating, not pasted.

📌 Requirements (strict):
- keep same camera POV
- correct perspective & vanishing points
- proportional scale to bed/sofa/objects
- soft global shadows, AO contact with wall
- NO hallucinated windows, sofas or furniture
- NO destroying existing decoration unless necessary

📌 Professional composition:
- clean aesthetics, premium editorial look
- subtle depth of field & natural grain
- avoid distortions, oversharpen or cartoonish style
- consistent color harmony with original room palette
- glossy reflections only if contextually correct

User instruction influence (40% weight):
"${ideaUser || "Place naturally where visually improves composition"}"

Final output must look like a REAL photograph taken with a Sony A7R — 
warm cinematic lighting, museum-grade minimalism, design magazine finish.
`.trim();

console.log("🧠 PROMPT ENVIADO A FLUX:\n", prompt,"\n");

// ===== FLUX 1.1 PRO REQUEST =====
try{
  const response = await fetch(
    `https://api.replicate.com/v1/models/black-forest-labs/flux-pro-1.1/predictions`,
    {
      method:"POST",
      headers:{
        "Authorization":`Bearer ${process.env.REPLICATE_API_KEY}`,
        "Content-Type":"application/json"
      },
      body:JSON.stringify({
        input:{
          image: originalURL,
          prompt,
          guidance:6,
          megapixels: "1",              // alta calidad sin tardar años
          num_inference_steps:28,
          output_format:"png",
          disable_safety_checker:true
        }
      })
    }
  ).then(r=>r.json());

  if(!response.output || !response.output[0]) throw new Error("⚠ No image generated");
  return response.output[0];

}catch(err){
  console.log("❌ ERROR IA:", err);
  return "https://via.placeholder.com/1000x700?text=IA+FAILED";
}

}

// ======================================================
//  ENDPOINT PRINCIPAL
// ======================================================
app.post("/experiencia-premium", upload.single("roomImage"), async (req,res)=>{
try{
  console.log("📩 Nueva request /experiencia-premium");

  if(!req.file) return res.status(400).json({error:"No image received"});

  const { productId, productName, idea, productUrl } = req.body;

  const productInfo = await fetchProductData(productId);
  const before = await uploadCloudinary(req.file.buffer);
  const after  = await generarImagenIA(before,productName,idea);

  return res.json({
    success:true,
    message:"Render generado exitosamente.",
    userImageUrl:before,
    generatedImageUrl:after,
    productName,
    productUrl: productUrl || `https://${SHOPIFY_STORE}/products/${productId}`,
    productDetails: productInfo?.description
  });

}catch(err){
  return res.status(500).json({error:"PROCESS_FAILED"});
}
});

// ======================================================
//  START SERVER
// ======================================================
app.listen(PORT,()=>console.log(`🔥 BACKEND IA ONLINE — PORT: ${PORT}`));
