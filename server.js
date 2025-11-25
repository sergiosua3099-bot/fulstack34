// server.js — INNOTIVA BACKEND FINAL PRO MAX
// ------------------------------------------
// ✔ Cloudinary
// ✔ Shopify products
// ✔ Replicate SDXL image-to-image
// ✔ Background removal optional (B1)
// ✔ Prompts PRO nivel IKEA
// ✔ Full compatible con tu formulario Shopify actual

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fetch = require("node-fetch");
const cloudinary = require("cloudinary").v2;
const Replicate = require("replicate");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// STORAGE PARA LA IMAGEN DEL USUARIO
const upload = multer({ storage: multer.memoryStorage() });

// CLOUDINARY CONFIG
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// REPLICATE CONFIG
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

// SHOPIFY CONFIG
const SHOPIFY_STORE_DOMAIN =
  process.env.SHOPIFY_STORE_DOMAIN || "innotiva-vision.myshopify.com";

const SHOPIFY_STOREFRONT_TOKEN =
  process.env.SHOPIFY_STOREFRONT_TOKEN ||
  process.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN ||
  "";

// ======================================================
// UTILIDAD → Subir imágenes a Cloudinary
// ======================================================
function uploadBufferToCloudinary(buffer, folder, prefix) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        public_id: `${prefix}_${Date.now()}`,
        resource_type: "image",
      },
      (err, result) => {
        if (err) return reject(err);
        resolve(result.secure_url);
      }
    );
    stream.end(buffer);
  });
}

// ======================================================
// FETCH → Productos desde Shopify (para formulario)
// ======================================================
async function getShopifyProducts() {
  const endpoint = `https://${SHOPIFY_STORE_DOMAIN}/api/2024-01/graphql.json`;

  const query = `
    {
      products(first: 50) {
        edges {
          node {
            id
            title
            handle
            description
            onlineStoreUrl
            images(first: 1) {
              edges { node { url altText } }
            }
          }
        }
      }
    }
  `;

  const headers = {
    "Content-Type": "application/json",
  };

  if (SHOPIFY_STOREFRONT_TOKEN)
    headers["X-Shopify-Storefront-Access-Token"] = SHOPIFY_STOREFRONT_TOKEN;

  const resp = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ query }),
  });

  const json = await resp.json();
  const edges = json?.data?.products?.edges || [];

  return edges.map((edge) => {
    const node = edge.node;
    const img = node.images?.edges?.[0]?.node;

    return {
      id: node.handle,
      handle: node.handle,
      title: node.title,
      description: node.description,
      image: img?.url || "https://via.placeholder.com/400x400?text=Producto",
      url:
        node.onlineStoreUrl ||
        `https://${SHOPIFY_STORE_DOMAIN}/products/${node.handle}`,
    };
  });
}

// ======================================================
// Obtener un producto por ID/HANDLE
// ======================================================
async function obtenerProductoPorId(productId) {
  const products = await getShopifyProducts();
  return (
    products.find(
      (p) =>
        String(p.id).trim() === String(productId).trim() ||
        String(p.handle).trim() === String(productId).trim()
    ) || null
  );
}

// ======================================================
// B1 — Remover fondo del producto (opcional)
// ======================================================
async function removerFondoProducto(productImageUrl) {
  const modelId = process.env.REPLICATE_BG_MODEL_ID;
  if (!modelId) return null;

  try {
    const result = await replicate.run(modelId, {
      input: { image: productImageUrl },
    });

    if (Array.isArray(result) && result.length) return result[0];
    if (typeof result === "string") return result;
    if (result?.image) return result.image;

    return null;
  } catch (e) {
    console.warn("⚠ Error remover fondo:", e);
    return null;
  }
}

// ======================================================
// Mensaje personalizado para la página resultado
// ======================================================
function generarMensajePersonalizado(productName, idea) {
  let msg = `La elección de "${productName}" encaja perfectamente con el estilo de tu espacio. `;

  if (idea?.trim()) {
    msg += `Tomamos en cuenta tu indicación: “${idea.trim()}”. `;
  }

  msg +=
    "Esta visualización te ayudará a decidir con más confianza antes de comprar.";
  return msg;
}

// ======================================================
// Inferir tipo de producto (para prompts PRO)
// ======================================================
function inferirTipoProducto(productName) {
  const n = productName.toLowerCase();

  if (n.includes("espejo")) return "espejo";
  if (n.includes("lamp")) return "lampara";
  if (n.includes("estante") || n.includes("repisa")) return "estante";
  if (n.includes("planta")) return "planta";
  if (n.includes("alfombra")) return "alfombra";
  if (n.includes("cojin") || n.includes("pillow")) return "cojin";
  if (n.includes("cortina")) return "cortina";
  if (n.includes("reloj")) return "reloj";

  if (
    n.includes("cuadro") ||
    n.includes("poster") ||
    n.includes("frame") ||
    n.includes("canvas")
  )
    return "cuadro";

  return "decoracion";
}

// ======================================================
// Construcción del prompt PRO (sin errores, nivel IKEA)
// ======================================================
function construirPromptPro(productName, idea) {
  const tipo = inferirTipoProducto(productName);

  const ideaExtra = idea?.trim()
    ? `Client direction: "${idea.trim()}".`
    : "Place product naturally and tastefully.";

  const reglas = `
- Keep the same room, same camera angle, same light.
- No warping walls.
- No surreal artifacts.
- Only add product, do not remove furniture.
`;

  const instruccion = {
    cuadro: `Add a single wall frame "${productName}" with realistic perspective.`,
    espejo: `Add a decorative mirror "${productName}" with natural reflections.`,
    lampara: `Add a premium lamp "${productName}" with soft lighting.`,
    estante: `Add a floating shelf "${productName}" aligned straight to wall.`,
    planta: `Add a decorative plant "${productName}" balanced in the room.`,
    alfombra: `Place rug "${productName}" under correct floor perspective.`,
    cojin: `Place premium cushions "${productName}" on furniture.`,
    cortina: `Add curtains "${productName}" realistically by window.`,
    reloj: `Add a wall clock "${productName}" aligned to composition.`,
    decoracion: `Add decor product "${productName}" integrated naturally.`,
  }[tipo];

  return `
Ultra detailed, photorealistic interior of the EXACT SAME ROOM.
Preserve everything. Just integrate the product realistically.

${instruccion}
${ideaExtra}

High-end IKEA / Scandinavian catalog aesthetic.
Soft lighting, clean contrast, premium styling.

${reglas}
`.trim();
}

// NEGATIVE PROMPT PRO
function construirNegativePromptPro() {
  return `
blurry, distorted, deformed, surreal, cartoon, illustration, 3d render,
extra objects, duplicated objects, warped walls, wrong perspective,
watermark, text, lowres, noisy, grainy
  `.trim();
}

// ======================================================
// IA → Generar imagen con Replicate SDXL (CORREGIDO)
// ======================================================
async function generarImagenIA(roomImageUrl, productName, idea) {
  const modelId =
    process.env.REPLICATE_MODEL_ID ||
    "stability-ai/sdxl:39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b";

  const prompt = construirPromptPro(productName, idea);
  const negative = construirNegativePromptPro();

  try {
    const result = await replicate.run(modelId, {
      input: {
        prompt,
        negative_prompt: negative,
        image: roomImageUrl,

        refine: "expert_ensemble_refiner", // ← REPARADO

        strength: 0.38,
        num_outputs: 1,
        num_inference_steps: 35,
        scheduler: "K_EULER",
        guidance_scale: 7.5,
      },
    });

    if (Array.isArray(result) && result.length > 0) return result[0];

    return "https://via.placeholder.com/1024x1024?text=Propuesta+IA";
  } catch (err) {
    console.error("❌ Error Replicate:", err);
    return "https://via.placeholder.com/1024x1024?text=Propuesta+IA";
  }
}

// ======================================================
// ROUTES
// ======================================================

app.get("/", (req, res) => {
  res.send("Innotiva Backend PRO con Replicate IA funcionando ✔");
});

app.get("/productos-shopify", async (req, res) => {
  try {
    const products = await getShopifyProducts();
    res.json({ success: true, products });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ======================================================
// EXPERIENCIA PREMIUM — MAIN ENDPOINT
// ======================================================
app.post(
  "/experiencia-premium",
  upload.single("roomImage"),
  async (req, res) => {
    try {
      if (!req.file)
        return res
          .status(400)
          .json({ success: false, error: "Falta roomImage" });

      const { productId, productName, idea, productUrl } = req.body;

      const userImageUrl = await uploadBufferToCloudinary(
        req.file.buffer,
        "innotiva/rooms",
        "room"
      );

      const producto = await obtenerProductoPorId(productId);
      const productImageUrl = producto?.image || null;

      let productCutoutUrl = null;
      if (productImageUrl) {
        productCutoutUrl = await removerFondoProducto(productImageUrl);
      }

      const generatedImageUrl = await generarImagenIA(
        userImageUrl,
        productName,
        idea
      );

      const finalProductUrl =
        productUrl ||
        `https://${SHOPIFY_STORE_DOMAIN}/products/${productId}`;

      const message = generarMensajePersonalizado(productName, idea);

      return res.json({
        success: true,
        message,
        userImageUrl,
        generatedImageUrl,
        productUrl: finalProductUrl,
        productName,
        productId,
        productImageUrl,
        productCutoutUrl,
      });
    } catch (e) {
      console.error("ERR /experiencia-premium:", e);
      res.status(500).json({
        success: false,
        error: "Error interno al generar experiencia premium",
      });
    }
  }
);

// ======================================================
app.listen(PORT, () => {
  console.log(`🚀 INNOTIVA BACKEND PRO LISTO en puerto ${PORT}`);
});

