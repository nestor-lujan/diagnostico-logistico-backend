// ─────────────────────────────────────────────────────────────────────────────
// BACKEND — Diagnóstico Logístico · Luján Logística
// Stack: Node.js + Express + MercadoPago SDK v2
//
// Endpoints:
//   POST /api/create-preference  → crea preferencia de pago en MP
//   POST /api/mp-webhook         → recibe notificaciones de MP
//   GET  /api/verify-payment     → verifica si un pago fue aprobado
//
// Setup:
//   1. npm install
//   2. Copiá .env.example a .env y completá las variables
//   3. node server.js
// ─────────────────────────────────────────────────────────────────────────────

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { MercadoPagoConfig, Preference, Payment } = require("mercadopago");
const { sendConfirmacionComprador, sendNotificacionAdmin } = require("./email");

const app = express();
const PORT = process.env.PORT || 3001;

// ─── MERCADOPAGO CLIENT ──────────────────────────────────────────────────────

const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
  options: { timeout: 5000 },
});

// ─── MIDDLEWARE ──────────────────────────────────────────────────────────────

app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:3000",
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── BASE DE DATOS (en memoria para demo, reemplazá por DB real) ─────────────
// En producción: PostgreSQL, MongoDB, o Supabase.
// Estructura: { paymentId: { email, empresa, status, date } }

const pagosAprobados = new Map();

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "Luján Logística · Backend MP" });
});

// ─── POST /api/create-preference ─────────────────────────────────────────────
// Crea una preferencia de pago en MercadoPago y devuelve la URL de checkout.
// Body: { email: string, empresa?: string }

app.post("/api/create-preference", async (req, res) => {
  try {
    const { email, empresa } = req.body;

    if (!email || !/\S+@\S+\.\S+/.test(email)) {
      return res.status(400).json({ error: "Email inválido." });
    }

    const preference = await new Preference(mpClient).create({
      body: {
        items: [
          {
            id: "diagnostico-logistico-v1",
            title: "Diagnóstico Logístico para PYMEs — Luján Logística",
            description: "Score por área, ranking de problemas e informe PDF.",
            quantity: 1,
            currency_id: "ARS",
            unit_price: Number(process.env.PRECIO_ARS) || 49000,
          },
        ],
        payer: {
          email,
          name: empresa || "",
        },
        back_urls: {
          success: `${process.env.FRONTEND_URL}/diagnostico?status=approved`,
          failure: `${process.env.FRONTEND_URL}/diagnostico?status=rejected`,
          pending: `${process.env.FRONTEND_URL}/diagnostico?status=pending`,
        },
        auto_return: "approved",
        notification_url: `${process.env.BACKEND_URL}/api/mp-webhook`,
        metadata: { email, empresa: empresa || "" },
        // Medios de pago habilitados (ajustá según tu cuenta)
        payment_methods: {
          excluded_payment_types: [],
          installments: 1, // sin cuotas para producto digital
        },
        expires: false,
        statement_descriptor: "LUJAN LOGISTICA",
      },
    });

    console.log(`[MP] Preferencia creada: ${preference.id} · ${email}`);

    res.json({
      preference_id: preference.id,
      init_point: preference.init_point,           // producción
      sandbox_init_point: preference.sandbox_init_point, // testing
    });

  } catch (err) {
    console.error("[MP] Error creando preferencia:", err.message);
    res.status(500).json({ error: "Error al crear la preferencia de pago." });
  }
});

// ─── POST /api/mp-webhook ─────────────────────────────────────────────────────
// MercadoPago llama a este endpoint cuando cambia el estado de un pago.
// Verificamos la firma HMAC para asegurarnos de que viene de MP.

app.post("/api/mp-webhook", async (req, res) => {
  try {
    // 1. Verificar firma HMAC (solo en producción)
    if (process.env.MP_WEBHOOK_SECRET) {
      const xSignature = req.headers["x-signature"];
      const xRequestId = req.headers["x-request-id"];
      const dataId = req.query["data.id"] || req.body?.data?.id;

      if (xSignature && xRequestId && dataId) {
        const manifest = `id:${dataId};request-id:${xRequestId};ts:${xSignature.split(",")[0].split("=")[1]};`;
        const hmac = crypto
          .createHmac("sha256", process.env.MP_WEBHOOK_SECRET)
          .update(manifest)
          .digest("hex");
        const receivedHmac = xSignature.split(",")[1]?.split("=")[1];
        if (hmac !== receivedHmac) {
          console.warn("[MP] Firma HMAC inválida. Posible webhook falso.");
          return res.status(401).json({ error: "Firma inválida." });
        }
      }
    }

    const { type, data } = req.body;

    // 2. Solo procesamos eventos de pago
    if (type !== "payment" || !data?.id) {
      return res.status(200).json({ received: true });
    }

    // 3. Consultamos el pago a la API de MP para verificar estado real
    const payment = await new Payment(mpClient).get({ id: data.id });

    const { status, metadata, payer } = payment;
    const email = metadata?.email || payer?.email || "";
    const empresa = metadata?.empresa || "";

    console.log(`[MP] Pago ${data.id} · estado: ${status} · email: ${email}`);

    if (status === "approved") {
      // 4. Registramos el pago aprobado
      pagosAprobados.set(String(data.id), {
        paymentId: data.id,
        email,
        empresa,
        status: "approved",
        date: new Date().toISOString(),
      });

      // 5. Enviar emails en paralelo (sin bloquear la respuesta al webhook)
      Promise.all([
        sendConfirmacionComprador({ email, empresa }),
        sendNotificacionAdmin({
          email,
          empresa,
          paymentId: data.id,
          amount: payment.transaction_amount,
        }),
      ]).then(([r1, r2]) => {
        console.log(`[MP] ✓ Emails enviados · Comprador: ${r1.ok} · Admin: ${r2.ok}`);
      }).catch(err => {
        console.error("[Email] Error inesperado:", err.message);
      });

      console.log(`[MP] ✓ Pago aprobado registrado: ${email}`);
    }

    res.status(200).json({ received: true });

  } catch (err) {
    console.error("[MP] Error en webhook:", err.message);
    // Siempre respondemos 200 para que MP no reintente innecesariamente
    res.status(200).json({ received: true });
  }
});

// ─── GET /api/verify-payment ──────────────────────────────────────────────────
// El frontend llama a esto cuando MP redirige con ?status=approved
// para verificar que el pago realmente fue aprobado (anti-fraude).
// Query: ?payment_id=123456789

app.get("/api/verify-payment", async (req, res) => {
  try {
    const { payment_id } = req.query;

    if (!payment_id) {
      return res.status(400).json({ approved: false, error: "payment_id requerido." });
    }

    // 1. Primero buscamos en nuestra base local (ya procesado por webhook)
    if (pagosAprobados.has(String(payment_id))) {
      const pago = pagosAprobados.get(String(payment_id));
      return res.json({ approved: true, email: pago.email });
    }

    // 2. Si no está en local, consultamos directamente a MP (fallback)
    const payment = await new Payment(mpClient).get({ id: payment_id });

    if (payment.status === "approved") {
      const email = payment.metadata?.email || payment.payer?.email || "";
      pagosAprobados.set(String(payment_id), {
        paymentId: payment_id,
        email,
        status: "approved",
        date: new Date().toISOString(),
      });
      return res.json({ approved: true, email });
    }

    res.json({ approved: false, status: payment.status });

  } catch (err) {
    console.error("[MP] Error verificando pago:", err.message);
    res.status(500).json({ approved: false, error: "Error al verificar el pago." });
  }
});

// ─── START ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || process.env.PUERTO || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Backend Luján Logística corriendo en http://localhost:${PORT}`);
  console.log(`   MP Access Token: ${process.env.MP_ACCESS_TOKEN ? "✓ configurado" : "✗ FALTA"}`);
  console.log(`   Frontend URL:    ${process.env.FRONTEND_URL || "http://localhost:3000"}`);
  console.log(`   Precio ARS:      $${process.env.PRECIO_ARS || 49000}\n`);
});
