// index.js
// Backend PRO Innotiva - /experiencia-premium
// Cloudinary + Shopify + OpenAI Vision + Replicate

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
// Usa un modelo de inpainting que soporte reference_image
// Ej: black-forest-labs/flux-1-dev-inpainting
const REPLICATE_DEFAULT_MODEL = process.env.REPLICATE_FLUX_MODEL_ID;

// ===================== MIDDLEWARE =====================

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("INNOTIVA BACKEND PRO funcionando ✅");
});

app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ===================== HELPERS GENERALES =====================

function logStep(step, extra = {}) {
  console.log(`[INNOTIVA] ${step}`, Object.keys(extra).length ? extra : "");
}

function buildShopifyProductGid(id) {
  if (String(id).startsWith("gid://")) return id;
  return `gid://shopify/Product/${id}`;
}

// Normaliza cualquier cosa tipo imagen a una URL string o null
function normalizeImageUrl(img) {
  if (!img) return null;
  if (typeof img === "string") return img;
  if (typeof img === "object") {
    return img.url || img.src || img.originalSrc || null;
  }
  return null;
}

// ===================== CLOUDINARY =====================

async function uploadBufferToCloudinary(buffer, folder, filenameHint = "image") {
  return new Promise((resolve, reject) => {
    const base64 = buffer.toString("base64");
    cloudinary.uploader.upload(
      `data:image/jpeg;base64,${base64}`,
      {
        folder,
        public_id: `${filenameHint}-${Date.now()}`
      },
      (err, result) => (err ? reject(err) : resolve(result))
    );
  });
}

async function uploadUrlToCloudinary(url, folder, filenameHint = "image-from-url") {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload(
      url,
      {
        folder,
        public_id: `${filenameHint}-${Date.now()}`
      },
      (err, result) => (err ? reject(err) : resolve(result))
    );
  });
}

function buildThumbnails(publicId) {
  return {
    low: cloudinary.url(publicId, {
      width: 400,
      height: 400,
      crop: "fill",
      quality: 70
    }),
    medium: cloudinary.url(publicId, {
      width: 1080,
      height: 1080,
      crop: "fill",
      quality: 80
    })
  };
}

// “Recorte PRO” del producto: lo subimos a Cloudinary y generamos una
// versión centrada y recortada al producto con gravity:auto.
function buildProductCutoutUrl(productPublicId) {
  // 1024x1024 centrado en el sujeto principal
  return cloudinary.url(productPublicId, {
    width: 1024,
    height: 1024,
    crop: "fill",
    gravity: "auto",
    quality: 90,
    fetch_format: "auto"
  });
}

// ===================== SHOPIFY =====================

async function fetchProductFromShopify(productId) {
  const gid = buildShopifyProductGid(productId);

  const query = `
    query GetProduct($id: ID!) {
      product(id: $id) {
        id
        title
        featuredImage {
          url
        }
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
    console.error("Error Shopify GraphQL:", JSON.stringify(json, null, 2));
    throw new Error("No se pudo obtener el producto desde Shopify");
  }

  const p = json.data.product;

  return {
    id: p.id,
    title: p.title,
    featuredImage: normalizeImageUrl(p.featuredImage)
  };
}

// ===================== OPENAI – EMBEDDING PRODUCTO =====================

async function buildProductEmbedding({ imageUrl, title }) {
  if (!imageUrl) return null;

  logStep("OpenAI: embedding visual del producto", { title });

  const prompt = `
Analiza SOLO el producto principal en la imagen.
Devuélveme EXACTAMENTE este JSON:
{
  "colors": ["color1", "color2"],
  "materials": ["material1", "material2"],
  "texture": "texto corto",
  "pattern": "texto corto"
}
Sin texto adicional, solo JSON.
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
            image_url: imageUrl
          }
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
  } catch (e) {
    console.error("Error parseando embedding de producto:", e, raw);
    return null;
  }
}

// ===================== OPENAI – ANÁLISIS DEL CUARTO =====================

async function analyzeRoomAndPlacement({
  roomImageUrl,
  productImageUrl,
  productEmbedding,
  ideaText,
  productName
}) {
  const roomUrl = normalizeImageUrl(roomImageUrl);
  const productUrl = normalizeImageUrl(productImageUrl);

  if (!roomUrl) throw new Error("roomImageUrl inválida");
  if (!productUrl) throw new Error("productImageUrl inválida");

  logStep("OpenAI: análisis de cuarto y colocación");

  const prompt = `
Tienes:
- image1: foto real del espacio del cliente.
- image2: foto del producto real (${productName}).

Analiza y devuelve SOLO un JSON válido:
{
  "imageWidth": number,
  "imageHeight": number,
  "roomStyle": "texto",
  "detectedAnchors": ["sofa","wall"],
  "placement": { "x":0,"y":0,"width":0,"height":0 },
  "conflicts": [
    {"type":"string","description":"string"}
  ],
  "finalPlacement": { "x":0,"y":0,"width":0,"height":0 }
}

Usa la idea del cliente si existe: "${ideaText || ""}".
Si no hay conflictos, "conflicts" puede ser [] y "finalPlacement" igual a "placement".
`;

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

  let analysis;
  try {
    analysis = JSON.parse(raw);
  } catch (e) {
    console.error("Error parseando análisis de cuarto:", e, raw);
    throw new Error("No se pudo analizar el cuarto");
  }

  if (!analysis.finalPlacement && analysis.placement) {
    analysis.finalPlacement = analysis.placement;
  }
  if (!Array.isArray(analysis.detectedAnchors)) analysis.detectedAnchors = [];
  if (!Array.isArray(analysis.conflicts)) analysis.conflicts = [];

  return analysis;
}

// ===================== MÁSCARA =====================

async function createMaskFromAnalysis(analysis) {
  const { imageWidth, imageHeight, finalPlacement } = analysis;

  if (!imageWidth || !imageHeight || !finalPlacement) {
    throw new Error("Datos insuficientes para crear la máscara");
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

  const png = await sharp(mask, {
    raw: { width: w, height: h, channels: 1 }
  })
    .png()
    .toBuffer();

  return png.toString("base64");
}

// ===================== REPLICATE – INPAINTING CON REFERENCIA =====================

async function callReplicateWithProduct({
  roomImageUrl,
  productImageUrl,
  maskBase64,
  productEmbedding,
  analysis,
  productName
}) {
  logStep("Replicate: generando integración REAL del producto…");

  const prompt = `
Inserta el producto REAL en la zona marcada.
Producto: ${productName}.
Respeta:
- Estilo del espacio: ${analysis.roomStyle || "no especificado"}.
- Perspectiva real de la habitación.
- Iluminación original.
No inventes otro objeto, usa la referencia como guía principal.
${productEmbedding ? "Detalles del producto: " + JSON.stringify(productEmbedding) : ""}
`;

  const input = {
    image: roomImageUrl,
    mask: `data:image/png;base64,${maskBase64}`,
    prompt,
    reference_image: productImageUrl,
    reference_strength: 0.85,
    guidance: 5,
    num_inference_steps: 28,
    strength: 0.9,
    output_format: "jpg"
  };

  const response = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      "Authorization": `Token ${REPLICATE_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      version: REPLICATE_DEFAULT_MODEL,
      input
    })
  });

  let prediction = await response.json();

  while (prediction.status === "starting" || prediction.status === "processing") {
    await new Promise(r => setTimeout(r, 1800));
    const poll = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
      headers: {
        "Authorization": `Token ${REPLICATE_API_TOKEN}`
      }
    });
    prediction = await poll.json();
  }

  if (prediction.status !== "succeeded") {
    console.error("Replicate no succeeded:", prediction);
    throw new Error("Replicate no pudo generar la imagen");
  }

  const output = prediction.output;
  return Array.isArray(output) ? output[0] : output;
}

// ===================== COPY EMOCIONAL =====================

function buildEmotionalCopy({ roomStyle, productName, idea }) {
  const base = roomStyle || "tu espacio";

  let msg = `Diseñamos esta propuesta pensando en ${base}. `;
  msg += `Integrando ${productName} como protagonista, logramos un equilibrio entre estilo y calidez. `;
  if (idea && idea.trim()) {
    msg += `También tuvimos en cuenta tu idea: “${idea.trim()}”. `;
  }
  msg += `Así puedes visualizar cómo se vería tu espacio antes de tomar la decisión final.`;
  return msg;
}

// ===================== ENDPOINT PRINCIPAL =====================

app.post("/experiencia-premium", upload.single("roomImage"), async (req, res) => {
  const startedAt = Date.now();
  try {
    logStep("Nueva experiencia-premium recibida");

    const file = req.file;
    const { productId, productName, productUrl, idea } = req.body;

    if (!file) {
      return res.status(400).json({
        status: "error",
        message: "Falta la imagen del espacio (roomImage)."
      });
    }
    if (!productId) {
      return res.status(400).json({
        status: "error",
        message: "Falta el productId."
      });
    }

    // 1) Subir imagen del usuario
    const uploadRoom = await uploadBufferToCloudinary(
      file.buffer,
      "innotiva/rooms",
      "room"
    );
    const userImageUrl = uploadRoom.secure_url;
    const roomPublicId = uploadRoom.public_id;
    logStep("Imagen del usuario subida a Cloudinary", { userImageUrl });

    // 2) Producto desde Shopify
    const productData = await fetchProductFromShopify(productId);
    const effectiveProductName = productName || productData.title || "tu producto";

    // 3) Subir imagen del producto a Cloudinary y generar “recorte PRO”
    const uploadedProduct = await uploadUrlToCloudinary(
      productData.featuredImage,
      "innotiva/products/raw",
      "product-original"
    );
    const productPublicId = uploadedProduct.public_id;
    const productCutoutUrl = buildProductCutoutUrl(productPublicId);
    logStep("Producto subido y recortado en Cloudinary", { productCutoutUrl });

    // 4) Embedding del producto usando la versión recortada
    const productEmbedding = await buildProductEmbedding({
      imageUrl: productCutoutUrl,
      title: effectiveProductName
    });

    // 5) Análisis del cuarto
    const analysis = await analyzeRoomAndPlacement({
      roomImageUrl: userImageUrl,
      productImageUrl: productCutoutUrl,
      productEmbedding,
      ideaText: idea,
      productName: effectiveProductName
    });

    // 6) Máscara
    const maskBase64 = await createMaskFromAnalysis(analysis);

    // 7) Replicate: integrar producto real
    const replicateImageUrl = await callReplicateWithProduct({
      roomImageUrl: userImageUrl,
      productImageUrl: productCutoutUrl,
      maskBase64,
      productEmbedding,
      analysis,
      productName: effectiveProductName
    });

    // 8) Subir resultado a Cloudinary
    const uploadGenerated = await uploadUrlToCloudinary(
      replicateImageUrl,
      "innotiva/generated",
      "room-generated"
    );
    const generatedImageUrl = uploadGenerated.secure_url;
    const generatedPublicId = uploadGenerated.public_id;

    const thumbnails = {
      before: buildThumbnails(roomPublicId),
      after: buildThumbnails(generatedPublicId)
    };

    // 9) Validación antes/después
    if (!userImageUrl || !generatedImageUrl) {
      throw new Error("Imágenes incompletas (antes/después).");
    }
    if (userImageUrl === generatedImageUrl) {
      throw new Error("Las imágenes antes y después son idénticas, algo salió mal.");
    }

    // 10) Mensaje emocional
    const message = buildEmotionalCopy({
      roomStyle: analysis.roomStyle,
      productName: effectiveProductName,
      idea
    });

    // 11) Payload final
    const payload = {
      sessionId: crypto.randomUUID(),
      status: "success",
      userImageUrl,
      generatedImageUrl,
      productUrl: productUrl || null,
      productName: effectiveProductName,
      message,
      analysis,
      thumbnails,
      productEmbedding,
      createdAt: new Date().toISOString()
    };

    logStep("Experiencia generada con éxito", {
      elapsedMs: Date.now() - startedAt
    });

    return res.json(payload);
  } catch (err) {
    console.error("Error en /experiencia-premium:", err);
    return res.status(500).json({
      status: "error",
      message:
        "Tuvimos un problema al generar tu propuesta. Intenta de nuevo en unos minutos."
    });
  }
});

// ===================== ARRANQUE SERVIDOR =====================

app.listen(PORT, () => {
  console.log(`🚀 INNOTIVA BACKEND PRO escuchando en puerto ${PORT}`);
});
