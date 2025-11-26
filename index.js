// ============================
// INNOTIVA BACKEND PRO
// FLUJO PREMIUM IA + SHOPIFY
// SDXL-INPAINTING + OPENAI + CLOUDINARY
// ============================

require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const sharp = require("sharp");
const crypto = require("crypto");
const OpenAI = require("openai");
const cloudinary = require("cloudinary").v2;
const fetch = require("node-fetch");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const PORT = process.env.PORT || 10000;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_STOREFRONT_TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN;

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const REPLICATE_MODEL = "stability-ai/stable-diffusion-xl-inpainting-0.1";

// ----------------------------
// HELPERS
// ----------------------------
function logStep(step, extra = {}) {
  console.log(`[INNOTIVA] ${step}`, Object.keys(extra).length ? extra : "");
}

async function uploadBuffer(buffer, folder, name = "img") {
  return cloudinary.uploader.upload(`data:image/jpeg;base64,${buffer.toString("base64")}`, {
    folder,
    public_id: `${name}-${Date.now()}`,
  });
}

async function uploadUrl(url, folder, name = "upload") {
  return cloudinary.uploader.upload(url, {
    folder,
    public_id: `${name}-${Date.now()}`,
  });
}

function buildShopifyGID(id) {
  if (String(id).startsWith("gid://")) return id;
  return `gid://shopify/Product/${id}`;
}

// ----------------------------
// SHOPIFY HELPERS
// ----------------------------
async function fetchProductFromShopify(productId) {
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
      "X-Shopify-Storefront-Access-Token": SHOPIFY_STOREFRONT_TOKEN,
    },
    body: JSON.stringify({ query, variables: { id: buildShopifyGID(productId) } }),
  });

  const json = await response.json();

  if (json.errors || !json.data?.product) {
    throw new Error("Shopify no devolvió un producto");
  }

  return json.data.product;
}

// ----------------------------
// OPENAI – PRODUCT EMBEDDING
// ----------------------------
async function buildProductEmbedding(url, title) {
  logStep("OpenAI: embedding del producto", { title });

  const prompt = `
Extrae SOLO un JSON válido con:
{
  "colors": ["..."],
  "materials": ["..."],
  "texture": "string",
  "pattern": "string"
}
Nada más.
`;

  const result = await openai.responses.create({
    model: "gpt-4o-mini",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: url },
        ],
      },
    ],
  });

  const raw = result.output_text || result.output?.[0]?.content?.[0]?.text || "";

  let clean = raw
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();

  try {
    return JSON.parse(clean);
  } catch (e) {
    console.error("Error parseando embedding:", raw);
    return null;
  }
}

// ----------------------------
// OPENAI – ROOM ANALYSIS
// ----------------------------
async function analyzeRoom(roomUrl, productUrl, productName, idea) {
  logStep("OpenAI: análisis del cuarto");

  const prompt = `
Devuelve SOLO un JSON válido con:
{
  "imageWidth": number,
  "imageHeight": number,
  "placement": { "x": number, "y": number, "width": number, "height": number }
}

La zona debe ser EXACTAMENTE donde debe ir el producto "${productName}".
Respeta lo que el cliente dijo: "${idea || ""}".
`;

  const result = await openai.responses.create({
    model: "gpt-4o-mini",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: roomUrl },
          { type: "input_image", image_url: productUrl },
        ],
      },
    ],
  });

  const raw = result.output_text || result.output?.[0]?.content?.[0]?.text || "";

  let clean = raw
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch (e) {
    console.error("Error parseando análisis:", raw);
    throw new Error("No se pudo analizar el cuarto");
  }

  return parsed;
}

// ----------------------------
// MASK BUILDER
// ----------------------------
async function buildMask(analysis) {
  const { imageWidth, imageHeight, placement } = analysis;
  const mask = Buffer.alloc(imageWidth * imageHeight, 0);

  const { x, y, width, height } = placement;

  for (let j = y; j < y + height; j++) {
    for (let i = x; i < x + width; i++) {
      if (i >= 0 && j >= 0 && i < imageWidth && j < imageHeight) {
        mask[j * imageWidth + i] = 255;
      }
    }
  }

  return sharp(mask, {
    raw: { width: imageWidth, height: imageHeight, channels: 1 },
  }).png().toBuffer();
}

// ----------------------------
// REPLICATE INPAINTING
// ----------------------------
async function runReplicate(roomUrl, maskBase64, prompt) {
  logStep("Replicate: generando imagen…");

  const response = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      Authorization: `Token ${REPLICATE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      version: REPLICATE_MODEL,
      input: {
        image: roomUrl,
        mask: `data:image/png;base64,${maskBase64}`,
        prompt,
      },
    }),
  });

  const json = await response.json();

  if (json.error) {
    console.error("Replicate error:", json);
    throw new Error("Replicate no pudo generar imagen");
  }

  // Polling
  let prediction = json;
  while (prediction.status === "starting" || prediction.status === "processing") {
    await new Promise((r) => setTimeout(r, 2500));
    const poll = await fetch(`https://api.replicate.com/v1/predictions/${json.id}`, {
      headers: { Authorization: `Token ${REPLICATE_API_TOKEN}` },
    });
    prediction = await poll.json();
  }

  if (prediction.status !== "succeeded") {
    console.error("Replicate final:", prediction);
    throw new Error("Replicate falló");
  }

  return prediction.output?.[0] || null;
}

// ----------------------------
// COPY EMOCIONAL
// ----------------------------
function buildCopy(productName, idea) {
  let txt = `Integramos ${productName} en tu espacio visualizando cómo aportaría estilo y armonía.`;
  if (idea) txt += ` Tomamos en cuenta tu idea: "${idea}".`;
  return txt;
}

// ----------------------------
// ENDPOINT PRINCIPAL
// ----------------------------
app.post("/experiencia-premium", upload.single("roomImage"), async (req, res) => {
  const start = Date.now();
  try {
    logStep("Nueva experiencia-premium recibida");

    const { productId, productName: clientName, idea } = req.body;
    if (!req.file) return res.status(400).json({ error: "Falta imagen" });

    // 1) Subir foto del cuarto
    const roomUpload = await uploadBuffer(
      req.file.buffer,
      "innotiva/rooms",
      "room"
    );
    const roomUrl = roomUpload.secure_url;

    // 2) Producto desde Shopify
    const product = await fetchProductFromShopify(productId);
    const realProductName = clientName || product.title;
    const productImageUrl = product.featuredImage?.url;

    if (!productImageUrl) throw new Error("El producto no tiene imagen");

    // 3) Embedding del producto
    const embedding = await buildProductEmbedding(productImageUrl, realProductName);

    // 4) Análisis del cuarto
    const analysis = await analyzeRoom(roomUrl, productImageUrl, realProductName, idea);

    // 5) Máscara
    const mask = await buildMask(analysis);
    const maskBase64 = mask.toString("base64");

    // 6) Prompt para Replicate
    const replicatePrompt = `
Inserta "${realProductName}" exactamente en el área seleccionada.
Respeta completamente la habitación, iluminación y estilo.
Producto: ${realProductName}
Detalles: ${JSON.stringify(embedding)}
`;

    // 7) Llamar a Replicate
    const generatedUrl = await runReplicate(
      roomUrl,
      maskBase64,
      replicatePrompt
    );

    if (!generatedUrl) throw new Error("Replicate no devolvió imagen");

    // 8) Subir resultado final a Cloudinary
    const genUpload = await uploadUrl(
      generatedUrl,
      "innotiva/generated",
      "generated"
    );

    const resultUrl = genUpload.secure_url;

    // 9) Mensaje
    const message = buildCopy(realProductName, idea);

    // 10) Respuesta final
    res.json({
      status: "success",
      sessionId: crypto.randomUUID(),
      userImageUrl: roomUrl,
      generatedImageUrl: resultUrl,
      productName: realProductName,
      message,
      analysis,
      embedding,
      elapsedMs: Date.now() - start,
    });

  } catch (err) {
    console.error("Error en /experiencia-premium:", err);
    res.status(500).json({
      status: "error",
      message: "Hubo un problema generando tu propuesta.",
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 INNOTIVA BACKEND PRO escuchando en puerto ${PORT}`);
});
