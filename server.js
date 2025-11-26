/**************************************************
 INNOTIVA BACKEND — VERSION B (Balanced Quality)
 FLUX 1.1 PRO via Replicate
**************************************************/

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fetch = require("node-fetch");
const cloudinary = require("cloudinary").v2;
const Replicate = require("replicate");

// ==========================
// BASE APP
// ==========================
const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const upload = multer({ storage: multer.memoryStorage() });

// ==========================
// CLOUDINARY
// ==========================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

async function uploadBufferToCloudinary(buffer, folder, prefix) {
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
  process.env.SHOPIFY_STOREFRONT_TOKEN || "";

// obtiene productos con imágenes y título
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
            description
            images(first: 1) {
              edges {
                node {
                  url
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

  const r = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ query }),
  });

  if (!r.ok) {
    throw new Error(`Error Shopify: ${r.status} ${r.statusText}`);
  }

  const json = await r.json();
  const edges = json?.data?.products?.edges || [];

  return edges.map((e) => {
    const n = e.node;
    const imgEdge = n.images?.edges?.[0];
    return {
      id: n.id, // id global GraphQL
      title: n.title,
      handle: n.handle,
      description: n.description,
      image: imgEdge?.node?.url || null,
      url: `/products/${n.handle}`,
    };
  });
}

async function obtenerProductoPorId(productId) {
  // productId que viene del front es el ID numérico de Shopify (product.id)
  // en este backend usamos handle y título, así que buscamos por handle o incluimos fallback
  const products = await getShopifyProducts();

  // Primero intentar match exacto por handle (si lo estás mandando así),
  // luego por inclusión en id, y si no encuentra, null.
  const encontrado =
    products.find((p) => String(p.id).includes(String(productId))) || null;

  return encontrado;
}

// ==========================
// IA — FLUX 1.1 PRO (Replicate)
// ==========================

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

/**
 * Construye un prompt muy profesional para decoración de interiores.
 */
function construirPromptPro(roomImageUrl, productName, idea) {
  const ideaLimpia = (idea || "").trim();

  const instruccionUsuario = ideaLimpia
    ? `El cliente indicó: "${ideaLimpia}". Respeta esta indicación al ubicar el producto.`
    : "Si el cliente no dio indicaciones, elige la ubicación con mejor composición visual y equilibrio.";

  return `
Fotografía profesional de diseño de interiores, hiperrealista, iluminación suave y natural.

Escena: un dormitorio / sala contemporánea, paredes claras, sensación de calma y elegancia minimalista.
Debe verse como una fotografía real de catálogo de una marca premium.

Producto protagonista: "${productName}" integrado en el espacio de forma natural, con proporción correcta,
perspectiva coherente y sombras realistas.

${instruccionUsuario}

Estilo visual:
- Colores neutros y cálidos, coherentes con un hogar moderno.
- Detalles nítidos en texturas (madera, tela, pared).
- Nada recargado: composición limpia, sofisticada y aspiracional.

Cámara:
- Fotografía recta u ligeramente en ángulo, sin distorsiones exageradas.
- Calidad 4K, alto nivel de detalle, sin ruido.

NO añadir texto, logos, marcas de agua ni elementos ajenos a decoración de interiores.
  `.trim();
}

function construirNegativePromptPro() {
  return `
baja calidad, borroso, deformado, perspectiva rara, manos, personas, cuerpos, texto, letras,
logo, marca de agua, glitch, arte digital, caricatura, anime, 3d cartoon, saturación extrema,
objetos flotando, proporciones irreales, distorsión tipo ojo de pez, cámaras múltiples, frames dobles
  `.trim();
}

/**
 * Llama a FLUX 1.1 PRO en Replicate
 * Importante: FLUX 1.1 PRO es un modelo texto → imagen.
 * Usamos la foto del cliente sólo como contexto de negocio, pero la generación es desde prompt.
 */
async function generarImagenIA(roomImageUrl, productName, idea) {
  if (!process.env.REPLICATE_API_TOKEN) {
    console.warn("⚠️ Falta REPLICATE_API_TOKEN, devolviendo placeholder");
    return "https://via.placeholder.com/1024x1024?text=Configura+REPLICATE_API_TOKEN";
  }

  const model =
    process.env.REPLICATE_FLUX_MODEL_ID || "black-forest-labs/flux-1.1-pro";

  const prompt = construirPromptPro(roomImageUrl, productName, idea);
  const negativePrompt = construirNegativePromptPro();

  console.log("🧠 Llamando a Replicate FLUX 1.1 PRO con modelo:", model);

  try {
    const output = await replicate.run(model, {
      input: {
        prompt,
        negative_prompt: negativePrompt,
        // parámetros típicos para FLUX
        aspect_ratio: "3:4",
        output_format: "png",
        output_quality: 90,
        num_inference_steps: 28,
        guidance_scale: 3.5,
        // num_outputs: 1  // por defecto 1
      },
    });

    let imageUrl = null;

    if (Array.isArray(output) && output.length > 0) {
      imageUrl = output[0];
    } else if (typeof output === "string") {
      imageUrl = output;
    } else if (
      output &&
      Array.isArray(output.output) &&
      output.output.length > 0
    ) {
      imageUrl = output.output[0];
    }

    if (!imageUrl) {
      console.warn("⚠️ Replicate (FLUX) no devolvió URL de imagen:", output);
      throw new Error("No image URL from Replicate");
    }

    console.log("✅ FLUX generó imagen:", imageUrl);
    return imageUrl;
  } catch (err) {
    console.error("❌ ERROR FLUX IA:", err);
    return "https://via.placeholder.com/1024x1024?text=Error+IA";
  }
}

// ==========================
// Mensaje descripción IA
// ==========================
function generarMensajePersonalizado(name, idea) {
  const ideaLimpia = (idea || "").trim();

  const extra = ideaLimpia
    ? `Tuvimos en cuenta tu indicación: “${ideaLimpia}”.`
    : "Cuidamos la composición para que el espacio se vea limpio, equilibrado y acogedor.";

  return `
Hemos preparado una visualización con **${name}** integrada en tu espacio
para que puedas tomar una decisión con calma antes de invertir.

${extra}
`.trim();
}

// ==========================
// RUTAS
// ==========================
app.get("/", (req, res) =>
  res.send("INNOTIVA — Backend FLUX 1.1 PRO Running ✔")
);

app.get("/productos-shopify", async (req, res) => {
  try {
    const products = await getShopifyProducts();
    res.json({ success: true, products });
  } catch (e) {
    console.error("Error listando productos Shopify:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ==========================
// MAIN ROUTE — IA ROOM
// ==========================
app.post(
  "/experiencia-premium",
  upload.single("roomImage"),
  async (req, res) => {
    console.log("📩 Nueva solicitud POST /experiencia-premium");

    try {
      if (!req.file) {
        console.warn("❌ No llegó archivo de imagen");
        return res.status(400).json({ error: "No llega imagen" });
      }

      console.log(
        "🖼 file:",
        req.file.mimetype,
        req.file.size
      );

      const { productId, productName, idea, productUrl } = req.body;
      console.log("📦 body:", req.body);

      // Opcional: buscar info extra en Shopify (no obligatorio para que funcione)
      let productMeta = null;
      try {
        productMeta = await obtenerProductoPorId(productId);
      } catch (e) {
        console.warn("⚠️ No se pudo enriquecer producto desde Shopify:", e);
      }

      // 1) Subimos la foto del cliente a Cloudinary
      const userImageUrl = await uploadBufferToCloudinary(
        req.file.buffer,
        "innotiva/rooms",
        "room"
      );
      console.log("☁️ Imagen subida a Cloudinary:", userImageUrl);

      // 2) Generamos imagen IA con FLUX 1.1 PRO (texto a imagen)
      const nombreParaPrompt =
        productMeta?.title || productName || "producto decorativo premium";
      const generatedImageUrl = await generarImagenIA(
        userImageUrl,
        nombreParaPrompt,
        idea
      );

      // 3) Respondemos al front
      res.json({
        success: true,
        message: generarMensajePersonalizado(nombreParaPrompt, idea),
        userImageUrl, // se muestra como "Antes"
        generatedImageUrl, // se muestra como "Después (IA)"
        productUrl:
          productUrl ||
          (productMeta
            ? productMeta.url
            : `https://${SHOPIFY_STORE_DOMAIN}/products/${productId}`),
        productName: nombreParaPrompt,
      });
    } catch (err) {
      console.error("❌ Error en /experiencia-premium:", err);
      res
        .status(500)
        .json({ success: false, error: "Error en flujo IA", details: err.message });
    }
  }
);

// ==========================
// LAUNCH
// ==========================
app.listen(PORT, () =>
  console.log("🔥 Backend ONLINE · PUERTO:", PORT)
);
