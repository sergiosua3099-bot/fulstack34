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
const fetch = global.fetch;

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

  // Recorte + calidad
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

// 1) Embedding visual del producto
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
// ============ POSICIÓN DE LA MÁSCARA SEGÚN PRODUCTO + IDEA ============

function determineMaskPosition(analysis, productType = "", ideaText = "") {
  const imageWidth = analysis.imageWidth || 1200;
  const imageHeight = analysis.imageHeight || 800;

  let width = Math.round(imageWidth * 0.28);
  let height = Math.round(imageHeight * 0.22);
  let x = Math.round((imageWidth - width) / 2);
  let y = Math.round((imageHeight - height) / 2);

  const type = (productType || "").toLowerCase();
  const idea = (ideaText || "").toLowerCase();

  // Cuadros
  if (/(cuadro|frame|marco|poster|lienzo|art)/i.test(type)) {
    y = Math.round(imageHeight * 0.18);
    height = Math.round(imageHeight * 0.26);
  }

  // Muebles bajos
  if (/(mesa|table|coffee|sofá|sofa|mueble|aparador)/i.test(type)) {
    y = Math.round(imageHeight * 0.55);
    height = Math.round(imageHeight * 0.30);
  }

  // Lámparas
  if (/(lámpara|lampara|lamp|ceiling|techo|hanging)/i.test(type)) {
    y = Math.round(imageHeight * 0.08);
    height = Math.round(imageHeight * 0.20);
  }

  // Decor pequeño
  if (/(decor|florero|plant|planta|figura|ornamento)/i.test(type)) {
    width = Math.round(imageWidth * 0.25);
    height = Math.round(imageHeight * 0.22);
    y = Math.round(imageHeight * 0.60);
  }

  // Idea del cliente
  if (idea) {
    if (/arriba|superior/i.test(idea)) y = Math.round(imageHeight * 0.10);
    if (/abajo|inferior/i.test(idea)) y = Math.round(imageHeight * 0.65);
    if (/izquierda/i.test(idea)) x = Math.round(imageWidth * 0.10);
    if (/derecha/i.test(idea)) x = Math.round(imageWidth * 0.60);
    if (/centro|centrado/i.test(idea))
      x = Math.round((imageWidth - width) / 2);
    if (/esquina/i.test(idea)) width = Math.round(imageWidth * 0.22);
  }

  // Clamp
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
//  🔥 FLUX-FILL-DEV — con fallback (NO usado ahora, pero lo dejamos por si)
// ===================================================

async function generateWithFlux({ roomImageUrl, maskBase64, prompt }) {
  const maskDataUrl = `data:image/png;base64,${maskBase64}`;

  const configs = [
    { steps: 28, mp: "match_input", guidance: 4.0 },
    { steps: 24, mp: "1", guidance: 5.5 },
    { steps: 20, mp: "0.7", guidance: 7.0 }
  ];

  for (const cfg of configs) {
    try {
      logStep("🧩 Enviando a FLUX", cfg);

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
              prompt,
              guidance: cfg.guidance,
              num_inference_steps: cfg.steps,
              output_format: "webp",
              output_quality: 99,
              megapixels: cfg.mp
            }
          })
        }
      );

      const prediction = await createRes.json();

      if (prediction?.output?.[0]) {
        console.log("🟢 Resultado final FLUX:", prediction.output[0]);
        return prediction.output[0];
      } else {
        console.error("⛔ FLUX sin output en config", cfg, prediction);
      }
    } catch (e) {
      console.error("Error llamando FLUX en config", cfg, e);
    }
  }

  throw new Error("Flux-fill-dev no devolvió imagen en ningún intento");
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

     // ====================== 6) Ajustar placement + crear máscara ====================== //

const refinedPlacement = determineMaskPosition(
  analysis,
  productData.productType,
  idea
);
analysis.finalPlacement = refinedPlacement;

logStep("Generando máscara...");
const maskBase64 = await createMaskFromAnalysis(analysis);
logStep("Máscara generada correctamente");


// ====================== 7) PROMPT MEGA-ENRIQUECIDO PARA FLUX ====================== //

// Contexto visual del producto (si existe embedding)
const visual = productEmbedding
  ? `
[DATOS VISUALES DEL PRODUCTO]
- Colores predominantes reales: ${(productEmbedding.colors || []).join(", ")}
- Materiales principales: ${(productEmbedding.materials || []).join(", ")}
- Textura percibida: ${productEmbedding.texture || "-"}
- Patrón o diseño: ${productEmbedding.pattern || "-"}
`
  : `
[DATOS VISUALES DEL PRODUCTO]
No se proporcionó metadata visual detallada. Asume que es un producto físico real,
con materiales creíbles y acabado natural (nada caricaturesco ni plástico exagerado).
`;

// Contexto del espacio analizado
const roomContext = `
[CONTEXTO DEL ESPACIO]
- Estilo aproximado del espacio: ${analysis.roomStyle || "interior neutro y habitable"}.
- Resolución estimada: ${analysis.imageWidth || "desconocido"} x ${
  analysis.imageHeight || "desconocido"
} píxeles.
- Zona reservada para el producto (máscara blanca), en coordenadas de la imagen:
  • x: ${analysis.finalPlacement.x}
  • y: ${analysis.finalPlacement.y}
  • width: ${analysis.finalPlacement.width}
  • height: ${analysis.finalPlacement.height}
`;

// Contexto de la idea del cliente (si existe)
const ideaContext =
  idea && idea.trim().length > 0
    ? `
[INTENCIÓN DEL CLIENTE]
El cliente dejó esta indicación sobre cómo le gustaría ver el producto:

"${idea.trim()}"

Debes respetar esta intención en posición, orientación y presencia del producto,
siempre que no rompa las reglas de realismo físico y coherencia con la habitación.
`
    : `
[INTENCIÓN DEL CLIENTE]
El cliente no dio instrucciones específicas. Optimiza posición y escala del producto
para que se vea natural, armónico y aspiracional dentro del espacio.
`;

// Comportamiento según el tipo de producto
const rawType = productData.productType || "";
const productTypeLower = rawType.toLowerCase();

let productBehaviorBlock = `
[COMPORTAMIENTO POR DEFECTO DEL PRODUCTO]
No se reconoce una categoría específica. Trátalo como un objeto físico real:
- Debe tener volumen creíble.
- Debe "apoyarse" o "anclarse" a alguna superficie lógica (suelo, pared, techo, mueble).
- Nunca debe flotar sin soporte.
- Tamaño moderado, que tenga sentido en comparación con muebles y paredes visibles.
`;

if (/(cuadro|lienzo|poster|marco|print|art)/i.test(rawType)) {
  productBehaviorBlock = `
[COMPORTAMIENTO: CUADRO / LIENZO / ARTE EN PARED]
- Trátalo como una pieza de arte montada en la pared.
- El plano del cuadro debe ser prácticamente paralelo al plano de la pared.
- No debe sobresalir de forma absurda ni parecer pegado de forma plana de collage.
- Escala sugerida: ancho visual entre 60–140 cm, en proporción con el sofá, cama o mueble cercano.
- No generes marcos exagerados ni reflejos metálicos irreales.
`;
} else if (/(lámpara|lampara|ceiling|techo|aplique|colgante|pendant)/i.test(rawType)) {
  productBehaviorBlock = `
[COMPORTAMIENTO: LÁMPARA / ILUMINACIÓN]
- Debe estar conectada lógicamente a techo o pared (jamás flotando sola en el aire).
- La luz emitida debe ser coherente con la iluminación actual del cuarto.
- No cambies toda la iluminación de la escena; solo añade aportes sutiles.
- Prohibido crear haces de luz exagerados o efectos "fantasía".
`;
} else if (/(sofá|sofa|sillon|sillón|mueble|aparador|console|sideboard|rack|tv stand)/i.test(rawType)) {
  productBehaviorBlock = `
[COMPORTAMIENTO: MUEBLE / SOFÁ / APARADOR]
- El producto debe apoyarse claramente sobre el suelo o sobre una base visible.
- Debe respetar la perspectiva del suelo: líneas de fuga y horizontes coherentes.
- Genera sombras físicas suaves en el suelo y pared cercana.
- Escala razonable: nunca más grande que toda la pared ni más pequeño que un adorno.
`;
} else if (/(mesa|table|coffee table|dining|comedor|desk|escritorio)/i.test(rawType)) {
  productBehaviorBlock = `
[COMPORTAMIENTO: MESAS / SUPERFICIES]
- Ubica la mesa en el piso, alineada con la geometría de la habitación.
- Altura y proporciones coherentes con sofás, sillas u otros muebles.
- No atravieses muebles existentes; si no hay espacio lógico, ajusta ligeramente
  escala y posición dentro del área blanca para que se vea natural.
`;
} else if (/(espejo|mirror)/i.test(rawType)) {
  productBehaviorBlock = `
[COMPORTAMIENTO: ESPEJO]
- El espejo debe mostrarse con leve reflejo del ambiente, pero sin inventar personas ni escenas nuevas.
- No muestres reflejos imposibles (por ejemplo, ángulos que no coinciden con la cámara).
- Borde y marco coherentes con el estilo del espacio (minimalista, moderno, etc.).
`;
} else if (/(planta|plant|florero|flor|jarrón|jarron|vase)/i.test(rawType)) {
  productBehaviorBlock = `
[COMPORTAMIENTO: PLANTAS / FLOREROS]
- Volumen orgánico, iluminación suave y sombras coherentes sobre suelo o mueble.
- No invadas toda la escena con vegetación exagerada.
- Mantén una densidad de hojas realista, sin ruido digital.
`;
} else if (/(decor|escultura|figura|ornamento|adorno|statue|figurine)/i.test(rawType)) {
  productBehaviorBlock = `
[COMPORTAMIENTO: DECORACIÓN PEQUEÑA]
- Colocar sobre superficies planas (mesas, repisas, aparadores) dentro del área blanca.
- Tamaño sugerido: entre 10–40 cm de alto (proporcional al contexto).
- No debe tapar completamente otros elementos clave del espacio.
`;
} else if (/(parlante|bocina|soundbar|speaker|audio)/i.test(rawType)) {
  productBehaviorBlock = `
[COMPORTAMIENTO: TECNOLOGÍA / AUDIO]
- Integrado en pared, mueble de TV o repisa, según el diseño del producto.
- Bordes definidos, sin deformaciones ni artefactos.
- Nada de efectos de luz "gaming" a menos que el diseño lo sugiera explícitamente.
`;
}

// Construcción final del prompt hiper detallado
const prompt = `
Eres un MODELO DE INPAINTING FOTOGRÁFICO de alta fidelidad.

Tu objetivo es SIMULAR que el producto **${effectiveProductName}**
YA EXISTE en la habitación real del cliente. Debe parecer una foto real,
no una ilustración ni un render 3D.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BLOQUE 1 — REGLA SUPREMA (MÁXIMA PRIORIDAD)
- SOLO puedes modificar los píxeles dentro del área blanca de la MÁSCARA.
- El resto de la imagen (paredes, muebles, suelo, iluminación general)
  debe mantenerse prácticamente idéntico al original.
- No cambies el encuadre de cámara, ni la perspectiva global, ni la estructura del cuarto.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BLOQUE 2 — CONTEXTO DEL ESPACIO
${roomContext}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BLOQUE 3 — INTENCIÓN DEL CLIENTE
${ideaContext}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BLOQUE 4 — CÓMO DEBE COMPORTARSE ESTE PRODUCTO EN EL MUNDO REAL
Tipo original de producto (Shopify): "${rawType || "generic"}"

${productBehaviorBlock}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BLOQUE 5 — ASPECTO VISUAL Y MATERIALES DEL PRODUCTO
${visual}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BLOQUE 6 — GUÍAS DE REALISMO FOTOGRÁFICO

Debes garantizar que:
1. El producto respete la perspectiva de la habitación y las líneas de fuga.
2. Las sombras del producto coincidan con la dirección e intensidad de la luz del cuarto.
3. Los materiales reflejen la luz de forma creíble (mate, satinado, metálico, tela, madera, etc.).
4. No aparezcan bordes recortados, halos blancos, ruido fuerte ni artefactos raros.
5. La escala del producto sea creíble frente a puertas, camas, sofás, mesas y otros muebles.

Prohibido:
- Regenerar toda la habitación.
- Cambiar completamente el color de las paredes.
- Añadir textos, logos o marcas de agua visibles.
- Introducir personas, animales u objetos que el cliente no pidió.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BLOQUE 7 — OBJETIVO FINAL

Genera UNA sola imagen final donde:
- El producto **${effectiveProductName}** esté perfectamente integrado en el área blanca.
- El entorno conserve su esencia original (estilo, composición, iluminación).
- El resultado sea tan realista que parezca una fotografía tomada con cámara profesional
  en el mismo espacio del cliente.

Tu misión es ayudar al cliente a visualizar cómo quedaría el producto en su propio entorno
ANTES de tomar la decisión de compra.
`;


      // 8) FLUX SAFE MODE — UNA SOLA GENERACIÓN CON POLLING
      logStep("🧩 Llamando a FLUX (safe mode)...");

      const fluxReq = await fetch(
        "https://api.replicate.com/v1/models/black-forest-labs/flux-fill-dev/predictions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${REPLICATE_API_TOKEN}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            input: {
              image: userImageUrl,
              mask: `data:image/png;base64,${maskBase64}`,
              prompt,
              guidance: 5,
              num_inference_steps: 26,
              output_format: "webp",
              output_quality: 98,
              megapixels: "1" // siempre permitido
            }
          })
        }
      );

      const fluxStart = await fluxReq.json();
      if (!fluxStart.id) {
        console.error("❌ No se pudo iniciar FLUX:", fluxStart);
        throw new Error("No se pudo iniciar FLUX");
      }

      let fluxResult = fluxStart;
      while (
        fluxResult.status !== "succeeded" &&
        fluxResult.status !== "failed"
      ) {
        await new Promise((r) => setTimeout(r, 2000));
        const check = await fetch(
          `https://api.replicate.com/v1/predictions/${fluxStart.id}`,
          {
            headers: { Authorization: `Bearer ${REPLICATE_API_TOKEN}` }
          }
        );
        fluxResult = await check.json();
      }

      if (fluxResult.status === "failed" || !fluxResult.output?.[0]) {
        console.error("❌ FLUX falló:", fluxResult);
        throw new Error("Flux-fill-dev no devolvió imagen (safe mode)");
      }

      const generatedImageUrlFromReplicate = fluxResult.output[0];
      logStep("🟢 FLUX listo", { url: generatedImageUrlFromReplicate });

      // 9) Subir resultado a Cloudinary para tener https + thumbnails
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

      // 11) Session
      const sessionId = crypto.randomUUID();

      logStep("EXPERIENCIA GENERADA OK", {
        elapsedMs: Date.now() - startedAt
      });

      // 12) Respuesta final
      return res.status(200).json({
        ok: true,
        status: "complete",
        sessionId,
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
          "Tuvimos un problema al generar tu propuesta. Intenta otra vez en unos segundos."
      });
    }
  }
);

// ================== 🚀 ARRANQUE DEL SERVIDOR ==================

app.listen(PORT, () => {
  console.log(`🚀 INNOTIVA BACKEND PRO ejecutándose en puerto ${PORT}`);
  console.log(`🌍 Disponible en https://fulstack34.onrender.com`);
});
