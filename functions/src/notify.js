// Outbound messages: email over SMTP and WhatsApp Cloud API templates.
const nodemailer = require('nodemailer');

const env = process.env;
const GRAPH = `https://graph.facebook.com/${env.META_GRAPH_VERSION || 'v21.0'}`;

const emailEnabled = () => Boolean(env.SMTP_HOST);
const whatsappEnabled = () => Boolean(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID);

let transporter;
function smtp() {
  transporter ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT || 587),
    secure: env.SMTP_SECURE === 'true',
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });
  return transporter;
}

async function sendEmail({ to, subject, text, html, unsubscribeUrl }) {
  if (!emailEnabled()) throw new Error('Email is not configured');
  const from = env.MAIL_FROM || env.SMTP_USER;
  await smtp().sendMail({
    from: env.BRAND_NAME ? `"${env.BRAND_NAME}" <${from}>` : from,
    to,
    subject,
    text,
    html,
    headers: unsubscribeUrl ? { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : undefined,
  });
}

// WhatsApp only lets businesses start a conversation with a pre-approved template.
// `params` fill the template's {{1}}, {{2}}… body placeholders in order.
async function sendWhatsAppTemplate({ to, template, params = [], language = env.WHATSAPP_TEMPLATE_LANG || 'en' }) {
  if (!whatsappEnabled()) throw new Error('WhatsApp is not configured');
  const components = params.length ? [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: String(p) })) }] : [];
  const r = await fetch(`${GRAPH}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template: { name: template, language: { code: language }, components } }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error?.message || `HTTP ${r.status}`);
}

// Authentication templates put the code in the body and (usually) a copy-code button.
async function sendWhatsAppCode(to, code) {
  if (!whatsappEnabled() || !env.WHATSAPP_OTP_TEMPLATE) throw new Error('WhatsApp login codes are not configured');
  const r = await fetch(`${GRAPH}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: env.WHATSAPP_OTP_TEMPLATE,
        language: { code: env.WHATSAPP_TEMPLATE_LANG || 'en' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: code }] },
          { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
        ],
      },
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error?.message || `HTTP ${r.status}`);
}

module.exports = { emailEnabled, whatsappEnabled, sendEmail, sendWhatsAppTemplate, sendWhatsAppCode };
