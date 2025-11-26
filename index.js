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

// ================ CONFIGURACIÓN BÁSICA ================

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

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN; // ej: innotiva-vision.myshopify.com
const SHOPIFY_STOREFRONT_TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN;

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const REPLICATE_DEFAULT_MODEL = process.env.REPLICATE_FLUX_MODEL_ID; // luego le añades más

// ================ MIDDLEWARE ================

app.use(cors());
app.use(express.json());

// simple healthcheck
app.get("/", (req, res) => {
  res.send("INNOTIVA BACKEND PRO funcionando ✅");
});

app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ================ HELPERS GENERALES ================

function logStep(step, extra = {}) {
  console.log(`[INNOTIVA] ${step}`, Object.keys(extra).length ? extra : "");
}

function buildShopifyProductGid(numericId) {
  // Shopify GraphQL espera algo tipo "gid://shopify/Product/123456789"
  if (String(numericId).startsWith("gid://")) return numericId;
  return `gid://shopify/Product/${numericId}`;
}

// ================ CLOUDINARY HELPERS ================

async function uploadBufferToCloudinary(buffer, folder, filenameHint = "image") {
  return new Promise((resolve, reject) => {
    const base64 = buffer.toString("base64");
    cloudinary.uploader.upload(
      `data:image/jpeg;base64,${base64}`,
      {
        folder,
        public_id: `${filenameHint}-${Date.now()}`
      },
      (err, result) => {
        if (err) return reject(err);
        resolve(result);
      }
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
      (err, result) => {
        if (err) return reject(err);
        resolve(result);
      }
    );
  });
}

function buildThumbnails(publicId) {
  // Genera urls derivadas para antes/después
  const beforeLow = cloudinary.url(publicId, {
    width: 400,
    height: 400,
    crop: "fill",
    quality: 70
  });
  const beforeMedium = cloudinary.url(publicId, {
    width: 1080,
    height: 1080,
    crop: "fill",
    quality: 80
  });

  return {
    low: beforeLow,
    medium: beforeMedium
  };
}

// ================ SHOPIFY HELPER ================

async function fetchProductFromShopify(productId) {
  const gid = buildShopifyProductGid(productId);

  const query = `
    query GetProduct($id: ID!) {
      product(id: $id) {
        id
        title
        productType
        description
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

  if (json.errors || !json.data || !json.data.product) {
    console.error("Error Shopify GraphQL:", JSON.stringify(json, null, 2));
    throw new Error("No se pudo obtener el producto desde Shopify");
  }

  const p = json.data.product;

  return {
    id: p.id,
    title: p.title,
    productType: p.productType || "generic",
    description: p.description || "",
    featuredImage: p.featuredImage ? p.featuredImage.url : null
  };
}

// ================ OPENAI HELPERS ================

// 1) Embedding visual del producto (colores, materiales, etc.)
async function buildProductEmbedding(product) {
  if (!product.featuredImage) {
    return null;
  }

  logStep("OpenAI: embedding visual del producto", { productTitle: product.title });

  const prompt = `
Analiza SOLO el producto que aparece en la imagen.
Devuélveme un JSON con esta estructura exacta:
{
  "colors": ["color1", "color2", ...],
  "materials": ["material1", "material2", ...],
  "texture": "descripción corta",
  "pattern": "descripción corta"
}
Solo JSON válido, sin texto adicional.
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
            image_url: { url: product.featuredImage }
          }
        ]
      }
    ]
  });

  const text =
    response.output[0].content[0].text ||
    response.output[0].content[0].content ||
    "";

  try {
    return JSON.parse(text);
  } catch (e) {
    console.error("Error parseando embedding de producto:", e, text);
    return null;
  }
}

// 2) Análisis del cuarto + zona ideal + anclas + conflictos
async function analyzeRoomAndPlacement({ roomImageUrl, productImageUrl, productEmbedding, ideaText, productName }) {
  logStep("OpenAI: análisis de cuarto y colocación");

  const prompt = `
Tienes dos imágenes:
- image1: la foto real del espacio del cliente.
- image2: la foto del producto real (${productName}).

Quiero que:
1) Analices el estilo general del cuarto (ej: "minimalista cálido", "industrial", etc.).
2) Detectes anclas relevantes del cuarto: sofá, cama, pared libre, mesa, ventana, repisas, etc.
3) Propongas una zona rectangular ideal para colocar el producto (x, y, width, height) en coordenadas de la imagen.
4) Si se detecta conflicto (tapar ventana, cuadro existente, lámpara, etc.):
   - Indica "conflicts": lista de conflictos.
   - Propón un "finalPlacement" ajustado que los evite.
5) Usa también la idea del cliente si la hay: "${ideaText || ""}".

Devuélveme SOLO un JSON válido con esta estructura EXACTA:
{
  "imageWidth": number,
  "imageHeight": number,
  "roomStyle": "texto",
  "detectedAnchors": ["sofa", "wall", ...],
  "placement": { "x": number, "y": number, "width": number, "height": number },
  "conflicts": [
    { "type": "string", "description": "string" }
  ],
  "finalPlacement": { "x": number, "y": number, "width": number, "height": number }
}
Si no hay conflictos, "conflicts" puede ser [] y "finalPlacement" puede ser igual a "placement".
`;

  const inputContent = [
    { type: "input_text", text: prompt },
    { type: "input_image", image_url: { url: roomImageUrl } }
  ];

  if (productImageUrl) {
    inputContent.push({
      type: "input_image",
      image_url: { url: productImageUrl }
    });
  }

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: [
      {
        role: "user",
        content: inputContent
      }
    ]
  });

  const text =
    response.output[0].content[0].text ||
    response.output[0].content[0].content ||
    "";

  let analysis;
  try {
    analysis = JSON.parse(text);
  } catch (e) {
    console.error("Error parseando análisis de cuarto:", e, text);
    throw new Error("No se pudo analizar el cuarto");
  }

  // fallback mínimos
  if (!analysis.finalPlacement && analysis.placement) {
    analysis.finalPlacement = analysis.placement;
  }

  if (!Array.isArray(analysis.detectedAnchors)) {
    analysis.detectedAnchors = [];
  }

  if (!Array.isArray(analysis.conflicts)) {
    analysis.conflicts = [];
  }

  return analysis;
}

// ================ MÁSCARA INTELIGENTE ================

async function createMaskFromAnalysis(analysis) {
  // Usamos bounding box (finalPlacement) para generar máscara.
  // Aunque pedimos segmentación fina, este rectángulo suele ser suficiente.
  const { imageWidth, imageHeight, finalPlacement } = analysis;

  if (!imageWidth || !imageHeight || !finalPlacement) {
    throw new Error("Datos insuficientes para crear la máscara");
  }

  const { x, y, width, height } = finalPlacement;

  const w = Math.max(1, Math.round(imageWidth));
  const h = Math.max(1, Math.round(imageHeight));

  const mask = Buffer.alloc(w * h, 0); // negro

  for (let j = Math.max(0, y); j < Math.min(h, y + height); j++) {
    for (let i = Math.max(0, x); i < Math.min(w, x + width); i++) {
      const idx = j * w + i;
      mask[idx] = 255; // blanco => zona editable
    }
  }

  const pngBuffer = await sharp(mask, {
    raw: { width: w, height: h, channels: 1 }
  })
    .png()
    .toBuffer();

  return pngBuffer.toString("base64");
}

// ================ REPLICATE HELPER ================

async function callReplicateWithProduct({
  roomImageUrl,
  productImageUrl,
  maskBase64,
  productEmbedding,
  analysis,
  productName
}) {
  logStep("Replicate: generando imagen con producto");

  const prompt = `
Inserta este producto real en la zona marcada:
- Mantén su forma, colores y materiales.
- Respeta el estilo del espacio: ${analysis.roomStyle || "desconocido"}.
- Producto: ${productName || "producto de decoración"}.

Detalles del producto (pueden ayudarte a mantener consistencia):
${productEmbedding ? JSON.stringify(productEmbedding) : "sin embedding detallado"}.

Respeta la iluminación y la perspectiva de la habitación. Crea una integración natural, como una foto real.
`;

  const inputPayload = {
    image: roomImageUrl,
    mask: `data:image/png;base64,${maskBase64}`,
    prompt,
    // Muchos modelos soportan reference_image o similar; si el tuyo lo soporta, úsalo:
    // reference_image: productImageUrl,
    // reference_scale: 0.8
  };

  const response = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      "Authorization": `Token ${REPLICATE_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      version: REPLICATE_DEFAULT_MODEL,
      input: inputPayload
    })
  });

  const prediction = await response.json();

  if (prediction.error) {
    console.error("Error Replicate:", prediction.error);
    throw new Error("Error en Replicate");
  }

  // Polling simple si aún no ha terminado
  let finalPrediction = prediction;
  while (finalPrediction.status === "starting" || finalPrediction.status === "processing") {
    await new Promise(r => setTimeout(r, 2000));
    const pollRes = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
      headers: {
        "Authorization": `Token ${REPLICATE_API_TOKEN}`
      }
    });
    finalPrediction = await pollRes.json();
  }

  if (finalPrediction.status !== "succeeded") {
    console.error("Replicate no succeeded:", finalPrediction);
    throw new Error("Replicate no pudo generar la imagen");
  }

  const output = finalPrediction.output;
  const imageUrl = Array.isArray(output) ? output[0] : output;

  return imageUrl;
}

// ================ COPY EMOCIONAL ================

function buildEmotionalCopy({ roomStyle, productName, idea }) {
  const base = roomStyle || "tu espacio";

  let msg = `Diseñamos esta propuesta pensando en ${base}.`;

  if (productName) {
    msg += ` Integrando ${productName} como protagonista, logramos un equilibrio entre estilo y calidez.`;
  }

  if (idea && idea.trim().length > 0) {
    msg += ` También tuvimos en cuenta tu idea: “${idea.trim()}”.`;
  }

  msg += ` Así puedes visualizar cómo se vería tu espacio antes de tomar la decisión final.`;

  return msg;
}

// ================ ENDPOINT PRINCIPAL /experiencia-premium ================

app.post(
  "/experiencia-premium",
  upload.single("roomImage"),
  async (req, res) => {
    const startedAt = Date.now();
    try {
      logStep("Nueva experiencia-premium recibida");

      // 1) Campos provenientes del formulario
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

      // 2) Subir imagen original a Cloudinary
      const uploadRoom = await uploadBufferToCloudinary(
        file.buffer,
        "innotiva/rooms",
        "room"
      );

      const userImageUrl = uploadRoom.secure_url;
      const roomPublicId = uploadRoom.public_id;

      logStep("Imagen del usuario subida a Cloudinary", { userImageUrl });

      // 3) Traer el producto real desde Shopify
      const productData = await fetchProductFromShopify(productId);

      const effectiveProductName = productName || productData.title || "tu producto";

      // 4) Embedding visual del producto
      const productEmbedding = await buildProductEmbedding(productData);

      // 5) Análisis del cuarto y la colocación
      const analysis = await analyzeRoomAndPlacement({
        roomImageUrl: userImageUrl,
        productImageUrl: productData.featuredImage,
        productEmbedding,
        ideaText: idea,
        productName: effectiveProductName
      });

      // 6) Crear máscara en base al análisis
      const maskBase64 = await createMaskFromAnalysis(analysis);

      // 7) Llamar a Replicate para integrar el producto
      const replicateImageUrl = await callReplicateWithProduct({
        roomImageUrl: userImageUrl,
        productImageUrl: productData.featuredImage,
        maskBase64,
        productEmbedding,
        analysis,
        productName: effectiveProductName
      });

      // 8) Subir imagen generada a Cloudinary + thumbnails
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

      // 9) Validación básica antes/después
      if (!userImageUrl || !generatedImageUrl) {
        throw new Error("Imágenes incompletas (antes/después).");
      }
      if (userImageUrl === generatedImageUrl) {
        throw new Error("Las imágenes antes y después son idénticas, algo salió mal.");
      }

      // 10) Copy emocional
      const message = buildEmotionalCopy({
        roomStyle: analysis.roomStyle,
        productName: effectiveProductName,
        idea
      });

      // 11) sessionId (a futuro puedes guardar en BD)
      const sessionId = crypto.randomUUID();

      const payload = {
        sessionId,
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
  }
);

// ================ ARRANQUE DEL SERVIDOR ================

app.listen(PORT, () => {
  console.log(`🚀 INNOTIVA BACKEND PRO escuchando en puerto ${PORT}`);
});
