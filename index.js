// ===========================================
// BACKEND PRO INNOTIVA – VERSION FINAL 2025
// Con FLUX Inpainting + OpenAI Vision
// ===========================================

require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const sharp = require("sharp");
const crypto = require("crypto");
const OpenAI = require("openai");
const cloudinary = require("cloudinary").v2;

// ---------------------------
// CONFIGURACIÓN BASE
// ---------------------------

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const PORT = process.env.PORT || 10000;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_STOREFRONT_TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN;

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const REPLICATE_MODEL = "black-forest-labs/flux-1-dev-inpainting";

// ---------------------------
// HELPERS
// ---------------------------

function logStep(step, extra = {}) {
  console.log(`[INNOTIVA] ${step}`, Object.keys(extra).length ? extra : "");
}

// Forzar HTTPS siempre
function forceHttps(url) {
  if (!url) return url;
  return url.replace("http://", "https://");
}

// Subir buffer a Cloudinary
async function uploadBufferToCloudinary(buffer, folder, hint = "img") {
  return new Promise((resolve, reject) => {
    const base64 = buffer.toString("base64");
    cloudinary.uploader.upload(
      `data:image/jpeg;base64,${base64}`,
      {
        folder,
        public_id: `${hint}-${Date.now()}`,
        secure: true
      },
      (err, result) => {
        if (err) return reject(err);
        result.secure_url = forceHttps(result.secure_url);
        resolve(result);
      }
    );
  });
}

// Subir URL a Cloudinary
async function uploadUrlToCloudinary(url, folder, hint = "img") {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload(
      forceHttps(url),
      {
        folder,
        public_id: `${hint}-${Date.now()}`,
        secure: true
      },
      (err, result) => {
        if (err) return reject(err);
        result.secure_url = forceHttps(result.secure_url);
        resolve(result);
      }
    );
  });
}

// Construir GID de Shopify
function buildGID(id) {
  if (String(id).startsWith("gid://")) return id;
  return `gid://shopify/Product/${id}`;
}

// Traer producto desde Shopify
async function fetchProductFromShopify(productId) {
  const gid = buildGID(productId);

  const query = `
    query GetProduct($id: ID!) {
      product(id: $id) {
        id
        title
        description
        featuredImage { url }
      }
    }
  `;

  const response = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/api/2024-01/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Storefront-Access-Token": SHOPIFY_STOREFRONT_TOKEN
    },
    body: JSON.stringify({ query, variables: { id: gid } })
  });

  const json = await response.json();

  if (!json.data || !json.data.product) {
    throw new Error("Producto no encontrado en Shopify");
  }

  const p = json.data.product;

  return {
    id: p.id,
    title: p.title,
    description: p.description || "",
    featuredImage: forceHttps(p.featuredImage?.url)
  };
}

// ---------------------------
// OPENAI – EMBEDDING DEL PRODUCTO
// ---------------------------

async function buildProductEmbedding(product) {
  if (!product.featuredImage) return null;

  logStep("OpenAI: embedding del producto", { title: product.title });

  const prompt = `
Analiza únicamente el producto de la imagen y devuélveme:
{
  "colors": [],
  "materials": [],
  "texture": "",
  "pattern": ""
}
SOLO JSON.
`;

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          {
            type: "input_image",
            image_url: forceHttps(product.featuredImage) // ← CORRECTO
          }
        ]
      }
    ]
  });

  const raw = response.output[0].content[0].text;

  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error("Error parseando embedding:", raw);
    return null;
  }
}

// ---------------------------
// OPENAI – ANALISIS DEL CUARTO
// ---------------------------

async function analyzeRoom(roomImageUrl, productImageUrl, productEmbedding, ideaText, productName) {
  logStep("OpenAI: análisis del cuarto");

  const prompt = `
Analiza el estilo del cuarto y define:
{
 "imageWidth": number,
 "imageHeight": number,
 "roomStyle": "string",
 "detectedAnchors": [],
 "placement": {...},
 "conflicts": [],
 "finalPlacement": {...}
}
SOLO JSON.
`;

  const content = [
    { type: "input_text", text: prompt },
    {
      type: "input_image",
      image_url: forceHttps(roomImageUrl)   // ← CORRECTO
    }
  ];

  if (productImageUrl) {
    content.push({
      type: "input_image",
      image_url: forceHttps(productImageUrl)  // ← CORRECTO
    });
  }

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: [{ role: "user", content }]
  });

  const raw = response.output[0].content[0].text;

  try {
    const parsed = JSON.parse(raw);
    if (!parsed.finalPlacement) parsed.finalPlacement = parsed.placement;
    return parsed;
  } catch (e) {
    console.error("Error parseando análisis:", raw);
    throw new Error("No se pudo analizar el cuarto");
  }
}

// ---------------------------
// CREAR MÁSCARA
// ---------------------------

async function createMask(analysis) {
  const { imageWidth, imageHeight, finalPlacement } = analysis;

  const { x, y, width, height } = finalPlacement;
  const mask = Buffer.alloc(imageWidth * imageHeight, 0);

  for (let j = y; j < y + height; j++) {
    for (let i = x; i < x + width; i++) {
      const idx = j * imageWidth + i;
      mask[idx] = 255;
    }
  }

  const png = await sharp(mask, {
    raw: { width: imageWidth, height: imageHeight, channels: 1 }
  })
    .png()
    .toBuffer();

  return png.toString("base64");
}

// ---------------------------
// CALL REPLICATE – FLUX INPAINTING
// ---------------------------

async function callReplicate({ roomImageUrl, maskBase64, productName, productEmbedding }) {
  logStep("Replicate: generando imagen…");

  const prompt = `
NO modifiques la habitación.
NO alteres paredes, muebles, ventanas ni luz.
Solo edita la zona de la máscara.

Inserta el producto ORIGINAL "${productName}" tal cual es:
- forma idéntica
- proporciones reales
- mismos colores
- mismo material

NO interpretes el producto. Usa su aspecto real.
Integración natural y realista.
`;

  const payload = {
    image: forceHttps(roomImageUrl),
    mask: `data:image/png;base64,${maskBase64}`,
    prompt: prompt,
    strength: 1
  };

  const res = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      "Authorization": `Token ${REPLICATE_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      version: REPLICATE_MODEL,
      input: payload
    })
  });

  let json = await res.json();

  while (json.status === "starting" || json.status === "processing") {
    await new Promise(r => setTimeout(r, 2000));

    const poll = await fetch(
      `https://api.replicate.com/v1/predictions/${json.id}`,
      { headers: { "Authorization": `Token ${REPLICATE_API_TOKEN}` } }
    );
    json = await poll.json();
  }

  if (json.status !== "succeeded") {
    console.error("Replicate fail:", json);
    throw new Error("Replicate no generó la imagen.");
  }

  const out = Array.isArray(json.output) ? json.output[0] : json.output;
  return forceHttps(out);
}

// ---------------------------
// COPY EMOCIONAL
// ---------------------------

function buildCopy(roomStyle, productName, idea) {
  let msg = `Creamos esta propuesta respetando el estilo de ${roomStyle}. `;
  msg += `Integramos ${productName} sin alterar tu espacio real. `;
  if (idea) msg += `Consideramos tu idea: "${idea}". `;
  msg += "Así puedes visualizar cómo se vería realmente.";
  return msg;
}

// ---------------------------
// ENDPOINT PRINCIPAL
// ---------------------------

app.post("/experiencia-premium", upload.single("roomImage"), async (req, res) => {
  try {
    logStep("Nueva experiencia-premium recibida");

    const file = req.file;
    const { productId, productName, productUrl, idea } = req.body;

    if (!file) return res.status(400).json({ status: "error", message: "Falta la imagen." });

    // 1) Subir imagen del usuario
    const up = await uploadBufferToCloudinary(file.buffer, "innotiva/rooms", "room");
    const roomImageUrl = up.secure_url;

    // 2) Producto desde Shopify
    const product = await fetchProductFromShopify(productId);
    const finalName = productName || product.title;

    // 3) Recorte PRO del producto (solo para análisis)
    const cut = await uploadUrlToCloudinary(
      forceHttps(product.featuredImage),
      "innotiva/products/raw",
      "product-original"
    );

    const productCutoutUrl = forceHttps(cut.secure_url);

    logStep("Producto recortado", { productCutoutUrl });

    // 4) Embedding
    const embedding = await buildProductEmbedding({
      title: finalName,
      featuredImage: productCutoutUrl
    });

    // 5) Análisis de cuarto
    const analysis = await analyzeRoom(
      roomImageUrl,
      productCutoutUrl,
      embedding,
      idea,
      finalName
    );

    // 6) Crear máscara
    const maskBase64 = await createMask(analysis);

    // 7) Generar con Replicate
    const generatedUrl = await callReplicate({
      roomImageUrl,
      maskBase64,
      productName: finalName,
      productEmbedding: embedding
    });

    // 8) Subir resultado a Cloudinary
    const genUp = await uploadUrlToCloudinary(generatedUrl, "innotiva/generated", "generated");
    const finalGeneratedUrl = forceHttps(genUp.secure_url);

    // 9) Copy emocional
    const message = buildCopy(analysis.roomStyle, finalName, idea);

    // 10) Respuesta final
    const payload = {
      status: "success",
      userImageUrl: roomImageUrl,
      generatedImageUrl: finalGeneratedUrl,
      productUrl,
      productName: finalName,
      message,
      analysis
    };

    logStep("EXPERIENCIA OK");
    return res.json(payload);

  } catch (err) {
    console.error("Error en /experiencia-premium:", err);
    return res.status(500).json({
      status: "error",
      message: "Tuvimos un problema generando tu propuesta. Intenta de nuevo."
    });
  }
});

// ---------------------------
// ARRANQUE SERVIDOR
// ---------------------------

app.listen(PORT, () => {
  console.log(`🚀 INNOTIVA BACKEND PRO escuchando en puerto ${PORT}`);
});

