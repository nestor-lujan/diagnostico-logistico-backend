const { Resend } = require("resend");

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const FROM_EMAIL = process.env.EMAIL_FROM || "diagnostico@lujanlogistica.com";
const ADMIN_EMAIL = process.env.EMAIL_ADMIN || "nestor@lujanlogistica.com";
const FRONTEND_URL = process.env.FRONTEND_URL || "https://diagnostico.lujanlogistica.com";

async function sendConfirmacionComprador({ email, empresa }) {
  if (!resend) { console.log("[Email] Sin Resend, omitiendo."); return { ok: true }; }
  try {
    const { data, error } = await resend.emails.send({
      from: "Lujan Logistica <" + FROM_EMAIL + ">",
      to: [email],
      subject: "Compra confirmada - Diagnostico Logistico",
      html: "<p>Gracias por tu compra. Accede en: " + FRONTEND_URL + "</p>",
    });
    if (error) throw new Error(error.message);
    console.log("[Email] Confirmacion enviada a " + email);
    return { ok: true };
  } catch (err) {
    console.error("[Email] Error:", err.message);
    return { ok: false };
  }
}

async function sendNotificacionAdmin({ email, empresa, paymentId, amount }) {
  if (!resend) { console.log("[Email] Sin Resend, omitiendo."); return { ok: true }; }
  try {
    const { data, error } = await resend.emails.send({
      from: "Sistema <" + FROM_EMAIL + ">",
      to: [ADMIN_EMAIL],
      subject: "Nueva venta - " + email,
      html: "<p>Nueva venta de " + email + " - Empresa: " + empresa + " - Pago: " + paymentId + " - Monto: $" + amount + "</p>",
    });
    if (error) throw new Error(error.message);
    console.log("[Email] Notificacion admin enviada");
    return { ok: true };
  } catch (err) {
    console.error("[Email] Error:", err.message);
    return { ok: false };
  }
}

module.exports = { sendConfirmacionComprador, sendNotificacionAdmin };