// server.js
// Backend Innotiva - Versión PRO con FLUX 1.1 Pro (Replicate)
// Rutas clave:
//  - GET  /                  (healthcheck)
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

// Replicate (FLUX 1.1 Pro)
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
// Prompt PRO para FLUX 1.1 Pro
// ==========================
function construirPromptPro(productName, productDescription, idea) {
  const tipo = inferirTipoProducto(productName);
  const cleanName = (productName || "").trim();
  const cleanDesc = (productDescription || "").trim();
  const cleanIdea = (idea || "").trim();

  let contextoEspacio = "interior moderno, limpio y bien iluminado";
  let instruccionProducto = "";

  switch (tipo) {
    case "espejo":
      contextoEspacio =
        "sala o recibidor contemporáneo con paredes claras y mobiliario neutro";
      instruccionProducto = `
Coloca un único espejo decorativo llamado "${cleanName}" en la pared más lógica y visible,
alineado al mobiliario principal (sofá, consola, lavamanos o tocador),
a una altura realista. Evita crear espejos adicionales o distorsiones en la pared.`;
      break;

    case "lampara":
      contextoEspacio =
        "sala o dormitorio acogedor con iluminación suave y muebles minimalistas";
      instruccionProducto = `
Añade una sola lámpara decorativa llamada "${cleanName}" (de pie, mesa o pared según lo que sugiere el diseño),
ubicada en un punto natural del espacio (junto a un sofá, mesita de noche o consola),
proyectando luz cálida y realista, sin inventar muebles nuevos.`;
      break;

    case "estante":
      contextoEspacio =
        "pared limpia y organizada en sala, estudio o dormitorio moderno";
      instruccionProducto = `
Coloca un solo estante o repisa llamado "${cleanName}" en una pared libre,
perfectamente recto, a una altura coherente con la composición,
con una cantidad mínima de objetos encima, sin saturar el entorno.`;
      break;

    case "planta":
      contextoEspacio =
        "sala o esquina luminosa de un interior contemporáneo, cercano a una ventana";
      instruccionProducto = `
Añade una única planta decorativa llamada "${cleanName}" en la zona más natural
(cerca de una ventana, junto a un sofá o consola),
integrada de forma sutil sin bloquear circulación ni luz.`;
      break;

    case "alfombra":
      contextoEspacio =
        "sala o dormitorio con piso visible, muebles claros y composición central";
      instruccionProducto = `
Coloca una sola alfombra llamada "${cleanName}" en el piso, anclando el conjunto de muebles
(debajo o parcialmente debajo de sofá, cama o mesa de centro),
respetando las proporciones reales del espacio. No inventes muebles nuevos.`;
      break;

    case "cojin":
      contextoEspacio =
        "sofá o cama principal en un interior acogedor y minimalista";
      instruccionProducto = `
Añade cojines decorativos llamados "${cleanName}" únicamente sobre el sofá o la cama principal,
organizados de forma armónica y sin crear muebles adicionales.
No dupliques el sofá ni crees estructuras nuevas.`;
      break;

    case "cortina":
      contextoEspacio =
        "ventana realista en un dormitorio o sala moderna, con luz natural";
      instruccionProducto = `
Coloca unas cortinas llamadas "${cleanName}" en la(s) ventana(s) más lógica(s),
con caída natural y textura realista,
coherentes con la dirección de la luz existente.`;
      break;

    case "reloj":
      contextoEspacio =
        "pared limpia y visible en sala, comedor o estudio contemporáneo";
      instruccionProducto = `
Añade un único reloj de pared llamado "${cleanName}" en una zona visible,
alineado con líneas de muebles y marcos,
sin crear más relojes ni objetos extra.`;
      break;

    case "cuadro":
      contextoEspacio =
        "pared principal de sala, comedor o dormitorio con mobiliario neutro";
      instruccionProducto = `
Coloca un solo cuadro / marco / lámina llamado "${cleanName}" en la pared dominante,
generalmente centrado sobre el sofá, la cama o la consola,
con tamaño y proporciones realistas, perfectamente recto. No añadas otros cuadros nuevos.`;
      break;

    default:
      contextoEspacio =
        "interior moderno y minimalista con paleta de colores suaves y mobiliario realista";
      instruccionProducto = `
Añade un único elemento decorativo llamado "${cleanName}" en la ubicación más lógica,
integrado sutilmente en la escena sin rediseñar todo el espacio
ni añadir demasiados objetos nuevos.`;
      break;
  }

  const ideaTexto =
    cleanIdea.length > 0
      ? `Client guidance (español, respeta el significado): “${cleanIdea}”. Interpreta esto únicamente como una indicación sobre dónde y cómo ubicar el producto seleccionado, nunca como permiso para rediseñar todo el espacio.`
      : "No hay indicación específica del cliente; elige la mejor ubicación posible para el producto respetando la composición general.";

  const contextoProducto =
    cleanDesc.length > 0
      ? `Product details from catalog (short): ${cleanDesc}`
      : "The product has a refined, premium design suitable for a modern, minimal interior.";

  const reglas = `
Rules (STRICT):
- Crea exactamente UNA versión del producto seleccionado, sin copias duplicadas.
- No inventes muebles grandes nuevos ni cambies la estructura general: mantén una composición creíble de interior moderno.
- No incluyas texto, logos, marcas de agua ni tipografía visible en la imagen.
- Mantén una iluminación suave y premium, estilo catálogo de decoración escandinava / high-end.
- Respeta una paleta limpia, evitando colores saturados que rompan el estilo del espacio.
- No añadas personajes, personas ni animales.
- El foco principal de la escena debe ser el producto "${cleanName}" integrado en un interior realista y aspiracional.
`;

  const promptBase = `
Ultra detailed, photorealistic interior photograph, ${contextoEspacio}.
Cámara estable, encuadre natural, sensación de foto tomada para un catálogo de decoración premium.

${instruccionProducto}

${ideaTexto}

${contextoProducto}

${reglas}
`;

  return promptBase.trim();
}

// Negative prompt para limpiar la imagen
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
    "multiple copies of product",
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
// Llamada a Replicate (FLUX 1.1 Pro) - Texto a imagen
// ==========================
async function generarImagenIA(roomImageUrl, productName, productDescription, idea) {
  if (!process.env.REPLICATE_API_TOKEN) {
    console.warn("⚠️ REPLICATE_API_TOKEN no definido. Devolviendo placeholder.");
    return "https://via.placeholder.com/1024x1024?text=Propuesta+IA";
  }

  const modelId =
    process.env.REPLICATE_FLUX_MODEL_ID ||
    "black-forest-labs/flux-1.1-pro";

  const prompt = construirPromptPro(productName, productDescription, idea);
  const negativePrompt = construirNegativePromptPro();

  try {
    const output = await replicate.run(modelId, {
      input: {
        prompt,
        negative_prompt: negativePrompt,
        width: 1024,
        height: 1024,
        num_outputs: 1,
        guidance_scale: 4,
        num_inference_steps: 28,
        // FLUX 1.1 Pro es solo texto->imagen, no usamos roomImageUrl como conditioning real.
      },
    });

    // Manejo flexible: array, string o campo output
    if (Array.isArray(output) && output.length > 0) {
      return output[0];
    }

    if (typeof output === "string") {
      return output;
    }

    if (output && Array.isArray(output.output) && output.output[0]) {
      return output.output[0];
    }

    console.warn("⚠️ Replicate (FLUX) devolvió salida inesperada:", output);
    return "https://via.placeholder.com/1024x1024?text=Propuesta+IA";
  } catch (err) {
    console.error("Error llamando a Replicate FLUX 1.1 PRO:", err);
    return "https://via.placeholder.com/1024x1024?text=Propuesta+IA+Error";
  }
}

// ==========================
// Rutas
// ==========================

// Healthcheck
app.get("/", (req, res) => {
  res.send("INNOTIVA BACKEND PRO ✅ con FLUX 1.1 Pro");
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
    console.log("📩 Nueva solicitud /experiencia-premium");
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: "Falta la imagen del espacio (roomImage)",
        });
      }

      const { productId, productName, idea, productUrl } = req.body;

      console.log("🖼 file:", req.file.mimetype, req.file.size);
      console.log("📦 body:", req.body);

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
      let productDescription = "";

      try {
        if (productName) {
          placementHint = inferirTipoProducto(productName);
        }

        if (productId) {
          const producto = await obtenerProductoPorId(productId);
          if (producto) {
            productImageUrl = producto.image || null;
            productDescription = producto.description || "";
            // recorte rápido opcional (B1)
            if (productImageUrl) {
              productCutoutUrl = await removerFondoProducto(productImageUrl);
            }
          }
        }
      } catch (metaErr) {
        console.warn("No se pudo enriquecer la info del producto:", metaErr);
      }

      // 1) Subir la foto original del cliente a Cloudinary (para el "ANTES")
      const userImageUrl = await uploadBufferToCloudinary(
        req.file.buffer,
        "innotiva/rooms",
        "room"
      );

      // 2) Generar imagen IA con FLUX (texto a imagen + contexto de producto)
      const generatedImageUrl = await generarImagenIA(
        userImageUrl,
        productName,
        productDescription,
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
