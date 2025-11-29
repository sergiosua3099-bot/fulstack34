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

// fetch compatible con Node 18/20/22
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

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

// ================== OPENAI VISION: CUARTO + PRODUCTO ==================

async function analyzeRoomAndProduct({
  roomImageUrl,
  productImageUrl,
  ideaText,
  productName,
  productType
}) {
  logStep("OpenAI: análisis de cuarto + producto");

  const prompt =
    'Analiza la habitación (room_image) y el producto (product_image) para integrar un CUADRO o una LÁMPARA minimalista premium en el espacio real del cliente.\n\n' +
    'DEVUELVE EXCLUSIVAMENTE un JSON con esta estructura EXACTA:\n\n' +
    '{\n' +
    '  "imageWidth": number,\n' +
    '  "imageHeight": number,\n' +
    '  "roomStyle": "texto corto",\n' +
    '  "placement": { "x": number, "y": number, "width": number, "height": number },\n' +
    '  "finalPlacement": { "x": number, "y": number, "width": number, "height": number },\n' +
    '  "product": {\n' +
    '    "normalizedType": "cuadro" | "lampara" | "otro",\n' +
    '    "rawTypeHint": "texto",\n' +
    '    "colors": ["#hex", "#hex"],\n' +
    '    "materials": ["madera", "metal", "tela", "vidrio"],\n' +
    '    "texture": "texto",\n' +
    '    "finish": "mate/satinado/brillante"\n' +
    '  }\n' +
    '}\n\n' +
    'Intención del cliente: "' +
    (ideaText || "") +
    '"\n' +
    'Tipo de producto: "' +
    (productType || "desconocido") +
    '"\n' +
    'Nombre comercial: "' +
    (productName || "producto") +
    '"\n\n' +
    "No expliques nada. Devuelve SOLO el JSON, sin texto adicional.";

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: roomImageUrl },
          { type: "input_image", image_url: productImageUrl }
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

  let analysis = safeParseJSON(text, "analysis room+product");

  // Fallback si viene incompleto
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
      finalPlacement: { x, y, width: boxWidth, height: boxHeight },
      product: analysis?.product || {
        normalizedType: "otro",
        rawTypeHint: productType || "",
        colors: [],
        materials: [],
        texture: "",
        finish: ""
      }
    };
  }

  if (!analysis.product) {
    analysis.product = {
      normalizedType: "otro",
      rawTypeHint: productType || "",
      colors: [],
      materials: [],
      texture: "",
      finish: ""
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
  if (/(lámpara|lampara|lamp|ceiling|techo|hanging|pendant)/i.test(type)) {
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

// ============ COMPOSICIÓN REAL: CUARTO + PRODUCTO PNG ============

async function composeProductOnRoom({
  roomImageUrl,
  productImageUrl,
  placement
}) {
  logStep("Componiendo producto PNG dentro del cuarto");

  const roomRes = await fetch(roomImageUrl);
  const productRes = await fetch(productImageUrl);

  if (!roomRes.ok || !productRes.ok) {
    throw new Error("No se pudieron descargar imágenes para composición");
  }

  const roomBuffer = Buffer.from(await roomRes.arrayBuffer());
  const productBuffer = Buffer.from(await productRes.arrayBuffer());

  const { x, y, width } = placement;

  // Redimensionamos el producto al ancho del área, manteniendo proporciones
  const resizedProductBuffer = await sharp(productBuffer)
    .resize({
      width: Math.max(80, width),
      fit: "contain"
    })
    .png()
    .toBuffer();

  // Componer sobre el cuarto
  const composedBuffer = await sharp(roomBuffer)
    .composite([
      {
        input: resizedProductBuffer,
        top: Math.max(0, y),
        left: Math.max(0, x)
      }
    ])
    .jpeg({ quality: 96 })
    .toBuffer();

  const upload = await uploadBufferToCloudinary(
    composedBuffer,
    "innotiva/composed",
    "room-plus-product"
  );

  logStep("Composición subida a Cloudinary", { url: upload.secure_url });
  return upload.secure_url;
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
  upload.single("roomImage"), // ⚠️ se respeta el nombre ORIGINAL del campo
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

      const productImageUrl = productData.featuredImage;
      if (!productImageUrl) {
        throw new Error("El producto no tiene imagen en Shopify");
      }

      // 3) Análisis único con Vision (cuarto + producto)
      const analysis = await analyzeRoomAndProduct({
        roomImageUrl: userImageUrl,
        productImageUrl,
        ideaText: idea,
        productName: effectiveProductName,
        productType: productData.productType
      });

      // 4) Ajustar placement según tipo de producto + idea del cliente
      const refinedPlacement = determineMaskPosition(
        analysis,
        productData.productType,
        idea
      );
      analysis.finalPlacement = refinedPlacement;

      logStep("Generando máscara...");
      const maskBase64 = await createMaskFromAnalysis(analysis);
      logStep("Máscara generada correctamente");

      // 5) Componer el producto PNG real dentro del cuarto (antes de IA)
      const composedUrl = await composeProductOnRoom({
        roomImageUrl: userImageUrl,
        productImageUrl,
        placement: analysis.finalPlacement
      });

      // ====================== PROMPT PARA FLUX ====================== //

      const rawType = productData.productType || "";
      const normalizedType =
        analysis.product?.normalizedType ||
        (/(lámpara|lampara|lamp|ceiling|techo|pendant)/i.test(rawType)
          ? "lampara"
          : "cuadro");

      const ideaContext =
        idea && idea.trim().length > 0
          ? 'Intención del cliente: "' + idea.trim() + '"'
          : "El cliente no agregó indicaciones específicas. Mantén el producto natural y aspiracional.";

      const basePrompt =
        "En la imagen de entrada YA hemos colocado el producto real dentro del espacio del cliente.\n" +
        "Tu trabajo NO es inventar un producto nuevo, sino pulir bordes, sombras y luz para que parezca completamente integrado.\n\n" +
        ideaContext +
        "\n\n" +
        "Respeta el diseño, forma y colores del producto. No lo borres, no lo reemplaces.\n" +
        "Solo edita la zona blanca de la máscara y deja el resto de la habitación casi intacta.\n";

      const behaviorBlock =
        normalizedType === "lampara"
          ? "Se trata de una LÁMPARA. Ajusta sutilmente brillo y sombras para que parezca la fuente de luz correcta en la escena."
          : "Se trata de un CUADRO / PIEZA DE ARTE EN PARED. Ajusta sombras de contacto, bordes y textura sobre la pared.";

      const prompt = basePrompt + "\n\n" + behaviorBlock;

      // ====================== FLUX SAFE MODE ====================== //

      logStep("🧩 Llamando a FLUX (safe mode)...");

      const fluxReq = await fetch(
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
              image: composedUrl, // base ya incluye producto
              mask: `data:image/png;base64,${maskBase64}`,
              prompt,
              guidance: 5.5,
              num_inference_steps: 24,
              output_format: "webp",
              output_quality: 98,
              megapixels: "1"
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

      // 9) Subir resultado a Cloudinary
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
        product_id: productId,
        message,
        analysis,
        thumbnails,
        embedding: analysis.product || null,
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

// ================== 🔥 RUTA REPOSICIÓN IA ESTABLE 🔥 ==================

app.post("/experiencia-premium-reposicion", async (req, res) => {
  try {
    const {
      roomImage, // URL pública Cloudinary (antes)
      ai_image_prev, // Imagen generada versión 1
      productId,
      x,
      y, // Coordenadas del click en tamaño real
      width,
      height, // Dimensiones originales de la imagen
      idea
    } = req.body;

    if (
      !roomImage ||
      !productId ||
      x == null ||
      y == null ||
      !width ||
      !height
    ) {
      return res.status(400).json({
        error:
          "⚠ Faltan datos para reposición IA (roomImage / productId / x / y / width / height)"
      });
    }

    logStep("♻ Reposición manual iniciada", { x, y, width, height });

    const imageToUse =
      ai_image_prev && ai_image_prev !== "" ? ai_image_prev : roomImage;

    let productTypeHint = "producto decorativo";
    try {
      const p = await fetchProductFromShopify(productId);
      productTypeHint = p.productType || productTypeHint;
    } catch (e) {
      console.error("No se pudo obtener productType en reposición:", e);
    }

    const placement = {
      imageWidth: width,
      imageHeight: height,
      finalPlacement: {
        x: Math.floor(x - width * 0.12),
        y: Math.floor(y - height * 0.12),
        width: Math.floor(width * 0.24),
        height: Math.floor(height * 0.24)
      }
    };

    const maskBase64 = await createMaskFromAnalysis(placement);
    logStep("🟡 Máscara nueva generada ✔");

    const miniPrompt =
      "Reubica el " +
      productTypeHint +
      " sin alterar el resto de la habitación.\n" +
      "Solo edita la zona blanca de la máscara.\n" +
      'Intención del cliente: "' +
      (idea || "reposicion manual") +
      '"';

    const flux = await fetch(
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
            image: imageToUse,
            mask: `data:image/png;base64,${maskBase64}`,
            prompt: miniPrompt,
            guidance: 4.6,
            num_inference_steps: 20,
            output_format: "webp",
            megapixels: "1"
          }
        })
      }
    );

    let poll = await flux.json();
    while (poll.status !== "succeeded" && poll.status !== "failed") {
      await new Promise((r) => setTimeout(r, 1800));
      poll = await (
        await fetch(
          `https://api.replicate.com/v1/predictions/${poll.id}`,
          {
            headers: { Authorization: `Bearer ${REPLICATE_API_TOKEN}` }
          }
        )
      ).json();
    }

    if (!poll.output?.[0]) throw new Error("Replicate no devolvió imagen nueva");

    const upload = await uploadUrlToCloudinary(
      poll.output[0],
      "innotiva/repositions",
      "reposicion-v2"
    );

    logStep("🟢 Reposición IA finalizada ✔", { url: upload.secure_url });

    return res.json({
      ok: true,
      ai_image: upload.secure_url,
      base_used: imageToUse,
      updated_at: new Date().toISOString()
    });
  } catch (e) {
    console.error("❌ Error en reposición IA", e);
    return res.status(500).json({ error: "No se pudo reposicionar IA." });
  }
});

// ================== 🚀 ARRANQUE DEL SERVIDOR ==================

app.listen(PORT, () => {
  console.log(`🚀 INNOTIVA BACKEND PRO ejecutándose en puerto ${PORT}`);
  console.log(`🌍 Disponible en https://fulstack34.onrender.com`);
});
