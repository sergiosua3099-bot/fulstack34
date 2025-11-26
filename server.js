// server.js
// Backend Innotiva - Versión PRO, single file
// Rutas clave:
//  - GET  /              (healthcheck)
//  - GET  /productos-shopify
//  - POST /experiencia-premium  (recibe roomImage, productId, productName, productUrl?, idea)

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fetch = require("node-fetch");
const cloudinary = require("cloudinary").v2;
const Replicate = require("replicate");

// ==========================
// Config base
// ==========================
const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Multer para la foto del cliente
const upload = multer({ storage: multer.memoryStorage() });

// Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Replicate
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

// Shopify
const SHOPIFY_STORE_DOMAIN =
  process.env.SHOPIFY_STORE_DOMAIN || "innotiva-vision.myshopify.com";

const SHOPIFY_STOREFRONT_TOKEN =
  process.env.SHOPIFY_STOREFRONT_TOKEN ||
  process.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN ||
  "";

// ==========================
// Helpers
// ==========================

// Subir buffer a Cloudinary y devolver URL segura
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

// Obtener productos desde Shopify para el formulario
async function getShopifyProducts() {
  if (!SHOPIFY_STOREFRONT_TOKEN) {
    console.warn(
      "⚠️ SHOPIFY_STOREFRONT_TOKEN no definido. La llamada GraphQL puede fallar."
    );
  }

  const endpoint = `https://${SHOPIFY_STORE_DOMAIN}/api/2024-01/graphql.json`;

  const query = `
    {
      products(first: 50) {
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

  const headers = {
    "Content-Type": "application/json",
  };

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
    console.error("Error Shopify:", resp.status, txt);
    throw new Error("No se pudieron obtener los productos de Shopify");
  }

  const json = await resp.json();
  const edges = json?.data?.products?.edges || [];

  const products = edges.map((edge) => {
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
      id: handle, // usamos el handle como ID que viaja al front
      handle,
      title: node.title,
      description: node.description || "",
      image: imageUrl,
      url,
    };
  });

  return products;
}

// Buscar un producto concreto por id/handle reutilizando la lista
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

// Recorte rápido de fondo con Replicate (opcional, B1)
// Si REPLICATE_BG_MODEL_ID no está definido, simplemente no hace nada.
async function removerFondoProducto(productImageUrl) {
  const bgModelId = process.env.REPLICATE_BG_MODEL_ID;

  if (!bgModelId) {
    console.warn(
      "⚠️ REPLICATE_BG_MODEL_ID no definido. Se omite el recorte de producto."
    );
    return null;
  }

  try {
    const output = await replicate.run(bgModelId, {
      input: {
        image: productImageUrl,
      },
    });

    if (Array.isArray(output) && output.length > 0) return output[0];
    if (typeof output === "string") return output;
    if (output && typeof output === "object" && output.image) {
      return output.image;
    }

    console.warn("No se pudo interpretar la salida de remover fondo:", output);
    return null;
  } catch (error) {
    console.error("Error en removerFondoProducto:", error);
    return null;
  }
}

// ==========================
// Mensaje para la página resultado
// ==========================
function generarMensajePersonalizado(productName, idea) {
  let base = `La elección de "${productName}" encaja muy bien con el estilo de tu espacio. `;

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
// Deducción del tipo de producto
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
// Prompt PRO para el modelo
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
most natural in the scene, with soft warm lighting and realistic shadows, without redesigning the furniture.`;
      break;

    case "estante":
      instruccionProducto = `
Add a floating shelf / wall-mounted unit called "${productName}" on a clean wall section,
aligned and straight, with correct perspective and subtle contact shadow.`;
      break;

    case "planta":
      instruccionProducto = `
Add a decorative plant called "${productName}" in the most natural corner or area of the room
(near a window, next to a sofa, or by a console), adding freshness without blocking windows or furniture.`;
      break;

    case "alfombra":
      instruccionProducto = `
Add a rug called "${productName}" on the floor zone that best anchors the furniture composition,
with correct perspective under or near the existing furniture, respecting contact shadows.`;
      break;

    case "cojin":
      instruccionProducto = `
Add decorative cushions / pillows called "${productName}" on sofas, chairs or bed,
arranged neatly and matching the style and color palette of the existing furniture.`;
      break;

    case "cortina":
      instruccionProducto = `
Add curtains called "${productName}" on the appropriate window or wall area,
with realistic fabric folds and interaction with the existing light direction.`;
      break;

    case "reloj":
      instruccionProducto = `
Add a decorative wall clock called "${productName}" on a visible wall,
at a natural height and aligned with existing furniture or composition lines.`;
      break;

    case "cuadro":
      instruccionProducto = `
Add a single wall art / frame / print called "${productName}" on the most visually balanced wall area
(typically centered above the main sofa, bed or console), hung straight with realistic frame size.`;
      break;

    default:
      instruccionProducto = `
Add a single home decor product called "${productName}" automatically positioned in the place that makes
the most sense compositionally, integrating it with the existing room without redesigning everything.`;
      break;
  }

  const wowLinea = `
Enhance the scene with soft premium lighting, clean contrast and a magazine-quality interior design look,
as if photographed for a high-end Scandinavian decor catalog.`;

  const promptBase = `
Ultra detailed, photorealistic interior photograph of the EXACT SAME room as the reference image.
Preserve the original furniture, floor, walls, camera angle, framing and lighting.

${instruccionProducto}

${ideaTexto}

${wowLinea}

Rules:
- Do NOT change the main layout or remove key furniture.
- Do NOT warp or bend walls, floors or large objects.
- Do NOT change the camera angle or crop aggressively.
- Respect the original light direction and color temperature.
- Modify only what is necessary to integrate the product realistically.
- The final render must look like a real photograph, not a painting or cartoon.
`;

  return promptBase.trim();
}

// Negative prompt (ahora no lo pasamos al modelo FLUX, pero lo dejamos por si lo quieres usar)
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
// Llamada a Replicate (Plan A1) con FLUX 1.1 PRO
// ==========================
async function generarImagenIA(roomImageUrl, productName, idea) {
  if (!process.env.REPLICATE_API_TOKEN) {
    console.warn("⚠️ REPLICATE_API_TOKEN no definido. Devolviendo placeholder.");
    return "https://via.placeholder.com/1024x1024?text=Propuesta+IA";
  }

  // FLUX 1.1 [pro] estándar en Replicate
  // Puedes sobreescribir con REPLICATE_ROOM_MODEL_ID o REPLICATE_MODEL_ID si quieres otro modelo.
  const modelId =
    process.env.REPLICATE_ROOM_MODEL_ID ||
    process.env.REPLICATE_MODEL_ID ||
    "black-forest-labs/flux-1.1-pro";

  const prompt = construirPromptPro(productName, idea);
  // const negativePrompt = construirNegativePromptPro(); // si en algún momento el modelo soporta negative_prompt

  try {
    const input = {
      prompt,
      aspect_ratio: "3:2",        // encaja bien con tus cajas 500x300 aprox
      output_format: "webp",
      output_quality: 80,
      safety_tolerance: 2,
      num_outputs: 1,

      // Usamos la foto del cliente como guía de composición
      image_prompt: roomImageUrl,
      image_prompt_strength: 0.35, // cuánto manda la foto vs el prompt
      prompt_upsampling: false,
      // Si el modelo llegara a soportar negative_prompt en Replicate:
      // negative_prompt: negativePrompt,
    };

    const output = await replicate.run(modelId, { input });

    if (Array.isArray(output) && output.length > 0) {
      // FLUX suele devolver un array de URLs
      return output[0];
    }

    console.warn("⚠️ Replicate devolvió salida vacía:", output);
    return "https://via.placeholder.com/1024x1024?text=Propuesta+IA";
  } catch (err) {
    console.error("Error llamando a Replicate FLUX 1.1 PRO:", err);
    return "https://via.placeholder.com/1024x1024?text=Propuesta+IA";
  }
}

// ==========================
// Rutas
// ==========================

// Healthcheck
app.get("/", (req, res) => {
  res.send("INNOTIVA BACKEND PRO ✅ con Replicate FLUX 1.1 Pro");
});

// Productos para el formulario
app.get("/productos-shopify", async (req, res) => {
  try {
    const products = await getShopifyProducts();
    return res.json({ success: true, products });
  } catch (err) {
    console.error("ERR /productos-shopify:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Experiencia premium
app.post(
  "/experiencia-premium",
  upload.single("roomImage"),
  async (req, res) => {
    try {
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

      // Info extra del producto
      let productImageUrl = null;
      let productCutoutUrl = null;
      let placementHint = null;

      try {
        if (productName) {
          placementHint = inferirTipoProducto(productName);
        }

        if (productId) {
          const producto = await obtenerProductoPorId(productId);
          if (producto && producto.image) {
            productImageUrl = producto.image;
            // recorte rápido opcional (B1)
            productCutoutUrl = await removerFondoProducto(productImageUrl);
          }
        }
      } catch (metaErr) {
        console.warn("No se pudo enriquecer la info del producto:", metaErr);
      }

      // 1) Subir la foto original del cliente a Cloudinary
      const userImageUrl = await uploadBufferToCloudinary(
        req.file.buffer,
        "innotiva/rooms",
        "room"
      );

      // 2) Generar imagen IA con Replicate (FLUX 1.1 PRO)
      const generatedImageUrl = await generarImagenIA(
        userImageUrl,
        productName,
        idea || ""
      );

      // 3) URL final del producto
      let finalProductUrl = productUrl || null;
      if (!finalProductUrl) {
        finalProductUrl = `https://${SHOPIFY_STORE_DOMAIN}/products/${productId}`;
      }

      // 4) Mensaje para la página resultado
      const message = generarMensajePersonalizado(productName, idea);

      // 5) Respuesta JSON para el front (sessionStorage en Shopify)
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
        placementHint,
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
// Iniciar servidor
// ==========================
app.listen(PORT, () => {
  console.log(`🚀 INNOTIVA BACKEND PRO LISTO en puerto ${PORT}`);
});

