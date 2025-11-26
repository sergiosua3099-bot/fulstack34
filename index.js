// index.js
// Backend PRO Innotiva - /experiencia-premium
// Usa: Cloudinary, Shopify, OpenAI Vision, Replicate

require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const sharp = require("sharp");
const crypto = require("crypto");
const OpenAI = require("openai");
const cloudinary = require("cloudinary").v2;

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
const REPLICATE_DEFAULT_MODEL = process.env.REPLICATE_FLUX_MODEL_ID;

// ======================= MIDDLEWARE =======================

app.use(cors());
app.use(express.json());

// Healthcheck
app.get("/", (req, res) => res.send("INNOTIVA BACKEND PRO funcionando ✅"));
app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ======================= HELPERS =======================

function logStep(step, extra = {}) {
  console.log(`[INNOTIVA] ${step}`, Object.keys(extra).length ? extra : "");
}

function buildShopifyProductGid(id) {
  if (String(id).startsWith("gid://")) return id;
  return `gid://shopify/Product/${id}`;
}

// 🔥 FUNCION CRÍTICA: normalizar URLs de imagen (string u objeto)
function normalizeImageUrl(img) {
  if (!img) return null;
  if (typeof img === "string") return img;
  if (typeof img === "object") return img.url || img.src || img.originalSrc || null;
  return null;
}

// ======================= CLOUDINARY =======================

async function uploadBufferToCloudinary(buffer, folder, filenameHint = "image") {
  return new Promise((resolve, reject) => {
    const base64 = buffer.toString("base64");
    cloudinary.uploader.upload(
      `data:image/jpeg;base64,${base64}`,
      { folder, public_id: `${filenameHint}-${Date.now()}` },
      (err, result) => (err ? reject(err) : resolve(result))
    );
  });
}

async function uploadUrlToCloudinary(url, folder, filenameHint = "image-from-url") {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload(
      url,
      { folder, public_id: `${filenameHint}-${Date.now()}` },
      (err, result) => (err ? reject(err) : resolve(result))
    );
  });
}

function buildThumbnails(publicId) {
  return {
    low: cloudinary.url(publicId, { width: 400, height: 400, crop: "fill", quality: 70 }),
    medium: cloudinary.url(publicId, { width: 1080, height: 1080, crop: "fill", quality: 80 })
  };
}

// ======================= SHOPIFY =======================

async function fetchProductFromShopify(productId) {
  const gid = buildShopifyProductGid(productId);

  const query = `
    query GetProduct($id: ID!) {
      product(id: $id) {
        id
        title
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
    console.error("Shopify error:", json);
    throw new Error("No se pudo obtener el producto desde Shopify");
  }

  const p = json.data.product;

  return {
    id: p.id,
    title: p.title,
    featuredImage: normalizeImageUrl(p.featuredImage)
  };
}

// ======================= OPENAI — Embedding Producto =======================

async function buildProductEmbedding(product) {
  const url = normalizeImageUrl(product.featuredImage);

  if (!url) return null;

  logStep("OpenAI: embedding visual del producto", { productTitle: product.title });

  const prompt = `
Analiza SOLO el producto en la imagen.
Devuélveme JSON exacto:
{
  "colors": [],
  "materials": [],
  "texture": "",
  "pattern": ""
}`;

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: url }   // 🔥 FIX
        ]
      }
    ]
  });

  const raw =
    response.output?.[0]?.content?.[0]?.text ||
    response.output?.[0]?.content?.[0]?.content ||
    "";

  try {
    return JSON.parse(raw);
  } catch {
    console.error("Error parseando embedding:", raw);
    return null;
  }
}

// ======================= OPENAI — Análisis del Cuarto + Colocación =======================

async function analyzeRoomAndPlacement({ roomImageUrl, productImageUrl, productEmbedding, ideaText, productName }) {
  const roomUrl = normalizeImageUrl(roomImageUrl);
  const productUrl = normalizeImageUrl(productImageUrl);

  if (!roomUrl) throw new Error("roomImageUrl inválida.");
  if (!productUrl) throw new Error("productImageUrl inválida.");

  logStep("OpenAI: análisis de cuarto");

  const prompt = `
Genera análisis del cuarto + posicionamiento del producto.
Devuelve JSON exacto:
{
  "imageWidth": number,
  "imageHeight": number,
  "roomStyle": "",
  "detectedAnchors": [],
  "placement": {"x":0,"y":0,"width":0,"height":0},
  "conflicts": [],
  "finalPlacement": {"x":0,"y":0,"width":0,"height":0}
}`;

  const input = [
    { type: "input_text", text: prompt },
    { type: "input_image", image_url: roomUrl },
    { type: "input_image", image_url: productUrl }
  ];

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: [{ role: "user", content: input }]
  });

  const raw =
    response.output?.[0]?.content?.[0]?.text ||
    response.output?.[0]?.content?.[0]?.content ||
    "";

  let analysis = {};
  try {
    analysis = JSON.parse(raw);
  } catch {
    console.error("Error parseando análisis:", raw);
    throw new Error("Error analizando cuarto.");
  }

  if (!analysis.finalPlacement) analysis.finalPlacement = analysis.placement;
  if (!Array.isArray(analysis.detectedAnchors)) analysis.detectedAnchors = [];
  if (!Array.isArray(analysis.conflicts)) analysis.conflicts = [];

  return analysis;
}

// ======================= MÁSCARA =======================

async function createMaskFromAnalysis(analysis) {
  const { imageWidth, imageHeight, finalPlacement } = analysis;

  if (!imageWidth || !imageHeight || !finalPlacement) {
    throw new Error("Datos insuficientes para crear máscara.");
  }

  const { x, y, width, height } = finalPlacement;

  const w = Math.max(1, Math.round(imageWidth));
  const h = Math.max(1, Math.round(imageHeight));
  const mask = Buffer.alloc(w * h, 0);

  for (let j = y; j < y + height; j++) {
    for (let i = x; i < x + width; i++) {
      if (i >= 0 && i < w && j >= 0 && j < h) {
        mask[j * w + i] = 255;
      }
    }
  }

  const png = await sharp(mask, { raw: { width: w, height: h, channels: 1 } })
    .png()
    .toBuffer();

  return png.toString("base64");
}

// ======================= REPLICATE =======================

async function callReplicateWithProduct({ roomImageUrl, productImageUrl, maskBase64, productEmbedding, analysis, productName }) {
  logStep("Replicate: generando imagen…");

  const prompt = `
Integra el producto ${productName}.
Respeta iluminación, perspectiva y estilo: ${analysis.roomStyle}.
${productEmbedding ? JSON.stringify(productEmbedding) : ""}
`;

  const response = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      "Authorization": `Token ${REPLICATE_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      version: REPLICATE_DEFAULT_MODEL,
      input: {
        image: roomImageUrl,
        mask: `data:image/png;base64,${maskBase64}`,
        prompt
      }
    })
  });

  let prediction = await response.json();

  while (prediction.status === "starting" || prediction.status === "processing") {
    await new Promise(r => setTimeout(r, 2000));
    const poll = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
      headers: { "Authorization": `Token ${REPLICATE_API_TOKEN}` }
    });
    prediction = await poll.json();
  }

  if (prediction.status !== "succeeded") throw new Error("Replicate falló.");

  return Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
}

// ======================= COPY EMOCIONAL =======================

function buildEmotionalCopy({ roomStyle, productName, idea }) {
  let msg = `Diseñamos esta propuesta pensando en ${roomStyle || "tu espacio"}. `;
  msg += `Integrando ${productName}, logramos un balance entre estilo y calidez. `;
  if (idea) msg += `También tuvimos en cuenta tu idea: "${idea}". `;
  return msg + `Así puedes visualizar cómo se vería tu espacio antes de decidir.`;
}

// ======================= ENDPOINT PRINCIPAL =======================

app.post("/experiencia-premium", upload.single("roomImage"), async (req, res) => {
  try {
    logStep("Nueva experiencia-premium recibida");

    const file = req.file;
    const { productId, productName, productUrl, idea } = req.body;

    if (!file) return res.status(400).json({ status: "error", message: "Falta roomImage." });

    // SUBIR FOTO
    const uploadRoom = await uploadBufferToCloudinary(file.buffer, "innotiva/rooms", "room");
    const userImageUrl = uploadRoom.secure_url;

    // PRODUCTO DESDE SHOPIFY
    const productData = await fetchProductFromShopify(productId);
    const effectiveName = productName || productData.title;

    // EMBEDDING
    const productEmbedding = await buildProductEmbedding(productData);

    // ANALISIS
    const analysis = await analyzeRoomAndPlacement({
      roomImageUrl: userImageUrl,
      productImageUrl: productData.featuredImage,
      productEmbedding,
      ideaText: idea,
      productName: effectiveName
    });

    // MÁSCARA
    const maskBase64 = await createMaskFromAnalysis(analysis);

    // GENERAR IA
    const generated = await callReplicateWithProduct({
      roomImageUrl: userImageUrl,
      productImageUrl: productData.featuredImage,
      maskBase64,
      productEmbedding,
      analysis,
      productName: effectiveName
    });

    const uploadGen = await uploadUrlToCloudinary(generated, "innotiva/generated", "room-generated");

    const payload = {
      sessionId: crypto.randomUUID(),
      status: "success",
      userImageUrl,
      generatedImageUrl: uploadGen.secure_url,
      productUrl,
      productName: effectiveName,
      message: buildEmotionalCopy({ roomStyle: analysis.roomStyle, productName: effectiveName, idea }),
      analysis,
      thumbnails: {
        before: buildThumbnails(uploadRoom.public_id),
        after: buildThumbnails(uploadGen.public_id)
      },
      productEmbedding,
      createdAt: new Date().toISOString()
    };

    logStep("EXPERIENCIA GENERADA OK");

    return res.json(payload);

  } catch (err) {
    console.error("Error en /experiencia-premium:", err);
    return res.status(500).json({
      status: "error",
      message: "Tuvimos un problema generando tu propuesta. Intenta nuevamente."
    });
  }
});

// ======================= ARRANQUE =======================

app.listen(PORT, () =>
  console.log(`🚀 INNOTIVA BACKEND PRO escuchando en puerto ${PORT}`)
);
