// ===========================================
// BACKEND PRO INNOTIVA – VERSION JSON-SEGURO
// FLUX Inpainting + OpenAI gpt-4o-mini
// ===========================================

require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const sharp = require("sharp");
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
// Usamos el modelo que tú definiste:
const REPLICATE_MODEL = "black-forest-labs/flux-1-dev-inpainting";

// ---------------------------
// MIDDLEWARE BÁSICO
// ---------------------------

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("INNOTIVA BACKEND PRO funcionando ✅");
});

app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ---------------------------
// HELPERS GENERALES
// ---------------------------

function logStep(step, extra = {}) {
  console.log(`[INNOTIVA] ${step}`, Object.keys(extra).length ? extra : "");
}

// Forzar HTTPS siempre
function forceHttps(url) {
  if (!url) return url;
  return url.replace("http://", "https://");
}

// Sanitizar texto que viene como ```json ... ```
function sanitizeJsonText(text) {
  if (!text) return text;
  let t = String(text).trim();

  // quitar ```json y ``` si envuelve todo
  if (t.startsWith("```")) {
    t = t.replace(/^```[a-zA-Z]*\n?/, "");
  }
  if (t.endsWith("```")) {
    t = t.replace(/```$/, "");
  }

  t = t.trim();

  // extraer desde la primera llave hasta la última
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    t = t.slice(first, last + 1);
  }

  return t.trim();
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
    console.error("Shopify error:", JSON.stringify(json, null, 2));
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
Analiza únicamente el producto de la imagen y devuélveme SOLO un JSON puro, sin backticks, sin texto extra, sin "```json".
Formato EXACTO:
{
  "colors": ["color1", "color2"],
  "materials": ["material1", "material2"],
  "texture": "descripción corta",
  "pattern": "descripción corta"
}
`;

  const response = await openai.responses.create({
    model: "gpt-4o-mini",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          {
            type: "input_image",
            // IMPORTANTE: string directo, no objeto
            image_url: forceHttps(product.featuredImage)
          }
        ]
      }
    ]
  });

  const raw = response.output[0].content[0].text;
  const cleaned = sanitizeJsonText(raw);

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.error("Error parseando embedding:", cleaned);
    // seguimos, pero sin embedding detallado
    return null;
  }
}

// ---------------------------
// OPENAI – ANÁLISIS DEL CUARTO + BBOX
// ---------------------------

async function analyzeRoom(roomImageUrl, productImageUrl, productEmbedding, ideaText, productName) {
  logStep("OpenAI: análisis del cuarto");

  const prompt = `
Quiero que devuelvas SOLO un JSON (sin backticks, sin "```json") con esta estructura EXACTA y con NÚMEROS, no texto:

{
  "imageWidth": number,
  "imageHeight": number,
  "roomStyle": "string",
  "detectedAnchors": ["string"],
  "placement": { "x": number, "y": number, "width": number, "height": number },
  "conflicts": [
    { "type": "string", "description": "string" }
  ],
  "finalPlacement": { "x": number, "y": number, "width": number, "height": number }
}

Reglas:
- Usa coordenadas y tamaños en PIXELES relativos al tamaño de la imagen.
- NO describas muebles dentro de "placement" ni "finalPlacement", solo números.
- Si no estás seguro, coloca un rectángulo centrado (x, y, width, height) donde quedaría bien el producto sobre la pared principal.
- imageWidth e imageHeight deben ser números enteros > 0.
- NO devuelvas texto fuera del JSON.
Idea del cliente (puede estar vacía): "${ideaText || ""}"
Nombre del producto: "${productName}"
`;

  const content = [
    { type: "input_text", text: prompt },
    {
      type: "input_image",
      image_url: forceHttps(roomImageUrl)
    }
  ];

  if (productImageUrl) {
    content.push({
      type: "input_image",
      image_url: forceHttps(productImageUrl)
    });
  }

  const response = await openai.responses.create({
    model: "gpt-4o-mini",
    input: [{ role: "user", content }]
  });

  const raw = response.output[0].content[0].text;
  const cleaned = sanitizeJsonText(raw);

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    console.error("Error parseando análisis:", cleaned);
    // fallback duro: asumimos 1024x1024 y bbox centrado
    const w = 1024;
    const h = 1024;
    return {
      imageWidth: w,
      imageHeight: h,
      roomStyle: "Estilo no detectado",
      detectedAnchors: [],
      placement: {
        x: Math.round(w * 0.2),
        y: Math.round(h * 0.15),
        width: Math.round(w * 0.6),
        height: Math.round(h * 0.5)
      },
      conflicts: [],
      finalPlacement: {
        x: Math.round(w * 0.2),
        y: Math.round(h * 0.15),
        width: Math.round(w * 0.6),
        height: Math.round(h * 0.5)
      }
    };
  }

  // Normalización y fallback si faltan números
  let imageWidth = parseInt(parsed.imageWidth, 10);
  let imageHeight = parseInt(parsed.imageHeight, 10);

  if (!Number.isFinite(imageWidth) || imageWidth <= 0) imageWidth = 1024;
  if (!Number.isFinite(imageHeight) || imageHeight <= 0) imageHeight = 1024;

  function normalizeBox(box) {
    if (!box) return null;
    let x = parseInt(box.x, 10);
    let y = parseInt(box.y, 10);
    let w = parseInt(box.width, 10);
    let h = parseInt(box.height, 10);

    if (!Number.isFinite(x) || !Number.isFinite(y) ||
        !Number.isFinite(w) || !Number.isFinite(h) ||
        w <= 0 || h <= 0) {
      return null;
    }

    // clamp
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    if (x + w > imageWidth) w = imageWidth - x;
    if (y + h > imageHeight) h = imageHeight - y;

    return { x, y, width: w, height: h };
  }

  let placement = normalizeBox(parsed.placement);
  let finalPlacement = normalizeBox(parsed.finalPlacement);

  // si OpenAI no respetó, generamos bbox centrado
  if (!placement || !finalPlacement) {
    const wBox = Math.round(imageWidth * 0.6);
    const hBox = Math.round(imageHeight * 0.5);
    const xBox = Math.round((imageWidth - wBox) / 2);
    const yBox = Math.round((imageHeight - hBox) / 3);

    placement = { x: xBox, y: yBox, width: wBox, height: hBox };
    finalPlacement = { ...placement };
  }

  if (!Array.isArray(parsed.detectedAnchors)) {
    parsed.detectedAnchors = [];
  }
  if (!Array.isArray(parsed.conflicts)) {
    parsed.conflicts = [];
  }

  return {
    imageWidth,
    imageHeight,
    roomStyle: parsed.roomStyle || "Tu espacio",
    detectedAnchors: parsed.detectedAnchors,
    placement,
    conflicts: parsed.conflicts,
    finalPlacement
  };
}

// ---------------------------
// CREAR MÁSCARA
// ---------------------------

async function createMask(analysis) {
  const { imageWidth, imageHeight, finalPlacement } = analysis;
  const w = Math.max(1, Math.round(imageWidth));
  const h = Math.max(1, Math.round(imageHeight));

  const { x, y, width, height } = finalPlacement;

  const mask = Buffer.alloc(w * h, 0);

  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(w, x + width);
  const y1 = Math.min(h, y + height);

  for (let j = y0; j < y1; j++) {
    for (let i = x0; i < x1; i++) {
      const idx = j * w + i;
      mask[idx] = 255;
    }
  }

  const png = await sharp(mask, {
    raw: { width: w, height: h, channels: 1 }
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
NO cambies paredes, muebles, ventanas ni colores generales.
Solo edita la zona marcada por la máscara.

Inserta el producto real "${productName}" sin reinterpretarlo:
- misma forma y proporciones
- mismos colores
- mismo material

Haz que parezca una fotografía real.

Detalles del producto (pueden ayudarte):
${productEmbedding ? JSON.stringify(productEmbedding) : "sin embedding detallado"}
`;

  const inputPayload = {
    image: forceHttps(roomImageUrl),
    mask: `data:image/png;base64,${maskBase64}`,
    prompt,
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
      input: inputPayload
    })
  });

  let json = await res.json();

  while (json.status === "starting" || json.status === "processing") {
    await new Promise(r => setTimeout(r, 2000));
    const poll = await fetch(
      `https://api.replicate.com/v1/predictions/${json.id}`,
      {
        headers: { "Authorization": `Token ${REPLICATE_API_TOKEN}` }
      }
    );
    json = await poll.json();
  }

  if (json.status !== "succeeded") {
    console.error("Replicate no succeeded:", json);
    throw new Error("Replicate no generó la imagen");
  }

  const out = Array.isArray(json.output) ? json.output[0] : json.output;
  return forceHttps(out);
}

// ---------------------------
// COPY EMOCIONAL
// ---------------------------

function buildCopy(roomStyle, productName, idea) {
  let msg = `Diseñamos esta propuesta respetando el estilo de ${roomStyle}. `;
  msg += `Integramos ${productName} como protagonista sin alterar tu espacio real. `;
  if (idea && idea.trim()) {
    msg += `Tuvimos en cuenta tu idea: “${idea.trim()}”. `;
  }
  msg += "Así puedes visualizar cómo se vería realmente antes de decidir.";
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

    if (!file) {
      return res.status(400).json({
        status: "error",
        message: "Falta la imagen del espacio."
      });
    }

    if (!productId) {
      return res.status(400).json({
        status: "error",
        message: "Falta el productId."
      });
    }

    // 1) Subir imagen del usuario
    const up = await uploadBufferToCloudinary(file.buffer, "innotiva/rooms", "room");
    const roomImageUrl = up.secure_url;
    logStep("Imagen usuario subida", { roomImageUrl });

    // 2) Producto desde Shopify
    const product = await fetchProductFromShopify(productId);
    const finalName = productName || product.title;
    logStep("Producto Shopify", { id: product.id, title: finalName });

    // 3) Recorte del producto (usamos la imagen destacada tal cual por ahora)
    const cut = await uploadUrlToCloudinary(
      forceHttps(product.featuredImage),
      "innotiva/products/raw",
      "product-original"
    );
    const productCutoutUrl = cut.secure_url;
    logStep("Producto recortado", { productCutoutUrl });

    // 4) Embedding del producto (opcional, no bloquea flujo)
    const embedding = await buildProductEmbedding({
      title: finalName,
      featuredImage: productCutoutUrl
    });

    // 5) Análisis del cuarto + bbox
    const analysis = await analyzeRoom(
      roomImageUrl,
      productCutoutUrl,
      embedding,
      idea,
      finalName
    );

    // 6) Crear máscara desde ese análisis
    const maskBase64 = await createMask(analysis);

    // 7) Generar imagen con FLUX inpainting
    const generatedUrl = await callReplicate({
      roomImageUrl,
      maskBase64,
      productName: finalName,
      productEmbedding: embedding
    });

    // 8) Subir resultado a Cloudinary
    const genUp = await uploadUrlToCloudinary(
      generatedUrl,
      "innotiva/generated",
      "generated"
    );
    const finalGeneratedUrl = genUp.secure_url;

    // 9) Copy emocional
    const message = buildCopy(analysis.roomStyle, finalName, idea);

    // 10) Respuesta final al front
    const payload = {
      status: "success",
      userImageUrl: roomImageUrl,
      generatedImageUrl: finalGeneratedUrl,
      productUrl: productUrl || null,
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
      message: "Tuvimos un problema al generar tu propuesta. Intenta de nuevo."
    });
  }
});

// ---------------------------
// ARRANQUE SERVIDOR
// ---------------------------

app.listen(PORT, () => {
  console.log(`🚀 INNOTIVA BACKEND PRO escuchando en puerto ${PORT}`);
});
