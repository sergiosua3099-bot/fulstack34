// ======================================================
// INNOTIVA BACKEND PRO - EXPERIENCIA PREMIUM
// Integración completa: Cloudinary + Shopify + OpenAI + Replicate
// Versión estable corregida para Render
// Modelo OpenAI: gpt-4o-mini
// Modelo Replicate: black-forest-labs/flux-1-dev-inpainting
// ======================================================

require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const sharp = require("sharp");
const crypto = require("crypto");
const OpenAI = require("openai");
const cloudinary = require("cloudinary").v2;
const fetch = require("node-fetch");

// ======================================================
// CONFIGURACIÓN GENERAL
// ======================================================

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const PORT = process.env.PORT || 10000;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_STOREFRONT_TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN;

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const REPLICATE_MODEL = "black-forest-labs/flux-1-dev-inpainting";

// ======================================================
// MIDDLEWARE
// ======================================================

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("INNOTIVA BACKEND PRO funcionando correctamente.");
});

// ======================================================
// HELPERS
// ======================================================

function log(step, extra) {
  console.log(`[INNOTIVA] ${step}`, extra || "");
}

function sanitizeJSON(text) {
  if (!text) return "";
  return text
    .replace(/```/g, "")
    .replace(/json/g, "")
    .replace(/\n/g, "\n")
    .trim();
}

function buildShopifyGID(id) {
  if (String(id).startsWith("gid://")) return id;
  return `gid://shopify/Product/${id}`;
}

// ======================================================
// CLOUDINARY HELPERS
// ======================================================

async function uploadBufferToCloudinary(buffer, folder, name = "image") {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload(
      `data:image/jpeg;base64,${buffer.toString("base64")}`,
      {
        folder,
        public_id: `${name}-${Date.now()}`
      },
      (err, result) => {
        if (err) return reject(err);
        resolve(result);
      }
    );
  });
}

async function uploadUrlToCloudinary(url, folder, name = "image-url") {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload(
      url,
      {
        folder,
        public_id: `${name}-${Date.now()}`
      },
      (err, result) => {
        if (err) return reject(err);
        resolve(result);
      }
    );
  });
}

// ======================================================
// SHOPIFY FETCH PRODUCT
// ======================================================

async function fetchProduct(productId) {
  const gid = buildShopifyGID(productId);

  const query = `
    query GetProduct($id: ID!) {
      product(id: $id) {
        id
        title
        featuredImage { url }
        description
        productType
      }
    }
  `;

  const res = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/api/2024-01/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Storefront-Access-Token": SHOPIFY_STOREFRONT_TOKEN
    },
    body: JSON.stringify({ query, variables: { id: gid } })
  });

  const json = await res.json();

  if (!json.data || !json.data.product) {
    throw new Error("No se pudo cargar el producto desde Shopify");
  }

  return {
    id: json.data.product.id,
    title: json.data.product.title,
    featuredImage: json.data.product.featuredImage?.url || null,
    productType: json.data.product.productType || "",
    description: json.data.product.description || ""
  };
}

// ======================================================
// OPENAI — EMBEDDING DEL PRODUCTO
// ======================================================

async function buildProductEmbedding(product) {
  if (!product.featuredImage) return null;

  log("OpenAI: embedding del producto", { title: product.title });

  const prompt = `
Analiza únicamente el producto de la imagen. 
Devuelve SOLO un JSON puro, sin backticks, sin texto adicional, sin triple ticks.

Formato EXACTO:
{
  "colors": ["color1", "color2"],
  "materials": ["material1"],
  "texture": "descripcion corta",
  "pattern": "descripcion corta"
}
`;

  const response = await openai.responses.create({
    model: "gpt-4o-mini",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: product.featuredImage }
        ]
      }
    ]
  });

  const raw = sanitizeJSON(
    response.output[0]?.content[0]?.text || 
    response.output[0]?.content[0]?.content
  );

  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error("Error parseando embedding:", raw);
    return null;
  }
}

// ======================================================
// OPENAI — ANALYSIS ROOM + BOUNDING BOX
// ======================================================

async function analyzeRoom({ roomImageUrl, idea, productName }) {
  log("OpenAI: análisis del cuarto");

  const prompt = `
Devuelve SOLO un JSON exacto, sin texto adicional, sin backticks, sin triple ticks.

Formato EXACTO:
{
  "imageWidth": 1200,
  "imageHeight": 800,
  "roomStyle": "string",
  "detectedAnchors": ["string"],
  "placement": { "x": number, "y": number, "width": number, "height": number },
  "conflicts": [],
  "finalPlacement": { "x": number, "y": number, "width": number, "height": number }
}

Reglas:
- NO describas muebles. Solo devuelve coordenadas.
- Usa pixeles.
- Si no puedes detectar bien, devuelve un rectángulo centrado.
Idea del cliente: ${idea || "ninguna"}
Producto: ${productName}
`;

  const response = await openai.responses.create({
    model: "gpt-4o-mini",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: roomImageUrl }
        ]
      }
    ]
  });

  const raw = sanitizeJSON(
    response.output[0]?.content[0]?.text ||
    response.output[0]?.content[0]?.content
  );

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.error("Error parseando análisis:", raw);
    throw new Error("OpenAI devolvió un JSON inválido para el análisis");
  }

  if (!data.finalPlacement || typeof data.finalPlacement.x !== "number") {
    const w = data.imageWidth || 1200;
    const h = data.imageHeight || 800;

    data.finalPlacement = {
      x: Math.round(w * 0.25),
      y: Math.round(h * 0.20),
      width: Math.round(w * 0.5),
      height: Math.round(h * 0.5)
    };
  }

  return data;
}

// ======================================================
// GENERAR MÁSCARA
// ======================================================

async function createMask(analysis) {
  const { imageWidth, imageHeight, finalPlacement } = analysis;

  const w = Math.max(1, imageWidth);
  const h = Math.max(1, imageHeight);

  const mask = Buffer.alloc(w * h, 0);

  const { x, y, width, height } = finalPlacement;

  for (let j = y; j < y + height; j++) {
    if (j < 0 || j >= h) continue;
    for (let i = x; i < x + width; i++) {
      if (i < 0 || i >= w) continue;
      mask[j * w + i] = 255;
    }
  }

  return sharp(mask, {
    raw: { width: w, height: h, channels: 1 }
  })
    .png()
    .toBuffer()
    .then(buf => buf.toString("base64"));
}

// ======================================================
// REPLICATE — INPAINTING
// ======================================================

async function runReplicate({ roomImageUrl, maskBase64, prompt }) {
  log("Replicate: generando imagen…");

  const payload = {
    version: REPLICATE_MODEL,
    input: {
      image: roomImageUrl,
      mask: `data:image/png;base64,${maskBase64}`,
      prompt: prompt,
      strength: 1
    }
  };

  const res = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      "Authorization": `Token ${REPLICATE_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  let pred = await res.json();

  while (pred.status === "starting" || pred.status === "processing") {
    await new Promise(r => setTimeout(r, 2000));
    const poll = await fetch(`https://api.replicate.com/v1/predictions/${pred.id}`, {
      headers: { "Authorization": `Token ${REPLICATE_API_TOKEN}` }
    });
    pred = await poll.json();
  }

  if (pred.status !== "succeeded") {
    console.error("Replicate error:", pred);
    throw new Error("Replicate no pudo generar imagen");
  }

  return Array.isArray(pred.output) ? pred.output[0] : pred.output;
}

// ======================================================
// COPY EMOCIONAL
// ======================================================

function buildCopy({ roomStyle, productName, idea }) {
  let msg = `Diseñamos esta propuesta respetando el estilo de tu espacio (${roomStyle}). `;
  msg += `Integrando ${productName} como protagonista, logramos una composición equilibrada y natural. `;
  if (idea) msg += `También consideramos tu idea: “${idea}”. `;
  msg += `Así puedes visualizarlo antes de tomar una decisión.`;
  return msg;
}

// ======================================================
// ENDPOINT PRINCIPAL
// ======================================================

app.post("/experiencia-premium", upload.single("roomImage"), async (req, res) => {
  const start = Date.now();
  try {
    log("Nueva experiencia-premium recibida");

    const file = req.file;
    const { productId, productName, productUrl, idea } = req.body;

    if (!file) throw new Error("Falta roomImage");
    if (!productId) throw new Error("Falta productId");

    // 1) Subir room
    const roomUpload = await uploadBufferToCloudinary(file.buffer, "innotiva/rooms", "room");
    const roomUrl = roomUpload.secure_url;

    // 2) Producto completo desde Shopify
    const product = await fetchProduct(productId);
    const finalProductName = productName || product.title;

    // 3) Embedding
    const embedding = await buildProductEmbedding(product);

    // 4) Análisis
    const analysis = await analyzeRoom({
      roomImageUrl: roomUrl,
      idea,
      productName: finalProductName
    });

    // 5) Máscara
    const mask = await createMask(analysis);

    // 6) Prompt final Replicate
    const repPrompt = `
Inserta el producto ${finalProductName} en la zona indicada.
Mantén la habitación intacta.
Respeta perspectiva, iluminación y colores reales.
Producto:
${JSON.stringify(embedding || {}, null, 2)}
`;

    // 7) Replicate
    const generatedUrl = await runReplicate({
      roomImageUrl: roomUrl,
      maskBase64: mask,
      prompt: repPrompt
    });

    // 8) Upload final a Cloudinary
    const finalUpload = await uploadUrlToCloudinary(generatedUrl, "innotiva/generated", "after");
    const finalUrl = finalUpload.secure_url;

    // 9) Copy emocional
    const message = buildCopy({
      roomStyle: analysis.roomStyle,
      productName: finalProductName,
      idea
    });

    // 10) Respuesta final
    const payload = {
      status: "success",
      sessionId: crypto.randomUUID(),
      userImageUrl: roomUrl,
      generatedImageUrl: finalUrl,
      productUrl: productUrl || null,
      productName: finalProductName,
      message,
      analysis,
      createdAt: new Date().toISOString()
    };

    log("EXPERIENCIA GENERADA OK", { ms: Date.now() - start });
    res.json(payload);

  } catch (err) {
    console.error("Error en /experiencia-premium:", err);
    res.status(500).json({
      status: "error",
      message: "No se pudo generar la propuesta. Intenta nuevamente."
    });
  }
});

// ======================================================
// RUN SERVER
// ======================================================

app.listen(PORT, () => {
  console.log(`🚀 INNOTIVA BACKEND PRO escuchando en puerto ${PORT}`);
});
