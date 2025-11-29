// index.js — INNOTIVA BACKEND PRO FINAL DECEMBER BUILD

require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const sharp = require("sharp");
const crypto = require("crypto");
const OpenAI = require("openai");
const cloudinary = require("cloudinary").v2;
const fetch = global.fetch;

// ================== CONFIG ==================
const app = express();
const upload = multer({ storage: multer.memoryStorage() });
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;
const REPLICATE_MODEL = process.env.REPLICATE_MODEL_SLUG || "black-forest-labs/flux-fill-dev";
const SHOP = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN;

// ================== HEALTHCHECK ==================
app.get("/", (_,res)=>res.send("🟢 INNOTIVA BACKEND RUNNING"));
app.get("/health",(req,res)=>res.json({ok:true,time:new Date().toISOString()}));

// ================== UTILS ==================
const log=x=>console.log(`📌 ${x}`);

const safeParse = txt=>{
  try{ return JSON.parse(txt.replace(/```json|```/g,"").trim()) }
  catch(e){ return null }
};

// upload buffer → cloudinary
const uploadBuffer = (buffer,folder,name)=>new Promise((res,rej)=>{
  cloudinary.uploader.upload_stream({folder,public_id:`${name}-${Date.now()}`},
    (err,r)=>err?rej(err):res(r)
  ).end(buffer)
});

// upload URL → cloudinary
const uploadURL = (url,folder,name)=>new Promise((res,rej)=>{
  cloudinary.uploader.upload(url,{folder,public_id:`${name}-${Date.now()}`},
  (err,r)=>err?rej(err):res(r))
});

// Shopify Product Fetch
async function getProduct(id){
  const gid = id.startsWith("gid:")?id:`gid://shopify/Product/${id}`;
  const q=`query($id:ID!){product(id:$id){title productType featuredImage{url}}}`;
  const r = await fetch(`https://${SHOP}/api/2024-01/graphql.json`,{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "X-Shopify-Storefront-Access-Token":TOKEN
    },
    body:JSON.stringify({query:q,variables:{id:gid}})
  }).then(r=>r.json());

  if(!r.data?.product) throw new Error("❌ No product found in Shopify");
  return {
    name:r.data.product.title,
    type:r.data.product.productType||"decor",
    img:r.data.product.featuredImage?.url?.replace(".jpg",".png") // 🔥 PNG real
  };
}

// ================== VISION ANALYSIS ==================
async function analyze(room,prod,name,type,idea){
  const prompt = `
Analiza ambas imágenes y devuelve SOLO JSON:

{
 "imageWidth":number,"imageHeight":number,
 "placement":{"x":n,"y":n,"width":n,"height":n},
 "finalPlacement":{"x":n,"y":n,"width":n,"height":n}
}

Producto: ${name}
Tipo: ${type}
Idea cliente: "${idea||"no especificada"}"

No escribas texto adicional fuera del JSON.
`;

  const r = await openai.responses.create({
    model:"gpt-4.1-mini",
    input:[{
      role:"user",content:[
        {type:"input_text",text:prompt},
        {type:"input_image",image_url:room},
        {type:"input_image",image_url:prod}
      ]
    }]
  });

  const raw = r.output[0].content
    .filter(c=>c.type==="output_text")
    .map(c=>c.text).join("\n");

  const json=safeParse(raw);
  if(!json) throw new Error("❌ Vision JSON parse error");

  return json;
}

// ================== MASK ==================
async function makeMask({imageWidth,imageHeight,finalPlacement}){
  const w=imageWidth,h=imageHeight;
  const buf=Buffer.alloc(w*h,0);

  const {x,y,width,height}=finalPlacement;
  for(let j=y;j<y+height;j++)
    for(let i=x;i<x+width;i++)
      buf[j*w+i]=255;

  return sharp(buf,{raw:{width:w,height:h,channels:1}}).png().toBuffer();
}

// ================== COMPOSITE PRODUCT ==================
async function composite(roomURL,prodURL,box){
  log("🧩 insertando producto PNG…");

  const room=await fetch(roomURL).then(r=>r.arrayBuffer());
  const item=await fetch(prodURL).then(r=>r.arrayBuffer());

  const resized=await sharp(Buffer.from(item))
    .resize(box.width,{fit:"contain"})
    .png().toBuffer();

  const final=await sharp(Buffer.from(room))
    .composite([{input:resized,top:box.y,left:box.x}])
    .jpeg({quality:96})
    .toBuffer();

  const up=await uploadBuffer(final,"innotiva/compose","placed");
  return up.secure_url;
// ================== THUMBNAILS ==================
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
  upload.single("roomImage"),
  async (req, res) => {
    const startedAt = Date.now();

    try {
      log("🔥 Nueva experiencia-premium");
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

      // 1) Subir habitación
      const roomUpload = await uploadBuffer(
        file.buffer,
        "innotiva/rooms",
        "room"
      );
      const roomUrl = roomUpload.secure_url;
      const roomPublicId = roomUpload.public_id;

      log(`🖼 Room subida: ${roomUrl}`);

      // 2) Producto desde Shopify
      const p = await getProduct(String(productId));
      const effectiveName = productName || p.name || "tu producto";

      if (!p.img) {
        throw new Error("El producto no tiene imagen en Shopify");
      }

      // 3) Vision: dónde va el producto
      const analysisRaw = await analyze(
        roomUrl,
        p.img,
        effectiveName,
        p.type,
        idea
      );

      // Normalizar analysis
      const imageWidth = Number(analysisRaw.imageWidth) || 1200;
      const imageHeight = Number(analysisRaw.imageHeight) || 800;

      let finalPlacement = analysisRaw.finalPlacement || analysisRaw.placement;
      if (
        !finalPlacement ||
        typeof finalPlacement.x !== "number" ||
        typeof finalPlacement.y !== "number"
      ) {
        // fallback centrado
        const w = Math.round(imageWidth * 0.28);
        const h = Math.round(imageHeight * 0.24);
        finalPlacement = {
          x: Math.round((imageWidth - w) / 2),
          y: Math.round((imageHeight - h) / 3),
          width: w,
          height: h
        };
      }

      // clamp
      finalPlacement.x = Math.max(0, finalPlacement.x);
      finalPlacement.y = Math.max(0, finalPlacement.y);
      finalPlacement.width = Math.min(
        imageWidth - finalPlacement.x,
        finalPlacement.width
      );
      finalPlacement.height = Math.min(
        imageHeight - finalPlacement.y,
        finalPlacement.height
      );

      const analysis = {
        imageWidth,
        imageHeight,
        roomStyle: analysisRaw.roomStyle || "tu espacio",
        placement: analysisRaw.placement || finalPlacement,
        finalPlacement,
        product: analysisRaw.product || null
      };

      // 4) Máscara
      log("🎭 Generando máscara…");
      const maskBuffer = await makeMask({
        imageWidth,
        imageHeight,
        finalPlacement
      });
      const maskBase64 = maskBuffer.toString("base64");
      log("✅ Máscara generada");

      // 5) Componer producto PNG real sobre el cuarto
      const composedUrl = await composite(roomUrl, p.img, finalPlacement);
      log(`🧩 Composición lista: ${composedUrl}`);

      // 6) Prompt para FLUX: SOLO pulir, no inventar otro producto
      const prompt = `
Eres un modelo de inpainting fotográfico de alta fidelidad.

IMPORTANTE:
- En la imagen de entrada YA HEMOS COLOCADO el producto "${effectiveName}" con su forma real.
- Tu trabajo NO es inventar un objeto nuevo.
- Tu misión es integrar el producto con realismo dentro del cuarto:
  - Sombras coherentes
  - Bordes limpios
  - Brillo y contraste acordes a la iluminación del entorno

Reglas:
- Solo modifica la zona blanca de la máscara.
- No borres el producto ni lo sustituyas por un televisor u otro objeto.
- No cambies el color global de paredes, muebles o suelos.
- No añadas personas, mascotas ni elementos fantasiosos.

Contexto del cliente:
- Idea: "${idea || "sin indicaciones específicas"}"
- Tipo de producto Shopify: "${p.type || "decor"}"

Objetivo:
- Que el cliente sienta que el producto EXISTE de verdad en su espacio,
  como foto de catálogo premium.
`;

      // 7) FLUX (Replicate)
      log("🚀 Llamando a FLUX (safe mode)…");

      const start = await fetch(
        `https://api.replicate.com/v1/models/${encodeURIComponent(
          REPLICATE_MODEL
        )}/predictions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${REPLICATE_TOKEN}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            input: {
              image: composedUrl, // base con producto ya puesto
              mask: `data:image/png;base64,${maskBase64}`,
              prompt,
              guidance: 5,
              num_inference_steps: 24,
              output_format: "webp",
              output_quality: 98,
              megapixels: "1"
            }
          })
        }
      ).then(r => r.json());

      if (!start.id) {
        console.error("❌ No se pudo iniciar FLUX:", start);
        throw new Error("No se pudo iniciar FLUX");
      }

      let fluxResult = start;
      while (
        fluxResult.status !== "succeeded" &&
        fluxResult.status !== "failed"
      ) {
        await new Promise(r => setTimeout(r, 2000));
        fluxResult = await fetch(
          `https://api.replicate.com/v1/predictions/${start.id}`,
          {
            headers: { Authorization: `Bearer ${REPLICATE_TOKEN}` }
          }
        ).then(r => r.json());
      }

      if (fluxResult.status === "failed" || !fluxResult.output?.[0]) {
        console.error("❌ FLUX falló:", fluxResult);
        throw new Error("Flux-fill-dev no devolvió imagen");
      }

      const outUrl = fluxResult.output[0];
      log(`✅ FLUX OK: ${outUrl}`);

      // 8) Subir resultado final a Cloudinary
      const genUpload = await uploadURL(
        outUrl,
        "innotiva/generated",
        "room-generated"
      );
      const generatedImageUrl = genUpload.secure_url;
      const generatedPublicId = genUpload.public_id;

      const thumbnails = {
        before: buildThumbnails(roomPublicId),
        after: buildThumbnails(generatedPublicId)
      };

      // 9) Copy emocional
      const message = buildEmotionalCopy({
        roomStyle: analysis.roomStyle,
        productName: effectiveName,
        idea
      });

      const sessionId = crypto.randomUUID();

      log(
        `🎉 EXPERIENCIA LISTA en ${Date.now() - startedAt}ms`
      );

      return res.status(200).json({
        ok: true,
        status: "complete",
        sessionId,
        room_image: roomUrl,
        ai_image: generatedImageUrl,
        product_url: productUrl || null,
        product_name: effectiveName,
        product_id: productId,
        message,
        analysis,
        thumbnails,
        embedding: analysis.product || null,
        created_at: new Date().toISOString()
      });
    } catch (err) {
      console.error("❌ Error en /experiencia-premium:", err);
      return res.status(500).json({
        status: "error",
        message:
          "Tuvimos un problema al generar tu propuesta. Intenta otra vez en unos segundos."
      });
    }
  }
);

// ================== REPOSICIÓN IA ==================
app.post("/experiencia-premium-reposicion", async (req, res) => {
  try {
    const {
      roomImage,      // URL Cloudinary original
      ai_image_prev,  // última versión IA (si existe)
      productId,
      x,
      y,
      width,
      height,
      idea
    } = req.body;

    if (!roomImage || !productId || x == null || y == null || !width || !height) {
      return res.status(400).json({
        error:
          "⚠ Faltan datos para reposición IA (roomImage / productId / x / y / width / height)"
      });
    }

    const baseImage = ai_image_prev && ai_image_prev !== "" ? ai_image_prev : roomImage;

    log(
      `♻ Reposición manual → base=${baseImage.slice(
        0,
        60
      )}… click=(${x},${y})`
    );

    let productTypeHint = "producto decorativo";
    try {
      const p = await getProduct(String(productId));
      productTypeHint = p.type || productTypeHint;
    } catch (e) {
      console.error("No se pudo obtener productType en reposición:", e);
    }

    // zona alrededor del click (20–24% del ancho/alto)
    const boxWidth = Math.round(width * 0.24);
    const boxHeight = Math.round(height * 0.24);
    const boxX = Math.max(0, Math.round(x - boxWidth / 2));
    const boxY = Math.max(0, Math.round(y - boxHeight / 2));

    const placement = {
      imageWidth: width,
      imageHeight: height,
      finalPlacement: {
        x: boxX,
        y: boxY,
        width: boxWidth,
        height: boxHeight
      }
    };

    const maskBuffer = await makeMask(placement);
    const maskBase64 = maskBuffer.toString("base64");
    log("🟡 Máscara nueva para reposición IA generada");

    const miniPrompt = `
Reubica el ${productTypeHint} en la zona blanca de la máscara
según el click del cliente, sin alterar el resto de la habitación.
No borres el producto ni lo reemplaces por otro distinto.
Intención del cliente: "${idea || "reposicion manual"}"
`;

    const start = await fetch(
      `https://api.replicate.com/v1/models/${encodeURIComponent(
        REPLICATE_MODEL
      )}/predictions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${REPLICATE_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          input: {
            image: baseImage,
            mask: `data:image/png;base64,${maskBase64}`,
            prompt: miniPrompt,
            guidance: 4.6,
            num_inference_steps: 20,
            output_format: "webp",
            megapixels: "1"
          }
        })
      }
    ).then(r => r.json());

    let poll = start;
    while (poll.status !== "succeeded" && poll.status !== "failed") {
      await new Promise(r => setTimeout(r, 1800));
      poll = await fetch(
        `https://api.replicate.com/v1/predictions/${poll.id}`,
        {
          headers: { Authorization: `Bearer ${REPLICATE_TOKEN}` }
        }
      ).then(r => r.json());
    }

    if (!poll.output?.[0]) {
      throw new Error("Replicate no devolvió imagen nueva");
    }

    const up = await uploadURL(
      poll.output[0],
      "innotiva/repositions",
      "reposicion-v2"
    );

    log(`🟢 Reposición IA finalizada: ${up.secure_url}`);

    return res.json({
      ok: true,
      ai_image: up.secure_url,
      base_used: baseImage,
      updated_at: new Date().toISOString()
    });
  } catch (e) {
    console.error("❌ Error en reposición IA", e);
    return res.status(500).json({ error: "No se pudo reposicionar IA." });
  }
});

// ================== ARRANQUE SERVIDOR ==================
app.listen(PORT, () => {
  console.log(`🚀 INNOTIVA BACKEND PRO ejecutándose en puerto ${PORT}`);
  console.log(`🌍 Disponible en https://fulstack34.onrender.com`);
});
