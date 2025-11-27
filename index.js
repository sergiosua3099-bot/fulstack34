// index.js
// INNOTIVA BACKEND PRO – Experiencia Premium IA
// Flujo:
// 1) Recibe form (roomImage + producto + idea)
// 2) Sube room a Cloudinary
// 3) Trae producto desde Shopify
// 4) Recorta producto en Cloudinary (PNG cuadrado PRO)
// 5) (Opcional) Embedding visual rápido del producto con OpenAI Vision
// 6) Crea máscara central 1024x1024
// 7) Llama a Replicate (inpainting) manteniendo la sala y añadiendo el producto
// 8) Devuelve JSON que tu /resultado-ia ya sabe leer

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const crypto = require("crypto");
const sharp = require("sharp");
const OpenAI = require("openai");
const cloudinary = require("cloudinary").v2;

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

const PORT = process.env.PORT || 10000;

// ==== CLIENTES ====

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
const REPLICATE_MODEL_ID = process.env.REPLICATE_FLUX_MODEL_ID;

// ==== UTILS ====

function logStep(step, extra = null) {
  if (extra) {
    console.log(`[INNOTIVA] ${step}`, extra);
  } else {
    console.log(`[INNOTIVA] ${step}`);
  }
}

function buildShopifyProductGid(numericId) {
  const s = String(numericId);
  if (s.startsWith("gid://")) return s;
  return `gid://shopify/Product/${s}`;
}

/**
 * Sube buffer de imagen (room) a Cloudinary.
 */
async function uploadBufferToCloudinary(buffer, folder, filenameHint = "image") {
  return new Promise((resolve, reject) => {
    const base64 = buffer.toString("base64");
    cloudinary.uploader.upload(
      `data:image/jpeg;base64,${base64}`,
      {
        folder,
        public_id: `${filenameHint}-${Date.now()}`,
        resource_type: "image"
      },
      (err, result) => {
        if (err) return reject(err);
        resolve(result);
      }
    );
  });
}

/**
 * Sube y recorta el producto a PNG cuadrado 1024x1024
 * usando la URL de Shopify.
 */
async function uploadAndCropProduct(productImageUrl) {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload(
      productImageUrl,
      {
        folder: "innotiva/products/raw",
        public_id: `product-original-${Date.now()}`,
        format: "png",
        transformation: [
          {
            width: 1024,
            height: 1024,
            crop: "fill",
            gravity: "auto",
            quality: 90
          }
        ]
      },
      (err, result) => {
        if (err) return reject(err);
        resolve(result);
      }
    );
  });
}

/**
 * Genera thumbnails para la vista previa (no obligatorios para el front actual,
 * pero útiles si luego quieres).
 */
function buildThumbnails(publicId) {
  const before = cloudinary.url(publicId, {
    width: 600,
    height: 400,
    crop: "fill",
    quality: 80,
    secure: true
  });

  const beforeSmall = cloudinary.url(publicId, {
    width: 400,
    height: 300,
    crop: "fill",
    quality: 70,
    secure: true
  });

  return {
    main: before,
    small: beforeSmall
  };
}

/**
 * Fetch del producto desde Shopify (Storefront).
 */
async function fetchProductFromShopify(productId) {
  const gid = buildShopifyProductGid(productId);

  const query = `
    query GetProduct($id: ID!) {
      product(id: $id) {
        id
        title
        description
        productType
        featuredImage {
          url
        }
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

  if (json.errors || !json.data || !json.data.product) {
    console.error("Error Shopify:", JSON.stringify(json, null, 2));
    throw new Error("No se pudo obtener el producto desde Shopify");
  }

  const p = json.data.product;
  return {
    id: p.id,
    title: p.title,
    description: p.description || "",
    productType: p.productType || "",
    featuredImage: p.featuredImage ? p.featuredImage.url : null
  };
}

/**
 * Extrae el JSON de una respuesta que pueda venir con ``` o texto extra.
 */
function extractJsonString(text) {
  if (!text) return null;
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1) return null;
  return text.slice(firstBrace, lastBrace + 1);
}

/**
 * Embedding visual simple del producto (colores/materiales/etc).
 * Usa OpenAI Vision con la imagen recortada del producto.
 */
async function buildProductEmbedding(productTitle, productCutoutUrl) {
  try {
    logStep("OpenAI: embedding del producto", { title: productTitle });

    const prompt = `
Analiza únicamente el producto de la imagen (ignora el fondo).
Devuélveme SOLO un JSON puro con esta estructura EXACTA:

{
  "colors": ["color1", "color2"],
  "materials": ["material1", "material2"],
  "texture": "descripción muy corta",
  "pattern": "descripción muy corta"
}

Sin texto adicional, sin backticks, sin "json".
    `.trim();

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            {
              type: "input_image",
              image_url: productCutoutUrl // IMPORTANTE: string, no objeto
            }
          ]
        }
      ]
    });

    const raw =
      (response.output &&
        response.output[0] &&
        response.output[0].content &&
        response.output[0].content[0] &&
        (response.output[0].content[0].text ||
          response.output[0].content[0].content)) ||
      "";

    const jsonStr = extractJsonString(raw);
    if (!jsonStr) {
      console.warn("[INNOTIVA] No se pudo extraer JSON de embedding:", raw);
      return null;
    }

    return JSON.parse(jsonStr);
  } catch (err) {
    console.error("Error parseando embedding:", err);
    return null;
  }
}

/**
 * Crea una máscara rectangular central en 1024x1024.
 * Blanco = zona a editar, negro = mantener.
 */
async function createCenterMask1024() {
  const W = 1024;
  const H = 1024;

  // Rectángulo central (un poco más ancho que alto)
  const marginX = Math.round(W * 0.18);
  const marginY = Math.round(H * 0.25);
  const mask = Buffer.alloc(W * H, 0);

  for (let y = marginY; y < H - marginY; y++) {
    for (let x = marginX; x < W - marginX; x++) {
      const idx = y * W + x;
      mask[idx] = 255;
    }
  }

  const pngBuffer = await sharp(mask, {
    raw: { width: W, height: H, channels: 1 }
  })
    .png()
    .toBuffer();

  return pngBuffer.toString("base64");
}

/**
 * Llamada genérica a Replicate (inpainting).
 */
async function callReplicateInpaint({ roomImageUrlForAI, maskBase64, prompt }) {
  logStep("INNOTIVA Replicate: generando imagen…", {
    model: REPLICATE_MODEL_ID
  });

  const input = {
    image: roomImageUrlForAI,
    mask: `data:image/png;base64,${maskBase64}`,
    prompt,
    // algunos modelos aceptan más parámetros, esto es lo básico
  };

  let url;
  let body;

  if (REPLICATE_MODEL_ID && REPLICATE_MODEL_ID.includes("/")) {
    // Forma /models/{owner}/{name}/predictions
    url = `https://api.replicate.com/v1/models/${REPLICATE_MODEL_ID}/predictions`;
    body = { input };
  } else {
    // Forma clásica /v1/predictions con "version"
    url = "https://api.replicate.com/v1/predictions";
    body = {
      version: REPLICATE_MODEL_ID,
      input
    };
  }

  const createRes = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Token ${REPLICATE_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const prediction = await createRes.json();

  if (!createRes.ok) {
    console.error("Replicate error (create):", prediction);
    throw new Error("Replicate: la creación de predicción falló");
  }

  let finalPrediction = prediction;
  const pollUrl = `https://api.replicate.com/v1/predictions/${prediction.id}`;

  while (
    finalPrediction.status === "starting" ||
    finalPrediction.status === "processing" ||
    finalPrediction.status === "queued"
  ) {
    await new Promise((r) => setTimeout(r, 2500));

    const pollRes = await fetch(pollUrl, {
      headers: {
        Authorization: `Token ${REPLICATE_API_TOKEN}`
      }
    });

    finalPrediction = await pollRes.json();
  }

  logStep("Replicate final:", finalPrediction);

  if (finalPrediction.status !== "succeeded") {
    throw new Error("Replicate falló");
  }

  const out = finalPrediction.output;
  const imageUrl = Array.isArray(out) ? out[0] : out;
  return imageUrl;
}

/**
 * Mensaje emocional para /resultado-ia
 */
function buildEmotionalCopy({ productName, idea }) {
  let msg = `Diseñamos esta propuesta pensando en el equilibrio entre tu espacio y ${productName || "tu producto"}.`;
  if (idea && idea.trim()) {
    msg += ` También tuvimos en cuenta tu idea: “${idea.trim()}”.`;
  }
  msg += ` La idea es que puedas visualizarlo antes de tomar la decisión final.`;
  return msg;
}

// ==== ENDPOINTS BÁSICOS ====

app.get("/", (req, res) => {
  res.send("INNOTIVA BACKEND PRO funcionando ✅");
});

app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ==== ENDPOINT PRINCIPAL: /experiencia-premium ====

app.post(
  "/experiencia-premium",
  upload.single("roomImage"), // IMPORTANTE: EXACTO AL FORM
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

      // 1) Subir room original a Cloudinary
      const roomUpload = await uploadBufferToCloudinary(
        file.buffer,
        "innotiva/rooms",
        "room"
      );

      const userImageUrl = roomUpload.secure_url;
      const roomPublicId = roomUpload.public_id;

      logStep("Imagen del usuario subida a Cloudinary", { roomImageUrl: userImageUrl });

      // URL derivada 1024x1024 para IA (no cambia la original que verá el cliente)
      const roomImageUrlForAI = cloudinary.url(roomPublicId, {
        width: 1024,
        height: 1024,
        crop: "fill",
        quality: 90,
        secure: true
      });

      // 2) Producto desde Shopify
      const productData = await fetchProductFromShopify(productId);
      const effectiveProductName =
        productName || productData.title || "tu producto";

      // 3) Recorte PRO del producto en Cloudinary (PNG)
      let productCutoutUrl = null;
      if (productData.featuredImage) {
        const productUpload = await uploadAndCropProduct(
          productData.featuredImage
        );
        productCutoutUrl = productUpload.secure_url;
        logStep("Producto recortado", { productCutoutUrl });
      }

      // 4) Embedding visual del producto (opcional, si algo falla seguimos)
      let productEmbedding = null;
      if (productCutoutUrl) {
        productEmbedding = await buildProductEmbedding(
          effectiveProductName,
          productCutoutUrl
        );
      }

      // 5) Máscara central
      const maskBase64 = await createCenterMask1024();

      // 6) Prompt para Replicate
      const promptParts = [];

      promptParts.push(
        `Integra cuidadosamente un ${effectiveProductName} en la pared o zona más coherente del ambiente, ` +
          `manteniendo intacta la estructura del cuarto, muebles y proporciones.`
      );

      if (idea && idea.trim()) {
        promptParts.push(
          `Ten en cuenta la idea del cliente: "${idea.trim()}".`
        );
      }

      if (productEmbedding) {
        promptParts.push(
          `Respeta estos rasgos del producto: colores ${JSON.stringify(
            productEmbedding.colors || []
          )}, materiales ${JSON.stringify(
            productEmbedding.materials || []
          )}, textura "${productEmbedding.texture || ""}".`
        );
      }

      promptParts.push(
        "Respeta la iluminación y el estilo real de la habitación. La imagen final debe parecer una fotografía realista, sin cambiar el sofá ni los muebles principales."
      );

      const finalPrompt = promptParts.join(" ");

      // 7) Llamada a Replicate
      const replicateImageUrl = await callReplicateInpaint({
        roomImageUrlForAI,
        maskBase64,
        prompt: finalPrompt
      });

      // 8) Subir resultado de Replicate a Cloudinary (para tener URL estable)
      const generatedUpload = await new Promise((resolve, reject) => {
        cloudinary.uploader.upload(
          replicateImageUrl,
          {
            folder: "innotiva/generated",
            public_id: `room-generated-${Date.now()}`,
            resource_type: "image"
          },
          (err, result) => {
            if (err) return reject(err);
            resolve(result);
          }
        );
      });

      const generatedImageUrl = generatedUpload.secure_url;

      // Thumbnails por si los llegas a usar luego
      const thumbnails = {
        before: buildThumbnails(roomPublicId),
        after: buildThumbnails(generatedUpload.public_id)
      };

      // 9) Mensaje emocional
      const message = buildEmotionalCopy({
        productName: effectiveProductName,
        idea
      });

      // 10) SessionId
      const sessionId = crypto.randomUUID();

      const payload = {
        sessionId,
        status: "success",
        userImageUrl,        // ANTES para resultado-ia
        generatedImageUrl,   // DESPUÉS IA para resultado-ia
        productUrl: productUrl || null,
        productName: effectiveProductName,
        message,
        thumbnails,
        productEmbedding,
        createdAt: new Date().toISOString()
      };

      logStep("EXPERIENCIA GENERADA OK", {
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

// ==== ARRANQUE SERVIDOR ====

app.listen(PORT, () => {
  console.log(`🚀 INNOTIVA BACKEND PRO escuchando en puerto ${PORT}`);
});
