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
// SHOPIFY – productos básicos (id, título, imagen)
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

  const resp = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ query }),
  });

  const json = await resp.json();

  if (!json.data || !json.data.products) return [];

  return json.data.products.edges.map((edge) => {
    const n = edge.node;
    return {
      id: n.id, // GraphQL global id
      handle: n.handle,
      title: n.title,
      image: n.images.edges[0]?.node.url || null,
    };
  });
}

async function obtenerProductoPorHandle(handleOId) {
  const products = await getShopifyProducts();
  // buscamos por handle o por id (por si tú mandas handle desde el front)
  return (
    products.find(
      (p) =>
        String(p.handle) === String(handleOId) ||
        String(p.id) === String(handleOId)
    ) || null
  );
}

// ====================================================
// REPLICATE – FLUX 1.1 PRO
// ====================================================
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

const FLUX_MODEL =
  process.env.REPLICATE_FLUX_MODEL_ID || "black-forest-labs/flux-1.1-pro";

/**
 * Prompt super profesional para CUADROS.
 * Enfoque:
 * - Mantener el espacio existente (salón, muebles, luz).
 * - Añadir SOLO el cuadro seleccionado.
 * - Usar la indicación del usuario siempre en relación al cuadro.
 */
function construirPromptCuadro({ productName, idea }) {
  const ideaLimpia = (idea || "").trim();

  const ideaTexto = ideaLimpia
    ? `
Instrucciones del cliente para la ubicación y escala del cuadro:
"${ideaLimpia}".
Respetar esta instrucción con la mayor precisión posible,
siempre que no destruya la composición del salón.`
    : `
Colocar el cuadro en una posición natural, equilibrada y protagonista en la escena,
sin tapar ventanas ni recortar elementos importantes.`;

  return `
Fotografía interior hiperrealista de un salón moderno ya amoblado.

Objetivo:
- Mantener EXACTAMENTE el mismo espacio arquitectónico original:
  mismas paredes, techo, suelo, ventanas, puertas, alfombra, sofá, mesas,
  cojines, lámparas y objetos existentes.
- NO eliminar, deformar, duplicar ni sustituir los muebles actuales.
- NO cambiar la luz, la paleta de color base ni el punto de vista de la cámara.

Acción principal:
- Añadir UN SOLO cuadro de pared del tipo "${productName}" perfectamente integrado:
  - Montado en la pared como una pieza real de decoración.
  - Proporción, escala y perspectiva coherentes con el sofá y el resto del mobiliario.
  - El marco del cuadro debe verse limpio y realista (no torcido, no recortado).
  - Estilo visual acorde al diseño de interiores premium del salón.

${ideaTexto}

Estilo visual:
- Calidad catálogo de marca de decoración de lujo.
- Iluminación suave natural, detalle nítido en el cuadro y el sofá.
- Composición limpia, elegante y cálida, lista para ser usada en una tienda online.
`;
}

const NEGATIVE_PROMPT_CUADRO = `
lienzo vacío, cuadro en blanco, texto en el cuadro, logos, marcas de agua,
personas, manos, cuerpos, animales, ojos distorsionados,
perspectiva rota, habitación diferente, muebles duplicados,
ventanas tapadas, paredes con textura surrealista,
arte extremadamente abstracto que no luce decorativo,
arte sangriento, violento, NSFW,
arte glitch, errores digitales, ruido fuerte, desenfoque extremo.
`;

/**
 * Llama a FLUX 1.1 PRO (texto → imagen)
 * De momento seguimos en text-to-image, pero con prompt muy controlado.
 */
async function generarImagenIA_FluxCuadro({ productName, idea }) {
  const prompt = construirPromptCuadro({ productName, idea });

  console.log("🧠 PROMPT ENVIADO A FLUX:\n", prompt);

  const output = await replicate.run(FLUX_MODEL, {
    input: {
      prompt,
      negative_prompt: NEGATIVE_PROMPT_CUADRO,
      num_outputs: 1,
      // algunos modelos de flux aceptan estos, si no, simplemente se ignoran
      aspect_ratio: "3:2",
      output_format: "png",
      guidance_scale: 3.5,
    },
  });

  if (!output || !output.length) {
    console.warn("⚠️ Replicate (FLUX) devolvió salida vacía");
    throw new Error("Sin salida de FLUX");
  }

  const imageUrl = output[0];
  console.log("✅ FLUX OUTPUT URL:", imageUrl);
  return imageUrl;
}

// ====================================================
// MENSAJE IA PARA EL RESULTADO
// ====================================================
function generarMensajePersonalizado(productName, idea) {
  const ideaLimpia = (idea || "").trim();

  let extra = "";
  if (ideaLimpia) {
    extra = `\n\nTomamos en cuenta tu indicación: “${ideaLimpia}” para la ubicación del cuadro.`;
  } else {
    extra =
      "\n\nElegimos una ubicación que equilibra proporción, luz y composición dentro de tu sala.";
  }

  return (
    `Así se vería tu espacio con el cuadro **${productName}** integrado en la pared, ` +
    `respetando la arquitectura y el estilo actual de tu habitación.` +
    extra
  );
}

// ====================================================
// RUTAS
// ====================================================

app.get("/", (req, res) => {
  res.send("INNOTIVA — Backend FLUX 1.1 PRO (cuadros) ✔");
});

// útil si el front quiere traer productos desde el backend
app.get("/productos-shopify", async (req, res) => {
  try {
    const products = await getShopifyProducts();
    res.json({ success: true, products });
  } catch (err) {
    console.error("❌ Error /productos-shopify:", err);
    res.status(500).json({ success: false, error: "Error obtenido productos" });
  }
});

// ====================================================
// ENDPOINT PRINCIPAL – EXPERIENCIA PREMIUM
// ====================================================
app.post(
  "/experiencia-premium",
  upload.single("roomImage"),
  async (req, res) => {
    console.log("📩 Nueva solicitud POST /experiencia-premium");

    try {
      if (!req.file) {
        console.warn("⚠️ No llegó archivo roomImage");
        return res.status(400).json({ success: false, error: "No llega imagen" });
      }

      console.log(
        "🖼 file:",
        req.file.mimetype,
        req.file.size
      );
      console.log("📦 body:", req.body);

      const { productId, productName, productUrl, idea } = req.body;

      // Intentamos obtener info extra del producto (opcional)
      let product = null;
      if (productId) {
        try {
          product = await obtenerProductoPorHandle(productId);
        } catch (err) {
          console.warn("⚠️ No se pudo obtener producto Shopify:", err.message);
        }
      }

      const nombreFinal =
        (product && product.title) || productName || "producto decorativo";

      // 1) Subir imagen original a Cloudinary
      const userImageUrl = await uploadBufferToCloudinary(
        req.file.buffer,
        "innotiva/rooms",
        "room"
      );
      console.log("☁️ Cloudinary URL:", userImageUrl);

      // 2) Generar imagen IA (texto → imagen) con FLUX 1.1 pro
      let generatedImageUrl;
      try {
        generatedImageUrl = await generarImagenIA_FluxCuadro({
          productName: nombreFinal,
          idea,
        });
      } catch (err) {
        console.error("❌ ERROR FLUX IA:", err);
        // fallback a placeholder para no romper la UX
        generatedImageUrl =
          "https://via.placeholder.com/1024x1024?text=No+se+pudo+generar+la+imagen+IA";
      }

      // 3) Mensaje IA
      const message = generarMensajePersonalizado(nombreFinal, idea);

      // 4) Respuesta JSON para Shopify (resultado-ia usa sessionStorage)
      const finalProductUrl =
        productUrl ||
        (product && product.handle
          ? `https://${SHOPIFY_STORE_DOMAIN}/products/${product.handle}`
          : `https://${SHOPIFY_STORE_DOMAIN}/collections/all`);

      const payload = {
        success: true,
        message,
        userImageUrl,
        generatedImageUrl,
        productUrl: finalProductUrl,
        productName: nombreFinal,
      };

      console.log("✅ Respuesta /experiencia-premium lista");
      res.json(payload);
    } catch (err) {
      console.error("❌ Error en /experiencia-premium:", err);
      res.status(500).json({
        success: false,
        error: "Error interno en experiencia premium",
      });
    }
  }
);

// ====================================================
// ARRANQUE
// ====================================================
app.listen(PORT, () => {
  console.log("🔥 Backend ONLINE · PUERTO:", PORT);
});  agrega al codigo js
