// index.js
// INNOTIVA BACKEND PRO - /experiencia-premium

require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const sharp = require("sharp");
const crypto = require("crypto");
const OpenAI = require("openai");
const cloudinary = require("cloudinary").v2;

// ================== CONFIG BÁSICA ==================

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
// Para FLUX-FILL-DEV usamos endpoint de modelo, no hace falta version en el body
const REPLICATE_MODEL_SLUG =
  process.env.REPLICATE_MODEL_SLUG || "black-forest-labs/flux-fill-dev";

// ================== MIDDLEWARE ==================

app.use(cors());
app.use(express.json());

// healthchecks
app.get("/", (req, res) => {
  res.send("INNOTIVA BACKEND PRO funcionando ✅");
});

app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ================== HELPERS GENERALES ==================

function logStep(step, extra = {}) {
  console.log("[INNOTIVA]", step, Object.keys(extra).length ? extra : "");
}

function buildShopifyProductGid(numericId) {
  if (String(numericId).startsWith("gid://")) return numericId;
  return `gid://shopify/Product/${numericId}`;
}

function safeParseJSON(raw, label = "JSON") {
  if (!raw) return null;
  const cleaned = raw
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.error(`Error parseando ${label}:`, cleaned);
    return null;
  }
}

// ================== CLOUDINARY HELPERS ==================

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

async function uploadUrlToCloudinary(
  url,
  folder,
  filenameHint = "image-from-url"
) {
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
  const low = cloudinary.url(publicId, {
    secure: true,
    width: 400,
    height: 400,
    crop: "fill",
    quality: 70
  });
  const medium = cloudinary.url(publicId, {
    secure: true,
    width: 1080,
    height: 1080,
    crop: "fill",
    quality: 80
  });

  return { low, medium };
}

// Recorte PRO del producto (URL SIEMPRE HTTPS)
async function createProductCutout(productImageUrl) {
  const uploadRes = await uploadUrlToCloudinary(
    productImageUrl,
    "innotiva/products/raw",
    "product-original"
  );

  // ⚠️ Forzamos https
  const cutoutUrl = cloudinary.url(uploadRes.public_id, {
    secure: true,
    width: 1024,
    height: 1024,
    crop: "fill",
    gravity: "auto",
    quality: 90,
    fetch_format: "auto"
  });

  return {
    originalPublicId: uploadRes.public_id,
    productCutoutUrl: cutoutUrl
  };
}

// ================== SHOPIFY HELPER ==================

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

  const response = await fetch(
    `https://${SHOPIFY_STORE_DOMAIN}/api/2024-01/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": SHOPIFY_STOREFRONT_TOKEN
      },
      body: JSON.stringify({ query, variables: { id: gid } })
    }
  );

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

// ================== OPENAI HELPERS ==================

// 1) Embedding visual del producto (con imagen en base64 para evitar timeout)
async function buildProductEmbedding(product, productCutoutUrl) {
  const imageUrl = productCutoutUrl || product.featuredImage;
  if (!imageUrl) return null;

  logStep("OpenAI: embedding del producto", { title: product.title });

  let base64Image;
  try {
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) {
      console.error(
        "[INNOTIVA] Error descargando imagen para embedding:",
        imgRes.status,
        imageUrl
      );
      return null;
    }

    const buffer = Buffer.from(await imgRes.arrayBuffer());
    base64Image = `data:image/png;base64,${buffer.toString("base64")}`;
  } catch (e) {
    console.error("[INNOTIVA] Excepción descargando imagen para embedding:", e);
    return null;
  }

  const prompt = `
Analiza únicamente el producto que aparece en la imagen y devuélveme SOLO un JSON puro, sin texto extra.
Estructura EXACTA:

{
  "colors": ["color1", "color2"],
  "materials": ["material1", "material2"],
  "texture": "descripción corta",
  "pattern": "descripción corta"
}
`;

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: base64Image }
        ]
      }
    ]
  });

  const content = response.output?.[0]?.content || [];
  const text = content
    .filter((c) => c.type === "output_text")
    .map((c) => c.text)
    .join("\n")
    .trim();

  const embedding = safeParseJSON(text, "embedding");
  return embedding;
}

// 2) Análisis del cuarto
async function analyzeRoom({ roomImageUrl, ideaText }) {
  logStep("OpenAI: análisis del cuarto");

  const prompt = `
Analiza la imagen del espacio del cliente.

DEVUELVE ÚNICAMENTE un JSON PURO (sin texto extra) con esta estructura EXACTA:

{
  "imageWidth": number,
  "imageHeight": number,
  "roomStyle": "texto",
  "placement": { "x": number, "y": number, "width": number, "height": number },
  "finalPlacement": { "x": number, "y": number, "width": number, "height": number }
}

Instrucciones IMPORTANTES:
- "imageWidth" e "imageHeight" deben ser aproximaciones numéricas del tamaño de la imagen.
- "placement" es una zona rectangular ideal donde colocar el producto.
- "finalPlacement" es la misma zona, ajustada si fuera necesario.
- TODOS los campos x, y, width, height DEBEN ser NÚMEROS (sin texto).
- Considera la idea del cliente (si existe): "${ideaText || ""}".
`;

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
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

  const content = response.output?.[0]?.content || [];
  const text = content
    .filter((c) => c.type === "output_text")
    .map((c) => c.text)
    .join("\n")
    .trim();

  let analysis = safeParseJSON(text, "análisis de cuarto");

  if (
    !analysis ||
    !analysis.finalPlacement ||
    typeof analysis.finalPlacement.x !== "number"
  ) {
    logStep("Análisis insuficiente, usando fallback simple de bounding box");

    const imageWidth = analysis?.imageWidth || 1200;
    const imageHeight = analysis?.imageHeight || 800;
    const boxWidth = Math.round(imageWidth * 0.6);
    const boxHeight = Math.round(imageHeight * 0.5);
    const x = Math.round((imageWidth - boxWidth) / 2);
    const y = Math.round((imageHeight - boxHeight) / 3);

    analysis = {
      imageWidth,
      imageHeight,
      roomStyle: analysis?.roomStyle || "tu espacio",
      placement: { x, y, width: boxWidth, height: boxHeight },
      finalPlacement: { x, y, width: boxWidth, height: boxHeight }
    };
  }

  return analysis;
}

// ============ NUEVO: MÁSCARA SEGÚN PRODUCTO + IDEA ============

function determineMaskPosition(analysis, productType = "", ideaText = "") {
  const imageWidth = analysis.imageWidth || 1200;
  const imageHeight = analysis.imageHeight || 800;

  // Tamaño base razonable (más pequeño para no rehacer todo)
  let width = Math.round(imageWidth * 0.28);
  let height = Math.round(imageHeight * 0.22);
  let x = Math.round((imageWidth - width) / 2);
  let y = Math.round((imageHeight - height) / 2);

  const type = (productType || "").toLowerCase();
  const idea = (ideaText || "").toLowerCase();

  // 🖼 Cuadros / marcos -> zona media/alta en pared
  if (/(cuadro|frame|marco|poster|lienzo|art)/i.test(type)) {
    y = Math.round(imageHeight * 0.18);
    height = Math.round(imageHeight * 0.26);
  }

  // 🪑 Muebles (mesa, sofá, aparador) -> zona baja
  if (/(mesa|table|coffee|sofá|sofa|mueble|aparador)/i.test(type)) {
    y = Math.round(imageHeight * 0.55);
    height = Math.round(imageHeight * 0.30);
  }

  // 💡 Lámparas -> zona superior
  if (/(lámpara|lampara|lamp|ceiling|techo|hanging)/i.test(type)) {
    y = Math.round(imageHeight * 0.08);
    height = Math.round(imageHeight * 0.20);
  }

  // 🌿 Decoración pequeña
  if (/(decor|florero|plant|planta|figura|ornamento)/i.test(type)) {
    width = Math.round(imageWidth * 0.25);
    height = Math.round(imageHeight * 0.22);
    y = Math.round(imageHeight * 0.60);
  }

  // Ajustes por idea del cliente
  if (idea) {
    if (/arriba|superior/i.test(idea)) {
      y = Math.round(imageHeight * 0.10);
    }
    if (/abajo|inferior/i.test(idea)) {
      y = Math.round(imageHeight * 0.65);
    }
    if (/izquierda/i.test(idea)) {
      x = Math.round(imageWidth * 0.10);
    }
    if (/derecha/i.test(idea)) {
      x = Math.round(imageWidth * 0.60);
    }
    if (/centro|centrado/i.test(idea)) {
      x = Math.round((imageWidth - width) / 2);
    }
    if (/esquina/i.test(idea)) {
      width = Math.round(imageWidth * 0.22);
    }
  }

  // Clamp para que no se salga de la imagen
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x + width > imageWidth) width = imageWidth - x;
  if (y + height > imageHeight) height = imageHeight - y;

  return { x, y, width, height };
}

// ================== MÁSCARA ==================

async function createMaskFromAnalysis(analysis) {
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
      mask[idx] = 255; // blanco = zona editable
    }
  }

  const pngBuffer = await sharp(mask, {
    raw: { width: w, height: h, channels: 1 }
  })
    .png()
    .toBuffer();

  return pngBuffer.toString("base64");
}

// ===================================================
//  🔥 FLUX-FILL-DEV — Inpainting en el cuarto real
// ===================================================

async function callReplicateInpaint({
  roomImageUrl,
  maskBase64,
  prompt,
  productCutoutUrl // reservado para futuros upgrades (controlnet / lora / etc.)
}) {
  console.log("🧩 Enviando a FLUX-FILL-DEV INPAINT...");

  const maskDataUrl = `data:image/png;base64,${maskBase64}`;

  // Según doc que pegaste: se usa /v1/models/{model}/predictions + input
  const createRes = await fetch(
    `https://api.replicate.com/v1/models/${encodeURIComponent(
      REPLICATE_MODEL_SLUG
    )}/predictions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        input: {
          image: roomImageUrl,
          mask: maskDataUrl,
          prompt: prompt,
          guidance: 20,
          num_outputs: 1,
          output_format: "webp",
          output_quality: 80,
          num_inference_steps: 28,
          megapixels: "match_input"
          // seed: 42 // si quieres runs repetibles, lo activas
        }
      })
    }
  );

  const prediction = await createRes.json();

  if (!prediction || !prediction.id) {
    console.error("❌ Replicate no inició predicción:", prediction);
    throw new Error("Replicate no creó predicción — inputs/versión inválidos");
  }

  let result = prediction;
  while (result.status !== "succeeded" && result.status !== "failed") {
    await new Promise((r) => setTimeout(r, 1800));
    const pollRes = await fetch(
      `https://api.replicate.com/v1/predictions/${result.id}`,
      {
        headers: { Authorization: `Bearer ${REPLICATE_API_TOKEN}` }
      }
    );
    result = await pollRes.json();
  }

  if (result.status === "failed") {
    console.error("💥 Falló INPAINT:", result);
    throw new Error("Generación no completada");
  }

  console.log("🟢 Resultado final FLUX:", result.output?.[0]);
  return result.output?.[0];
}

// ================== COPY EMOCIONAL ==================

function buildEmotionalCopy({ roomStyle, productName, idea }) {
  const base = roomStyle || "tu espacio";

  let msg = `Diseñamos esta propuesta pensando en ${base}.`;

  if (productName) {
    msg += ` Integrando ${productName} como protagonista, buscamos un equilibrio entre estilo y calidez.`;
  }

  if (idea && idea.trim().length > 0) {
    msg += ` También tuvimos en cuenta tu idea: “${idea.trim()}”.`;
  }

  msg += ` Así puedes visualizar cómo se vería tu espacio antes de tomar la decisión final.`;

  return msg;
}

// ================== ENDPOINT PRINCIPAL ==================

app.post(
  "/experiencia-premium",
  upload.single("roomImage"), // campo EXACTO del formulario
  async (req, res) => {
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

      logStep("Imagen del usuario subida a Cloudinary", {
        roomImageUrl: userImageUrl
      });

      // 2) Producto desde Shopify
      const productData = await fetchProductFromShopify(productId);
      const effectiveProductName =
        productName || productData.title || "tu producto";

      // 3) Recorte PRO del producto (https)
      let productCutoutUrl = productData.featuredImage || null;
      try {
        if (productData.featuredImage) {
          const cutout = await createProductCutout(productData.featuredImage);
          productCutoutUrl = cutout.productCutoutUrl;
          logStep("Producto recortado", { productCutoutUrl });
        }
      } catch (e) {
        console.error("Error recortando producto, usando imagen original:", e);
      }

      // 4) Embedding visual (no rompe si falla)
      let productEmbedding = null;
      try {
        productEmbedding = await buildProductEmbedding(
          productData,
          productCutoutUrl
        );
      } catch (e) {
        console.error("Error en buildProductEmbedding, sigo sin embedding:", e);
      }

      // 5) Análisis del cuarto
      const analysis = await analyzeRoom({
        roomImageUrl: userImageUrl,
        ideaText: idea
      });

      // 6) Ajustar placement según tipo de producto + idea
      const refinedPlacement = determineMaskPosition(
        analysis,
        productData.productType,
        idea
      );
      analysis.finalPlacement = refinedPlacement;

      // 7) Máscara
      const maskBase64 = await createMaskFromAnalysis(analysis);
     // 8) PROMPT ULTRA REALISTA — REEMPLAZA TU BLOQUE ACTUAL POR ESTE 🔥

const visualHints = productEmbedding
  ? `
Colores detectados en el producto: ${(productEmbedding.colors || []).join(", ")}
Materiales: ${(productEmbedding.materials || []).join(", ")}
Textura: ${productEmbedding.texture || "no detectada"}
Patrón/detalles: ${productEmbedding.pattern || "no detectado"}
`
  : "";

const prompt = `
INSTRUCCIÓN GENERAL:
Debes integrar el producto REAL dentro del área blanca marcada por la máscara en la fotografía del cliente.
La imagen generada debe parecer una fotografía auténtica, no renderizada.

PRODUCTO A INSERTAR (ESTE MISMO, NO OTRO):
${effectiveProductName}
Referencia visual real del producto: ${productCutoutUrl}

REGLAS ABSOLUTAS:
- NO inventes un producto nuevo. Usa la referencia dada.
- Mantén proporción, sombras, luz y texturas reales.
- Todo lo que está en negro fuera de la máscara debe permanecer intacto.
- No agregues texto, logos ni elementos ajenos.
- El resultado debe parecer tomado por cámara real.
- Máximo respeto al espacio original.

Estilo del espacio detectado: ${analysis.roomStyle}
${visualHints}

OBJETIVO FINAL:
Generar 1 imagen final hiperrealista donde el producto REAL esté integrado en la zona de máscara
como si hubiera estado allí desde el principio.
`;

     
      // 9) Subir resultado a Cloudinary
      console.log("🔥 URL RAW desde Replicate =>", generatedImageUrlFromReplicate);

      const uploadGenerated = await uploadUrlToCloudinary(
        generatedImageUrlFromReplicate,
        "innotiva/generated",
        "room-generated"
      );

      const generatedImageUrl = uploadGenerated.secure_url;
      const generatedPublicId = uploadGenerated.public_id;

      const thumbnails = {
        before: buildThumbnails(roomPublicId),
        after: buildThumbnails(generatedPublicId)
      };

      if (!userImageUrl || !generatedImageUrl) {
        throw new Error("Imágenes incompletas (antes/después).");
      }

      // 10) Copy emocional
      const message = buildEmotionalCopy({
        roomStyle: analysis.roomStyle,
        productName: effectiveProductName,
        idea
      });

      // 11) sessionId
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

      logStep("EXPERIENCIA GENERADA OK", {
        elapsedMs: Date.now() - startedAt
      });

      // ====================== RESPUESTA FINAL BACKEND 🔥 ======================
      return res.status(200).json({
        ok: true,
        status: "complete",
        room_image: userImageUrl,
        ai_image: generatedImageUrl,
        product_url: productUrl || null,
        product_name: effectiveProductName,
        message,
        analysis,
        thumbnails,
        embedding: productEmbedding || null,
        created_at: new Date().toISOString()
      });
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

// ================== ARRANQUE SERVIDOR ==================

app.listen(PORT, () => {
  console.log(`🚀 INNOTIVA BACKEND PRO escuchando en puerto ${PORT}`);
});
