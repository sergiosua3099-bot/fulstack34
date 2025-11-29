// index.js
// INNOTIVA BACKEND PRO - /experiencia-premium - V19 ARQUITECTÓNICO D1 (ajuste máscara fino)

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
//
// D1: objeto decorativo sobre mesa / superficie
//

async function analyzeRoomAndProduct({
  roomImageUrl,
  productImageUrl,
  ideaText,
  productName,
  productType
}) {
  logStep("OpenAI: análisis arquitectónico cuarto + producto (D1)");

  const prompt =
    'Analiza esta habitación real y el producto decorativo para integrarlo con REALISMO ARQUITECTÓNICO.\n\n' +
    'Toma en cuenta:\n' +
    '- Paredes, líneas de fuga y perspectiva.\n' +
    '- Mesas, consolas o superficies horizontales donde podría apoyarse el producto.\n' +
    '- Dirección de la luz (ventanas / lámparas existentes) y sombras.\n\n' +
    'Tu tarea es encontrar la mejor ubicación para un OBJETO DECORATIVO SOBRE MESA o superficie similar dentro del espacio real.\n\n' +
    'DEVUELVE EXCLUSIVAMENTE un JSON con esta estructura EXACTA:\n\n' +
    '{\n' +
    '  "imageWidth": number,\n' +
    '  "imageHeight": number,\n' +
    '  "roomStyle": "texto corto",\n' +
    '  "lightDirection": "izquierda" | "derecha" | "frontal" | "mixta",\n' +
    '  "mainSurfaces": ["mesa de centro", "mesa lateral", "consola", "repisa", "otro"],\n' +
    '  "placement": { "x": number, "y": number, "width": number, "height": number },\n' +
    '  "finalPlacement": { "x": number, "y": number, "width": number, "height": number },\n' +
    '  "product": {\n' +
    '    "normalizedType": "objeto_mesa" | "cuadro" | "lampara" | "otro",\n' +
    '    "rawTypeHint": "texto",\n' +
    '    "colors": ["#hex", "#hex"],\n' +
    '    "materials": ["madera", "metal", "ceramica", "vidrio", "tela"],\n' +
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
    logStep("Análisis insuficiente, usando fallback para D1 (mesa)");

    const imageWidth = analysis?.imageWidth || 1600;
    const imageHeight = analysis?.imageHeight || 900;

    // Para D1, asumimos una mesa en el tercio inferior central
    const boxWidth = Math.round(imageWidth * 0.22);
    const boxHeight = Math.round(imageHeight * 0.20);
    const x = Math.round((imageWidth - boxWidth) / 2);
    const y = Math.round(imageHeight * 0.55);

    analysis = {
      imageWidth,
      imageHeight,
      roomStyle: analysis?.roomStyle || "tu sala",
      lightDirection: analysis?.lightDirection || "izquierda",
      mainSurfaces: analysis?.mainSurfaces || ["mesa de centro"],
      placement: { x, y, width: boxWidth, height: boxHeight },
      finalPlacement: { x, y, width: boxWidth, height: boxHeight },
      product: analysis?.product || {
        normalizedType: "objeto_mesa",
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
      normalizedType: "objeto_mesa",
      rawTypeHint: productType || "",
      colors: [],
      materials: [],
      texture: "",
      finish: ""
    };
  }

  return analysis;
}

// ============ POSICIÓN DE LA MÁSCARA (con fix de área) ============

function determineMaskPosition(analysis, productType = "", ideaText = "") {
  const imageWidth = analysis.imageWidth || 1600;
  const imageHeight = analysis.imageHeight || 900;

  // área más pequeña para evitar “bloques blancos”
  let width = Math.round(imageWidth * 0.18);
  let height = Math.round(imageHeight * 0.16);
  let x = Math.round((imageWidth - width) / 2);
  let y = Math.round(imageHeight * 0.58); // un poco más abajo (mesa)

  const idea = (ideaText || "").toLowerCase();

  if (/abajo|inferior/i.test(idea)) y = Math.round(imageHeight * 0.68);
  if (/arriba|superior/i.test(idea)) y = Math.round(imageHeight * 0.40);
  if (/centro|centrado/i.test(idea))
    x = Math.round((imageWidth - width) / 2);
  if (/izquierda/i.test(idea)) x = Math.round(imageWidth * 0.20);
  if (/derecha/i.test(idea)) x = Math.round(imageWidth * 0.62);

  // Clamp
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x + width > imageWidth) width = imageWidth - x;
  if (y + height > imageHeight) height = imageHeight - y;

  return { x, y, width, height };
}

// ================== MÁSCARA ==================
//
// 🔧 AJUSTE: en lugar de pintar TODO el rectángulo completo,
// se contrae ~10–15% para que FLUX solo retoque el área
// alrededor del objeto y no “planche” la textura de la mesa.
//

async function createMaskFromAnalysis(analysis) {
  const { imageWidth, imageHeight, finalPlacement } = analysis;

  if (!imageWidth || !imageHeight || !finalPlacement) {
    throw new Error("Datos insuficientes para crear la máscara");
  }

  const { x, y, width, height } = finalPlacement;
  const w = Math.max(1, Math.round(imageWidth));
  const h = Math.max(1, Math.round(imageHeight));

  const mask = Buffer.alloc(w * h, 0); // negro

  // padding proporcional (reduce área editable)
  const padX = Math.floor(width * 0.12);
  const padY = Math.floor(height * 0.12);

  const startX = Math.max(0, x + padX);
  const startY = Math.max(0, y + padY);
  const endX = Math.min(w, x + width - padX);
  const endY = Math.min(h, y + height - padY);

  for (let j = startY; j < endY; j++) {
    for (let i = startX; i < endX; i++) {
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
  logStep("Componiendo producto PNG dentro del cuarto (base IA)", {
    roomImageUrl,
    productImageUrl
  });

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
    msg += ` Integramos ${productName} como pieza decorativa clave, buscando equilibrio entre estilo y serenidad.`;
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
      const {
        productId,
        productName,
        productUrl,
        idea,
        productCutoutUrl // opcional: PNG sin fondo
      } = req.body;

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

      let productImageUrl =
        productCutoutUrl && productCutoutUrl.trim().length > 0
          ? productCutoutUrl.trim()
          : productData.featuredImage;

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

      // 5) Componer el producto PNG real dentro del cuarto (base IA)
      const composedUrl = await composeProductOnRoom({
        roomImageUrl: userImageUrl,
        productImageUrl,
        placement: analysis.finalPlacement
      });

      // ====================== PROMPT PARA FLUX (ARQUITECTÓNICO D1) ====================== //

      const lightDir = analysis.lightDirection || "izquierda";

      const basePrompt =
        `OBJETIVO PRINCIPAL:\n` +
        `Integrar un objeto decorativo sobre mesa en la escena como si hubiera sido colocado físicamente en el espacio.\n\n` +
        `ESCENA:\n` +
        `- Habitación real estilo ${analysis.roomStyle || "minimalista"}.\n` +
        `- Dirección de la luz: ${lightDir}.\n` +
        `- Superficies detectadas: ${(analysis.mainSurfaces || []).join(", ") ||
          "mesa de centro"}.\n\n` +
        `REGLAS DE REALISMO:\n` +
        `1. El objeto debe apoyarse sobre una mesa, consola o repisa REAL de la foto.\n` +
        `2. NO reemplaces la textura original de la mesa ni la alfombra: conserva vetas, tramas y reflejos existentes.\n` +
        `3. NO generes bloques planos ni fondo blanco: el fondo debe seguir siendo el material real de la escena.\n` +
        `4. Respeta perspectiva y líneas de fuga; el objeto debe alinearse con el plano de la mesa.\n` +
        `5. Genera sombra de contacto suave y coherente con la luz (${lightDir}).\n` +
        `6. Ajusta color y brillo del objeto a la temperatura de color del ambiente.\n` +
        `7. Solo edita la zona blanca de la máscara, mantén intacto el resto del cuarto.\n\n` +
        `ESTILO VISUAL:\n` +
        `- Fotografía real tipo catálogo de interiorismo.\n` +
        `- Contraste suave, tonos cálidos y aspecto natural.\n\n` +
        (idea && idea.trim().length > 0
          ? `Instrucción del cliente: "${idea.trim()}".\n`
          : "El cliente no dio instrucciones específicas. Mantén el objeto sobrio, elegante y aspiracional.\n");

      const behaviorBlock =
        "\nFOCO D1: Objeto decorativo sobre mesa (jarrón, escultura, centro de mesa, etc.).\n" +
        "• Escala proporcional al resto del mobiliario.\n" +
        "• Fusión natural con la escena; que nunca parezca un sticker pegado.\n";

      const prompt = basePrompt + behaviorBlock;

      // ====================== FLUX ====================== //

      logStep("🧩 Llamando a FLUX (modo arquitectónico D1)...");

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
              image: composedUrl,
              mask: `data:image/png;base64,${maskBase64}`,
              prompt,
              guidance: 6.0,
              num_inference_steps: 34,
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
        throw new Error("Flux-fill-dev no devolvió imagen (modo arquitectónico)");
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

    let productTypeHint = "objeto decorativo";
    try {
      const p = await fetchProductFromShopify(productId);
      productTypeHint = p.productType || productTypeHint;
    } catch (e) {
      console.error("No se pudo obtener productType en reposición:", e);
    }

    const boxWidth = Math.floor(width * 0.18);
    const boxHeight = Math.floor(height * 0.16);
    const x0 = Math.floor(x - boxWidth / 2);
    const y0 = Math.floor(y - boxHeight / 2);

    const placement = {
      imageWidth: width,
      imageHeight: height,
      finalPlacement: {
        x: x0,
        y: y0,
        width: boxWidth,
        height: boxHeight
      }
    };

    const maskBase64 = await createMaskFromAnalysis(placement);
    logStep("🟡 Máscara nueva generada ✔", { x0, y0, boxWidth, boxHeight });

    const miniPrompt =
      "Reposiciona el " +
      productTypeHint +
      " sobre una superficie coherente (mesa, consola o repisa) sin alterar el resto de la habitación.\n" +
      "Respeta perspectiva, escala y sombras del entorno. No borres la textura de la mesa ni del suelo. Solo edita la zona blanca de la máscara.\n" +
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
            guidance: 4.8,
            num_inference_steps: 22,
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
