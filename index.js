// ======================================================
// INNOTIVA BACKEND PRO - VERSION ESTABLE REP 2025
// ======================================================

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import multer from "multer";
import FormData from "form-data";
import OpenAI from "openai";
import dotenv from "dotenv";
import { v2 as cloudinary } from "cloudinary";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

// ================= CLOUDINARY ==========================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ================= OPENAI ==========================
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ============= MULTER PARA FORM FILES ================
const upload = multer({ storage: multer.memoryStorage() });

// ======================================================
//                 FUNCIONES AUXILIARES
// ======================================================

// ---------- SUBE IMAGEN A CLOUDINARY ----------
async function uploadToCloudinary(buffer, folder, filename) {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      {
        folder,
        public_id: filename,
        resource_type: "image"
      },
      (err, result) => {
        if (err) return reject(err);
        resolve(result.secure_url);
      }
    ).end(buffer);
  });
}


// ---------- RECORTAR PRODUCTO (CUTOUT) ----------
async function smartProductCutout(urlOriginal) {
  const result = await cloudinary.uploader.upload(urlOriginal, {
    folder: "innotiva/products/raw",
    remove_background: "cloudinary_ai",  
    crop: "fill",
    quality: "auto",
    width: 1024,
    height: 1024  
  });

  return result.secure_url;
}


// ---------- EMBEDDING DEL PRODUCTO ----------
async function buildProductEmbedding(title, imageUrl) {
  const prompt = `
Analiza únicamente el producto en la imagen y devuélveme SOLO un JSON puro (sin texto externo).
Debe contener:
{
  "colors": [...],
  "materials": [...],
  "texture": "",
  "style": "",
  "shape": "",
  "dominant_elements": []
}
`;

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: imageUrl }
        ]
      }
    ]
  });

  const text = response.output[0].content[0].text.trim();
  return JSON.parse(text);
}


// ---------- ANALISIS DEL CUARTO ----------
async function analyzeRoom(roomUrl) {
  const prompt = `
Analiza la habitación. Devuelve SOLO JSON con:
{
  "imageWidth": ...,
  "imageHeight": ...,
  "roomStyle": "",
  "detectedAnchors": [],
  "placement": {},
  "finalPlacement": {}
}
`;

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: roomUrl }
        ]
      }
    ]
  });

  const text = response.output[0].content[0].text.trim();
  return JSON.parse(text);
}


// ======================================================
//                  REPICATE (API NUEVA)
// ======================================================

async function runReplicateInpainting(roomUrl, productCutoutUrl, productEmbedding, roomData) {
  
  const BODY = {
    model: process.env.REPLICATE_FLUX_MODEL_ID,
    input: {
      image: roomUrl,
      mask: productCutoutUrl,
      prompt: `
Insertar el producto de manera natural.
Características del producto:
${JSON.stringify(productEmbedding)}

Características del cuarto:
${JSON.stringify(roomData)}

Instrucción final: respeta completamente el ambiente, luz, sombras y estilo. El producto debe aparecer correctamente integrado.
`
    }
  };

  const response = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.REPLICATE_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(BODY)
  });

  const json = await response.json();

  if (!response.ok) {
    console.log("Replicate error:", json);
    throw new Error("Replicate fallo");
  }

  // Polling until completed
  let final = json;

  while (final.status !== "succeeded" && final.status !== "failed") {
    await new Promise(r => setTimeout(r, 1800));

    const check = await fetch(`https://api.replicate.com/v1/predictions/${json.id}`, {
      headers: { 
        "Authorization": `Bearer ${process.env.REPLICATE_API_TOKEN}`
      }
    });

    final = await check.json();
  }

  if (final.status === "failed") {
    throw new Error("Replicate no generó imagen");
  }

  return final.output[0];
}


// ======================================================
//           ENDPOINT PRINCIPAL EXPERIENCIA PREMIUM
// ======================================================

app.post("/experiencia-premium", upload.single("room_image"), async (req, res) => {
  try {
    console.log("[INNOTIVA] Nueva experiencia-premium recibida");

    const { title } = req.body;
    const roomBuffer = req.file.buffer;

    // 1) Subir la imagen del cuarto
    const roomImageUrl = await uploadToCloudinary(roomBuffer, "innotiva/rooms", `room-${Date.now()}`);

    console.log("[INNOTIVA] Imagen del usuario subida a Cloudinary", {
      roomImageUrl
    });

    // 2) Recorte PRO del producto
    const productCutoutUrl = await smartProductCutout(req.body.product_image);
    console.log("[INNOTIVA] Producto recortado", {
      productCutoutUrl
    });

    // 3) Embedding del producto
    const productEmbedding = await buildProductEmbedding(title, productCutoutUrl);
    console.log("[INNOTIVA] OpenAI: embedding del producto", productEmbedding);

    // 4) Análisis del cuarto
    const roomData = await analyzeRoom(roomImageUrl);
    console.log("[INNOTIVA] OpenAI: análisis del cuarto", roomData);

    // 5) Llamado a Replicate (API nueva)
    console.log("[INNOTIVA] Replicate: generando imagen...");
    const generatedImage = await runReplicateInpainting(
      roomImageUrl,
      productCutoutUrl,
      productEmbedding,
      roomData
    );

    console.log("[INNOTIVA] EXPERIENCIA GENERADA OK");

    res.json({
      ok: true,
      before: roomImageUrl,
      after: generatedImage,
      productCutout: productCutoutUrl
    });

  } catch (error) {
    console.error("Error en /experiencia-premium:", error);
    res.status(500).json({
      ok: false,
      message: error.message
    });
  }
});


// ======================================================
//                  SERVIDOR EXPRESS
// ======================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 INNOTIVA BACKEND PRO escuchando en puerto ${PORT}`);
});
