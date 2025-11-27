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
// ⚠️ Debe ser el **ID DE VERSIÓN** (no el nombre corto del modelo)
const REPLICATE_MODEL_VERSION = process.env.REPLICATE_MODEL_VERSION;

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

  // 0) Descargar la imagen de Cloudinary y convertirla a BASE64 (data URL)
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

  // 1) Prompt para que GPT devuelva SOLO JSON
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

  // 2) Llamada a OpenAI con imagen en BASE64 (NO URL externa)
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

  // 3) Extraer el texto devuelto por el modelo
  const content = response.output?.[0]?.content || [];
  const text = content
    .filter((c) => c.type === "output_text")
    .map((c) => c.text)
    .join("\n")
    .trim();

  // 4) Parsear a JSON usando tu helper existente
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
    .filter(c => c.type === "output_text")
    .map(c => c.text)
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

// ==================================================================================
// 🔥 INNOTIVA — Replicate FLUX 1.1 PRO Inpainting 100% COMPATIBLE (funciona con tu cuenta)
// ==================================================================================

async function callReplicateInpaint({ roomImageUrl, maskBase64, prompt }) {
  try {
    console.log("[INNOTIVA] Replicate → usando FLUX-1.1-PRO");

    const body = {
      input: {
        prompt,
        image: roomImageUrl,
        mask: maskBase64,
        width: 1024,
        height: 1024,
        num_inference_steps: 28,
        guidance_scale: 3.5
      }
    };

    const response = await fetch(
      "https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro/predictions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      }
    );

    let prediction = await response.json();

    if (!prediction.id) {
      console.log("REP ERR =>", prediction);
      throw new Error("No se pudo crear la predicción en Replicate");
    }

    // 🔄 Esperar resultado
    while (prediction.status !== "succeeded" && prediction.status !== "failed") {
      await new Promise(r => setTimeout(r, 2000));
      const check = await fetch(
        `https://api.replicate.com/v1/predictions/${prediction.id}`,
        {
          headers: { Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}` }
        }
      );
      prediction = await check.json();
    }

    if (prediction.status === "failed") {
      console.log("REP FAILED =>", prediction);
      throw new Error("Replicate falló");
    }

    console.log("[INNOTIVA] IA generada ✔");

    // 🧠 Normalizar la salida para evitar el bug de "h"
    let finalUrl = null;
    const out = prediction.output;

    if (typeof out === "string") {
      // Caso: output es directamente una URL string
      finalUrl = out;
    } else if (Array.isArray(out) && out.length > 0) {
      // Caso: array de URLs
      finalUrl = out[0];
    } else if (out && typeof out === "object" && out.image) {
      // Caso: objeto con campo image
      finalUrl = out.image;
    }

    if (!finalUrl && prediction.output_url) {
      finalUrl = prediction.output_url;
    }

    console.log("🔵 URL FINAL DE REPLICATE:", finalUrl);

    return finalUrl;
  } catch (e) {
    console.error("🔥 ERROR INPAINT REPLICATE", e);
    throw e;
  }
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

      logStep("Imagen del usuario subida a Cloudinary", { roomImageUrl: userImageUrl });

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

      // 6) Máscara
      const maskBase64 = await createMaskFromAnalysis(analysis);

        // 7) Replicate inpainting — prompt ULTRA ESTRICTO usando el embedding visual
      const visualHints = productEmbedding
        ? `
Colores principales del producto: ${(productEmbedding.colors || []).join(", ")}.
Materiales: ${(productEmbedding.materials || []).join(", ")}.
Textura: ${productEmbedding.texture || ""}.
Patrón o diseño: ${productEmbedding.pattern || ""}.
`
        : "";

      const prompt = `
Eres un modelo experto en interiorismo realista y fotorealismo. 
Tienes una fotografía REAL de un espacio y debes INTEGRAR UN ÚNICO producto de decoración en la zona marcada por la máscara.

Producto a integrar (NO inventes otro distinto):
${effectiveProductName}.

${visualHints}

Reglas OBLIGATORIAS:
1. No cambies la arquitectura del espacio (paredes, techo, ventanas, puertas se quedan igual).
2. No muevas ni borres muebles existentes, sólo integra el producto en la zona enmascarada.
3. Mantén el estilo del espacio: ${analysis.roomStyle || "tu espacio"}.
4. Mantén iluminación, sombras y perspectiva coherentes con la foto original.
5. El producto debe verse protagonista, nítido y realista, como si realmente estuviera en la foto.
6. No agregues texto, logos ni elementos extra que no sean necesarios.

Si el producto es un CUADRO:
- Colócalo en la pared de forma coherente.
- A una altura natural (aproximadamente a la altura de los ojos).
- Centrado respecto al mueble principal más cercano.
- Con proporciones realistas (ni gigante ni diminuto).

Genera UNA sola imagen final muy realista del MISMO espacio, con el producto integrado en la zona marcada.
`;

      const generatedImageUrlFromReplicate = await callReplicateInpaint({
        roomImageUrl: userImageUrl,
        maskBase64,
        prompt
      });

      // 8) Subir resultado a Cloudinary (SE LOGUEA LA URL ORIGINAL PARA DEBUG)
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


      // 8) Subir resultado a Cloudinary (SE LOGUEA LA URL ORIGINAL PARA DEBUG)
      console.log("🔥 URL RAW desde Replicate =>", generatedImageUrlFromReplicate);

      const uploadGenerated = await uploadUrlToCloudinary(
        generatedImageUrlFromReplicate, // <-- AQUÍ SE USA DIRECTO
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

      // 9) Copy emocional
      const message = buildEmotionalCopy({
        roomStyle: analysis.roomStyle,
        productName: effectiveProductName,
        idea
      });

      // 10) sessionId
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
