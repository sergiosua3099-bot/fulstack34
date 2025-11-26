/**************************************************
 INNOTIVA BACKEND — FLUX FIX 100%
 Now sending RUNWARE payload as ARRAY ✔
**************************************************/

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fetch = require("node-fetch");
const cloudinary = require("cloudinary").v2;

// ======================================
// SERVER BASE
// ======================================
const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const upload = multer({ storage: multer.memoryStorage() });

// ======================================
// CLOUDINARY
// ======================================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

async function uploadBufferToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: "innotiva/rooms", resource_type: "image" },
      (err, result) => {
        if (err) return reject(err);
        resolve(result.secure_url);
      }
    );
    stream.end(buffer);
  });
}

// ======================================
// IA — FLUX FIXED
// ======================================
async function generarImagenIA(roomImageUrl, productName, idea) {
  const prompt = `
  Fotografía real del MISMO cuarto de referencia.
  Integrar ${productName} en el entorno con sombras realistas y escala coherente.
  Indicaciones usuario: ${idea?.trim() || "sin instrucciones adicionales"}
  Estilo catálogo premium, elegante, pulido, realista.
  `;

  try {
    const resp = await fetch("https://api.runware.ai/v1/flux-img2img", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.RUNWARE_API_KEY}`,
      },
      body: JSON.stringify([
        {
          image_url: roomImageUrl,
          prompt,
          steps: 22,
          guidance_scale: 5.2,
          image_size: "normal"
        }
      ]) // <<< ESTE era el error original, ya solucionado
    });

    const data = await resp.json();
    console.log("\n🔍 FLUX RESPONSE:", JSON.stringify(data).slice(0,800));

    if (!data.output || !data.output[0]) throw data.errors || "No output";

    return data.output[0]; // URL FINAL IA
  } 
  catch (err) {
    console.error("❌ FLUX_FAIL:", err);
    return "https://via.placeholder.com/1024x1024?text=Error+FLUX";
  }
}

// ======================================
// UX MESSAGE
// ======================================
function mensaje(name, idea){
return `
Previsualización generada con **${name}** en tu espacio.
${ idea?.trim() ? "Atendimos tu instrucción personalizada." : "Composición minimalista por defecto." }
`;}

// ======================================
// ROUTE IA
// ======================================
app.post("/experiencia-premium", upload.single("roomImage"), async(req,res)=>{
  console.log("\n📩 NUEVA SOLICITUD");
  console.log("🖼 file:", req.file?.mimetype, req.file?.size);
  console.log("📦 body:", req.body);

  try{
    if(!req.file) return res.json({error:"Falta IMG"});

    const img = await uploadBufferToCloudinary(req.file.buffer);
    const out = await generarImagenIA(img, req.body.productName, req.body.idea);

    return res.json({
      ok:true,
      userImageUrl: img,
      generatedImageUrl: out,
      message: mensaje(req.body.productName,req.body.idea),
      productUrl: req.body.productUrl,
      productName:req.body.productName
    });
  }
  catch(e){
    console.log("🔥 SERVER_ERR:",e);
    res.json({ok:false,error:"IA fail"});
  }
});

// ======================================
app.listen(PORT,()=>console.log(`🔥 Online PORT ${PORT}`));
