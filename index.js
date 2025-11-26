// ============================
// INNOTIVA BACKEND PRO
// IA PREMIUM + SHOPIFY
// SDXL INPAINTING + OPENAI + CLOUDINARY
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

// ----------------- CONFIG -----------------

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
const REPLICATE_MODEL =
  process.env.REPLICATE_FLUX_MODEL_ID ||
  "automation-agency/stable-diffusion-xl-inpainting-1.0";

// ----------------- MIDDLEWARE -----------------

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("INNOTIVA BACKEND PRO funcionando ✅");
});

// ----------------- HELPERS GENERALES -----------------

function logStep(step, extra = {}) {
  console.log(`[INNOTIVA] ${step}`, Object.keys(extra).length ? extra : "");
}

async function uploadBufferToCloudinary(buffer, folder, name = "image") {
  return cloudinary.uploader.upload(
    `data:image/jpeg;base64,${buffer.toString("base64")}`,
    {
      folder,
      public_id: `${name}-${Date.now()}`,
    }
  );
}

async function uploadUrlToCloudinary(url, folder, name = "from-url") {
  return cloudinary.uploader.upload(url, {
    folder,
    public_id: `${name}-${Date.now()}`,
  });
}

function buildShopifyProductGid(id) {
  const str = String(id);
  if (str.startsWith("gid://")) return str;
  return `gid://shopify/Product/${str}`;
}

// ----------------- SHOPIFY -----------------

async function fetchProductFromShopify(productId) {
  const query = `
    query GetProduct($id: ID!) {
      product(id: $id) {
        id
        title
        description
        featuredImage {
          url
        }
      }
    }
  `;

  const res = await fetch(
    `https://${SHOPIFY_STORE_DOMAIN}/api/2024-01/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": SHOPIFY_STOREFRONT_TOKEN,
      },
      body: JSON.stringify({
        query,
        variables: { id: buildShopifyProductGid(productId) },
      }),
    }
  );

  const json = await res.json();

  if (json.errors || !json.data?.product) {
    console.error("Error Shopify GraphQL:", JSON.stringify(json, null, 2));
    throw new Error("No se pudo obtener el producto desde Shopify");
  }

  return json.data.product;
}

// ----------------- OPENAI: EMBEDDING PRODUCTO -----------------

async function buildProductEmbedding(imageUrl, title) {
  if (!imageUrl) return null;

  logStep("OpenAI: embedding del producto", { title });

  const prompt = `
Analiza únicamente el producto que aparece en la imagen.
Devuélveme SOLO un JSON válido con esta estructura exacta:
{
  "colors": ["color1", "color2"],
  "materials": ["material1", "material2"],
  "texture": "descripción corta",
  "pattern": "descripción corta"
}
Sin texto extra, sin explicación adicional.
`;

  const response = await openai.responses.create({
    model: "gpt-4o-mini",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: imageUrl },
        ],
      },
    ],
  });

  const raw =
    response.output_text ||
    response.output?.[0]?.content?.[0]?.text ||
    "";

  const clean = raw
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  try {
    return JSON.parse(clean);
  } catch (e) {
    console.error("Error parseando embedding:", raw);
    return null;
  }
}

// ----------------- OPENAI: ANÁLISIS DEL CUARTO -----------------

async function analyzeRoom(roomImageUrl, productImageUrl, productName, idea) {
  logStep("OpenAI: análisis del cuarto");

  const prompt = `
Devuélveme SOLO un JSON válido con esta estructura EXACTA:

{
  "imageWidth": number,
  "imageHeight": number,
  "placement": { "x": number, "y": number, "width": number, "height": number }
}

Donde "placement" es la zona rectangular ideal para colocar el producto "${productName}" 
en la imagen del cuarto, usando también la idea del cliente: "${idea || ""}".
Las coordenadas están en píxeles respecto a la resolución original de la imagen del cuarto.
`;

  const response = await openai.responses.create({
    model: "gpt-4o-mini",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: roomImageUrl },
          { type: "input_image", image_url: productImageUrl },
        ],
      },
    ],
  });

  const raw =
    response.output_text ||
    response.output?.[0]?.content?.[0]?.text ||
    "";

  const clean = raw
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch (e) {
    console.error("Error parseando análisis:", raw);
    throw new Error("No se pudo analizar el cuarto");
  }

  if (
    !parsed.imageWidth ||
    !parsed.imageHeight ||
    !parsed.placement ||
    typeof parsed.placement.x !== "number"
  ) {
    throw new Error("Análisis de cuarto incompleto");
  }

  return parsed;
}

// ----------------- MÁSCARA -----------------

async function createMaskFromAnalysis(analysis) {
  const { imageWidth, imageHeight, placement } = analysis;
  const { x, y, width, height } = placement;

  const W = Math.max(1, Math.round(imageWidth));
  const H = Math.max(1, Math.round(imageHeight));

  const mask = Buffer.alloc(W * H, 0);

  for (let j = y; j < y + height; j++) {
    for (let i = x; i < x + width; i++) {
      if (i >= 0 && i < W && j >= 0 && j < H) {
        const idx = j * W + i;
        mask[idx] = 255;
      }
    }
  }

  const pngBuffer = await sharp(mask, {
    raw: { width: W, height: H, channels: 1 },
  })
    .png()
    .toBuffer();

  return pngBuffer.toString("base64");
}

// ----------------- REPLICATE (NUEVA API MODELS/{owner}/{name}) -----------------

async function callReplicateInpaint({ roomImageUrl, maskBase64, prompt }) {
  logStep("Replicate: generando imagen…", { model: REPLICATE_MODEL });

  // 1) Crear predicción usando endpoint de modelo (NO usamos "version")
  const createRes = await fetch(
    `https://api.replicate.com/v1/models/${REPLICATE_MODEL}/predictions`,
    {
      method: "POST",
      headers: {
        Authorization: `Token ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: {
          image: roomImageUrl,
          mask: `data:image/png;base64,${maskBase64}`,
          prompt,
        },
      }),
    }
  );

  const createJson = await createRes.json();

  if (!createRes.ok) {
    console.error("Replicate error (create):", createJson);
    throw new Error(
      createJson?.detail || "Replicate no pudo crear la predicción"
    );
  }

  let prediction = createJson;

  // 2) Polling hasta que termine
  while (
    prediction.status === "starting" ||
    prediction.status === "processing"
  ) {
    await new Promise((r) => setTimeout(r, 2500));
    const pollRes = await fetch(
      `https://api.replicate.com/v1/predictions/${prediction.id}`,
      {
        headers: { Authorization: `Token ${REPLICATE_API_TOKEN}` },
      }
    );
    prediction = await pollRes.json();
  }

  logStep("Replicate final:", {
    status: prediction.status,
  });

  if (prediction.status !== "succeeded") {
    console.error("Replicate final error:", prediction);
    throw new Error("Replicate falló");
  }

  const out = Array.isArray(prediction.output)
    ? prediction.output[0]
    : prediction.output;

  return out;
}

// ----------------- COPY EMOCIONAL -----------------

function buildEmotionalCopy(productName, idea) {
  let msg = `Visualizamos ${productName} integrado en tu espacio para que veas cómo se sentirá antes de tomar la decisión.`;
  if (idea && idea.trim().length > 0) {
    msg += ` También tuvimos en cuenta tu idea: “${idea.trim()}”.`;
  }
  msg += ` Buscamos mantener el estilo real de tu habitación, solo añadiendo el protagonismo del producto.`;
  return msg;
}

// ----------------- ENDPOINT PRINCIPAL -----------------

app.post(
  "/experiencia-premium",
  upload.single("roomImage"),
  async (req, res) => {
    const startedAt = Date.now();

    try {
      logStep("Nueva experiencia-premium recibida");

      const file = req.file;
      const { productId, productName, productUrl, idea } = req.body;

      if (!file) {
        return res
          .status(400)
          .json({ status: "error", message: "Falta la imagen del espacio." });
      }

      if (!productId) {
        return res
          .status(400)
          .json({ status: "error", message: "Falta el productId." });
      }

      // 1) Subir imagen del cuarto
      const roomUpload = await uploadBufferToCloudinary(
        file.buffer,
        "innotiva/rooms",
        "room"
      );
      const roomImageUrl = roomUpload.secure_url;

      logStep("Imagen del usuario subida a Cloudinary", { roomImageUrl });

      // 2) Traer producto de Shopify
      const productData = await fetchProductFromShopify(productId);

      const finalProductName =
        productName || productData.title || "tu producto";
      const productImageUrl = productData.featuredImage?.url;

      if (!productImageUrl) {
        throw new Error("El producto no tiene imagen destacada");
      }

      // 3) Embedding del producto (para prompt)
      const productEmbedding = await buildProductEmbedding(
        productImageUrl,
        finalProductName
      );

      // 4) Análisis del cuarto + placement
      const analysis = await analyzeRoom(
        roomImageUrl,
        productImageUrl,
        finalProductName,
        idea
      );

      // 5) Máscara inteligente
      const maskBase64 = await createMaskFromAnalysis(analysis);

      // 6) Prompt para Replicate
      const replicatePrompt = `
Inserta el producto "${finalProductName}" en la zona marcada por la máscara.
Respeta completamente la habitación original, su iluminación, perspectiva y colores.
No cambies muebles ni paredes; solo añade el producto de forma natural y realista.
Detalles del producto (ayuda a mantener consistencia): ${
        productEmbedding ? JSON.stringify(productEmbedding) : "sin detalles extra"
      }.
`;

      // 7) Llamar a Replicate
      const replicateImageUrl = await callReplicateInpaint({
        roomImageUrl,
        maskBase64,
        prompt: replicatePrompt,
      });

      if (!replicateImageUrl) {
        throw new Error("Replicate no devolvió imagen");
      }

      // 8) Subir imagen generada a Cloudinary
      const genUpload = await uploadUrlToCloudinary(
        replicateImageUrl,
        "innotiva/generated",
        "room-generated"
      );
      const generatedImageUrl = genUpload.secure_url;

      // 9) Mensaje emocional
      const message = buildEmotionalCopy(finalProductName, idea);

      const payload = {
        sessionId: crypto.randomUUID(),
        status: "success",
        userImageUrl: roomImageUrl,
        generatedImageUrl,
        productUrl: productUrl || null,
        productName: finalProductName,
        message,
        analysis,
        productEmbedding,
        createdAt: new Date().toISOString(),
      };

      logStep("Experiencia generada OK", {
        elapsedMs: Date.now() - startedAt,
      });

      return res.json(payload);
    } catch (err) {
      console.error("Error en /experiencia-premium:", err);
      return res.status(500).json({
        status: "error",
        message:
          "Tuvimos un problema al generar tu propuesta. Intenta de nuevo en unos minutos.",
      });
    }
  }
);

// ----------------- SERVIDOR -----------------

app.listen(PORT, () => {
  console.log(`🚀 INNOTIVA BACKEND PRO escuchando en puerto ${PORT}`);
});
