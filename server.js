/**************************************************
 * INNOTIVA BACKEND — FLUX 1.1 PRO (FOCUS CUADROS)
 * - Express + CORS
 * - Multer (file upload)
 * - Cloudinary (room image)
 * - Shopify Storefront (productos)
 * - Replicate FLUX 1.1 PRO (texto → imagen)
 * - Endpoint principal: POST /experiencia-premium
 **************************************************/

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fetch = require("node-fetch");
const cloudinary = require("cloudinary").v2;
const Replicate = require("replicate");

// ====================================================
// APP BASE
// ====================================================
const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const upload = multer({ storage: multer.memoryStorage() });

// ====================================================
// CLOUDINARY
// ====================================================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

async function uploadBufferToCloudinary(buffer, folder, prefix) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: folder || "innotiva/rooms",
        public_id: `${prefix || "room"}_${Date.now()}`,
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

// ====================================================
// SHOPIFY — PRODUCTOS
// ====================================================
const SHOPIFY_STORE_DOMAIN =
  process.env.SHOPIFY_STORE_DOMAIN || "innotiva-vision.myshopify.com";
const SHOPIFY_STOREFRONT_TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN || "";

async function getShopifyProducts() {
  const endpoint = `https://${SHOPIFY_STORE_DOMAIN}/api/2024-01/graphql.json`;

  const query = `
    {
      products(first: 80) {
        edges {
          node {
            id
            title
            handle
            images(first: 1) {
              edges {
                node { url }
              }
            }
          }
        }
      }
    }
  `;

  const headers = { "Content-Type": "application/json" };
  if (SHOPIFY_STOREFRONT_TOKEN)
    headers["X-Shopify-Storefront-Access-Token"] = SHOPIFY_STOREFRONT_TOKEN;

  const resp = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ query }),
  });

  const json = await resp.json();
  if (!json.data || !json.data.products) return [];

  return json.data.products.edges.map((edge) => ({
    id: edge.node.id,
    handle: edge.node.handle,
    title: edge.node.title,
    image: edge.node.images.edges[0]?.node.url || null,
  }));
}

async function obtenerProductoPorHandle(handleOId) {
  const products = await getShopifyProducts();
  return (
    products.find(
      (p) =>
        String(p.handle) === String(handleOId) || String(p.id) === String(handleOId)
    ) || null
  );
}

// ====================================================
// REPLICATE — FLUX 1.1 PRO
// ====================================================
const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
const FLUX_MODEL =
  process.env.REPLICATE_FLUX_MODEL_ID || "black-forest-labs/flux-1.1-pro";

function construirPromptCuadro({ productName, idea }) {
  const ideaLimpia = (idea || "").trim();

  const ideaTexto = ideaLimpia
    ? `
Instrucciones del cliente:
"${ideaLimpia}".`
    : `
Colocar el cuadro con ubicación natural y equilibrada.`;

  return `
Fotografía interior hiperrealista de un salón moderno ya amoblado.
Mantener arquitectura, muebles, luz y estilo original.

Añadir 1 cuadro del tipo "${productName}" integrado en pared.
Sin deformar entorno — estilo premium catálogo.

${ideaTexto}
`;
}

const NEGATIVE_PROMPT_CUADRO = `
lienzo vacío, glitch, duplicaciones, muebles deformados,
logos, texto, marcas de agua, arte violento, NSFW
`;

/* =============================================
   🔥 FIX PEDIDO POR TI — RESPETA CODE ORIGINAL 🔥
=============================================*/
async function generarImagenIA_FluxCuadro({ productName, idea }) {
  const prompt = construirPromptCuadro({ productName, idea });

  console.log("\n🧠 PROMPT ENVIADO A FLUX:\n", prompt);

  const output = await replicate.run(FLUX_MODEL, {
    input: {
      prompt,
      negative_prompt: NEGATIVE_PROMPT_CUADRO,
      num_outputs: 1,
      aspect_ratio: "3:2",
      output_format: "png",
      guidance_scale: 3.5,
    },
  });

  // === NUEVO ===
  console.log("🔍 SALIDA FLUX CRUDA:", JSON.stringify(output, null, 2));

  // <===== ESTE ES EL FIX EXACTO QUE PEDISTE
  const imageUrl = typeof output === "string" ? output : output[0];

  console.log("🎨 URL FINAL FLUX:", imageUrl);
  return imageUrl;
}

// ====================================================
// RESULTADO IA — MENSAJE
// ====================================================
function generarMensajePersonalizado(productName, idea) {
  const extra = idea
    ? `\nIndicaciones respetadas: "${idea}".`
    : `\nComposición balanceada automáticamente.`;

  return `Así se vería tu espacio con **${productName}** integrado.${extra}`;
}

// ====================================================
// RUTAS BACKEND
// ====================================================
app.get("/", (req, res) => res.send("INNOTIVA Backend RUNNING ✔"));

app.get("/productos-shopify", async (req, res) => {
  try {
    res.json({ success: true, products: await getShopifyProducts() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ====================================================
// 🔥 ENDPOINT PRINCIPAL
// ====================================================
app.post("/experiencia-premium", upload.single("roomImage"), async (req, res) => {
  console.log("📩 POST /experiencia-premium");

  try {
    const { productId, productName, productUrl, idea } = req.body;
    if (!req.file) return res.json({ success: false, error: "Sin imagen" });

    const product = productId ? await obtenerProductoPorHandle(productId) : null;
    const nombreFinal = (product?.title || productName);

    const userImageUrl = await uploadBufferToCloudinary(req.file.buffer);
    console.log("☁ CLOUDINARY:", userImageUrl);

    let generatedImageUrl = await generarImagenIA_FluxCuadro({
      productName: nombreFinal,
      idea,
    });

    const message = generarMensajePersonalizado(nombreFinal, idea);

    res.json({
      success: true,
      message,
      userImageUrl,
      generatedImageUrl,
      productUrl:
        productUrl || `https://${SHOPIFY_STORE_DOMAIN}/products/${product?.handle}`,
    });
  } catch (err) {
    console.error("❌ ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ====================================================
app.listen(PORT, () => console.log("🔥 Backend ONLINE · PUERTO:", PORT));
