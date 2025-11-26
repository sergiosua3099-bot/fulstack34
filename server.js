// server.js
// INNOTIVA BACKEND — FLUX DEV (Runware) · Versión estable
// Rutas:
//   GET  /                    -> healthcheck
//   GET  /productos-shopify   -> lista de productos (por si lo usas luego)
//   POST /experiencia-premium -> recibe roomImage + datos producto y devuelve JSON para Shopify

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fetch = require("node-fetch");
const cloudinary = require("cloudinary").v2;

// ==========================
// CONFIG BASE
// ==========================
const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Multer en memoria para la foto del cliente
const upload = multer({ storage: multer.memoryStorage() });

// ==========================
// CLOUDINARY
// ==========================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

function uploadBufferToCloudinary(buffer, folder, prefix) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: folder || "innotiva",
        public_id: `${prefix || "img"}_${Date.now()}`,
        resource_type: "image",
      },
      (err, result) => {
        if (err) return reject(err);
        return resolve(result.secure_url);
      }
    );
    stream.end(buffer);
  });
}

// ==========================
// SHOPIFY
// ==========================
const SHOPIFY_STORE_DOMAIN =
  process.env.SHOPIFY_STORE_DOMAIN || "innotiva-vision.myshopify.com";

const SHOPIFY_STOREFRONT_TOKEN =
  process.env.SHOPIFY_STOREFRONT_TOKEN ||
  process.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN ||
  "";

// Obtener productos via GraphQL (por si lo necesitas luego)
async function getShopifyProducts() {
  if (!SHOPIFY_STOREFRONT_TOKEN) {
    console.warn("⚠️ SHOPIFY_STOREFRONT_TOKEN no definido (GraphQL podría fallar).");
  }

  const endpoint = `https://${SHOPIFY_STORE_DOMAIN}/api/2024-01/graphql.json`;

  const query = `
    {
      products(first: 80) {
        edges {
          node {
            id
            handle
            title
            description
            onlineStoreUrl
            images(first: 1) {
              edges {
                node {
                  url
                  altText
                }
              }
            }
          }
        }
      }
    }
  `;

  const headers = { "Content-Type": "application/json" };
  if (SHOPIFY_STOREFRONT_TOKEN) {
    headers["X-Shopify-Storefront-Access-Token"] = SHOPIFY_STOREFRONT_TOKEN;
  }

  const resp = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ query }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    console.error("❌ Error Shopify:", resp.status, txt);
    throw new Error("No se pudieron obtener los productos de Shopify");
  }

  const json = await resp.json();
  const edges = json?.data?.products?.edges || [];

  return edges.map((edge) => {
    const node = edge.node;
    const imgEdge = node.images?.edges?.[0];
    const img = imgEdge?.node;
    const imageUrl =
      img?.url || "https://via.placeholder.com/400x400?text=Producto";

    const handle = node.handle;
    const url =
      node.onlineStoreUrl ||
      `https://${SHOPIFY_STORE_DOMAIN}/products/${handle}`;

    return {
      id: handle,
      handle,
      title: node.title,
      description: node.description || "",
      image: imageUrl,
      url,
    };
  });
}

async function obtenerProductoPorId(productId) {
  try {
    const products = await getShopifyProducts();
    if (!products || !products.length) return null;

    const target = String(productId || "").trim();

    const found = products.find((p) => {
      if (!p) return false;
      const id = String(p.id || "").trim();
      const handle = String(p.handle || "").trim();
      return id === target || handle === target;
    });

    return found || null;
  } catch (err) {
    console.warn("No se pudo obtener producto desde Shopify:", err);
    return null;
  }
}

// ==========================
// LÓGICA DE PRODUCTO -> TIPO
// ==========================
function inferirTipoProducto(productName) {
  const name = (productName || "").toLowerCase();

  if (name.includes("espejo") || name.includes("mirror")) return "espejo";
  if (
    name.includes("lámpara") ||
    name.includes("lampara") ||
    name.includes("lamp")
  )
    return "lampara";
  if (
    name.includes("estante") ||
    name.includes("repisa") ||
    name.includes("shelf")
  )
    return "estante";
  if (name.includes("planta") || name.includes("plant")) return "planta";
  if (
    name.includes("alfombra") ||
    name.includes("tapete") ||
    name.includes("rug")
  )
    return "alfombra";
  if (
    name.includes("cojín") ||
    name.includes("cojin") ||
    name.includes("pillow") ||
    name.includes("cushion")
  )
    return "cojin";
  if (name.includes("cortina") || name.includes("curtain")) return "cortina";
  if (name.includes("reloj") || name.includes("clock")) return "reloj";

  if (
    name.includes("cuadro") ||
    name.includes("poster") ||
    name.includes("print") ||
    name.includes("marco") ||
    name.includes("frame") ||
    name.includes("lienzo") ||
    name.includes("canvas")
  ) {
    return "cuadro";
  }

  return "decoracion";
}

// ==========================
// PROMPT PRO (para FLUX texto→imagen)
// ==========================
function construirPromptPro(productName, idea) {
  const tipo = inferirTipoProducto(productName);

  const ideaTexto =
    idea && idea.trim().length > 0
      ? `Client additional direction (Spanish, keep meaning): "${idea.trim()}".`
      : "No extra client direction. Place the product in a tasteful, balanced and premium way.";

  let instruccionProducto = "";

  switch (tipo) {
    case "espejo":
      instruccionProducto = `
Add a decorative wall mirror called "${productName}" on the wall area that naturally makes the most sense
(usually centered above a sofa, console or sink), at a realistic height and size,
reflecting the room without warping.`;
      break;
    case "lampara":
      instruccionProducto = `
Add a decorative lamp called "${productName}" (floor, table or wall lamp) automatically placed where it feels
most natural in the scene, with soft warm lighting and realistic shadows.`;
      break;
    case "estante":
      instruccionProducto = `
Add a floating shelf / wall-mounted unit called "${productName}" on a clean wall section,
aligned and straight, with correct perspective and subtle contact shadow.`;
      break;
    case "planta":
      instruccionProducto = `
Add a decorative plant called "${productName}" in a natural corner or area of the room
(near a window, next to a sofa, or by a console), adding freshness without blocking windows or furniture.`;
      break;
    case "alfombra":
      instruccionProducto = `
Add a rug called "${productName}" on the floor zone that best anchors the furniture composition,
with correct perspective under or near the existing furniture.`;
      break;
    case "cojin":
      instruccionProducto = `
Add decorative cushions / pillows called "${productName}" on sofas, chairs or bed,
arranged neatly and matching the style and color palette of the existing furniture.`;
      break;
    case "cortina":
      instruccionProducto = `
Add curtains called "${productName}" on the appropriate window or wall area,
with realistic fabric folds and interaction with the light.`;
      break;
    case "reloj":
      instruccionProducto = `
Add a decorative wall clock called "${productName}" on a visible wall,
at a natural height and aligned with existing composition lines.`;
      break;
    case "cuadro":
      instruccionProducto = `
Add a single wall art / frame / print called "${productName}" on the most visually balanced wall area
(typically centered above a main sofa, bed or console), hung straight with realistic frame size.`;
      break;
    default:
      instruccionProducto = `
Add a single home decor product called "${productName}" automatically positioned in the place that makes
the most sense compositionally, integrating it with the existing room.`;
      break;
  }

  const wowLinea = `
Enhance the scene with soft premium lighting, clean contrast and a magazine-quality interior design look,
as if photographed for a high-end Scandinavian decor catalog.`;

  const promptBase = `
Ultra detailed, photorealistic interior photograph of a cozy, modern room.
Clean walls, premium furniture, natural soft light, realistic materials.

${instruccionProducto}

${ideaTexto}

${wowLinea}

Rules:
- Do NOT overfill the scene with too many objects.
- Keep the layout realistic and uncluttered.
- Respect coherent light direction and shadows.
- The final render must look like a real photograph, not a painting or cartoon.
`;

  return promptBase.trim();
}

function construirNegativePromptPro() {
  return [
    "low quality",
    "blurry",
    "distorted",
    "deformed",
    "wrong perspective",
    "warped walls",
    "warped furniture",
    "surreal",
    "fantasy",
    "cartoon",
    "illustration",
    "3d render",
    "extra limbs",
    "extra objects",
    "duplicate furniture",
    "duplicate objects",
    "text",
    "logo",
    "watermark",
    "overexposed",
    "underexposed",
    "grainy",
    "noisy",
    "fisheye",
    "extreme wide angle",
  ].join(", ");
}

// ==========================
// IA — RUNWARE FLUX (texto→imagen)
// ==========================
async function generarImagenIA(productName, idea) {
  if (!process.env.RUNWARE_API_KEY) {
    console.warn("⚠️ RUNWARE_API_KEY no definido. Devolviendo placeholder.");
    return "https://via.placeholder.com/1024x1024?text=Propuesta+IA";
  }

  const positivePrompt = construirPromptPro(productName, idea);
  const negativePrompt = construirNegativePromptPro();

  const payload = [
    {
      auth: {
        engineId: "runware:101@1", // FLUX.1 Dev (calidad balanceada)
        apiKey: process.env.RUNWARE_API_KEY,
      },
    },
    {
      imageInference: {
        positivePrompt,
        negativePrompt,
        samplerName: "dpmpp_2m_sde",
        steps: 28,
        cfgScale: 4.5,
        scheduler: "karras",
        imageHeight: 1024,
        imageWidth: 1024,
        seed: -1,
        clipSkip: 2,
        tiling: false,
        safetyCheck: "soft",
        imageGuidanceScale: 1,
        imageInferenceId: Date.now(),
        loras: [],
      },
    },
  ];

  try {
    const resp = await fetch("https://api.runware.ai/v1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const json = await resp.json();
    console.log("🔍 RUNWARE RAW RESPONSE:", JSON.stringify(json));

    const dataArr = Array.isArray(json.data) ? json.data : [];
    const first = dataArr.find((d) => d.taskType === "imageInference") || dataArr[0];

    const url = first?.imageURL;
    if (!url) {
      throw new Error("No imageURL in Runware response");
    }

    return url;
  } catch (err) {
    console.error("❌ ERROR Runware FLUX:", err);
    return "https://via.placeholder.com/1024x1024?text=FLUX+Error";
  }
}

// ==========================
// Mensaje para resultado-ia
// ==========================
function generarMensajePersonalizado(productName, idea) {
  let base = `La elección de "${productName}" encaja muy bien con el estilo que estás buscando. `;

  if (idea && idea.trim().length > 0) {
    base += `Tuvimos en cuenta tu comentario: “${idea.trim()}” para ajustar la composición y el lugar del producto. `;
  } else {
    base +=
      "Buscamos una composición equilibrada y minimalista para que el producto destaque sin recargar el ambiente. ";
  }

  base +=
    "Esta visualización está pensada para ayudarte a tomar decisiones con más confianza, viendo cómo se transforma tu espacio antes de comprar.";

  return base;
}

// ==========================
// RUTAS
// ==========================

// Healthcheck
app.get("/", (req, res) => {
  res.send("INNOTIVA BACKEND · Runware FLUX Dev ✅");
});

// Productos (por si lo usas más adelante)
app.get("/productos-shopify", async (req, res) => {
  try {
    const products = await getShopifyProducts();
    return res.json({ success: true, products });
  } catch (err) {
    console.error("ERR /productos-shopify:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Ruta principal: recibe imagen + producto y devuelve JSON para Shopify
app.post(
  "/experiencia-premium",
  upload.single("roomImage"),
  async (req, res) => {
    try {
      console.log("📩 Nueva solicitud /experiencia-premium");
      console.log("🖼 file:", !!req.file, req.file?.mimetype, req.file?.size);
      console.log("📦 body:", req.body);

      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: "Falta la imagen del espacio (roomImage)",
        });
      }

      const { productId, productName, idea, productUrl } = req.body;

      if (!productId || !productName) {
        return res.status(400).json({
          success: false,
          error: "Faltan datos del producto (productId / productName)",
        });
      }

      // (Opcional) info extra del producto desde Shopify
      let productImageUrl = null;
      try {
        const producto = await obtenerProductoPorId(productId);
        if (producto && producto.image) {
          productImageUrl = producto.image;
        }
      } catch (metaErr) {
        console.warn("No se pudo enriquecer info de producto:", metaErr);
      }

      // 1) Subir foto original del cliente a Cloudinary
      const userImageUrl = await uploadBufferToCloudinary(
        req.file.buffer,
        "innotiva/rooms",
        "room"
      );

      // 2) Generar imagen IA (texto→imagen)
      const generatedImageUrl = await generarImagenIA(
        productName,
        idea || ""
      );

      // 3) URL final del producto
      let finalProductUrl = productUrl || null;
      if (!finalProductUrl) {
        finalProductUrl = `https://${SHOPIFY_STORE_DOMAIN}/products/${productId}`;
      }

      // 4) Mensaje para resultado-ia
      const message = generarMensajePersonalizado(productName, idea);

      // 5) Respuesta JSON (lo guarda sessionStorage en Shopify)
      return res.json({
        success: true,
        message,
        userImageUrl,
        generatedImageUrl,
        productUrl: finalProductUrl,
        productName,
        productId,
        productImageUrl,
      });
    } catch (err) {
      console.error("ERR /experiencia-premium:", err);
      return res.status(500).json({
        success: false,
        error: "Error interno preparando la experiencia premium",
      });
    }
  }
);

// ==========================
// INICIO SERVIDOR
// ==========================
app.listen(PORT, () => {
  console.log(`🔥 Backend ONLINE · PUERTO: ${PORT}`);
});
