// src/correo.js — Envío de correos de Radar (alertas, recordatorios, invitaciones).
//
// Dos formas, según las variables de entorno:
//   1. Resend por su API web (HTTPS), si hay RESEND_API_KEY. Es la recomendada: no usa los
//      puertos SMTP (que algunos planes de Render bloquean). El remitente MAIL_FROM debe ser
//      de un dominio verificado en Resend, p. ej. «Radar Ibero <radar@erpiberoperu.com>».
//   2. SMTP con nodemailer (SendGrid, Gmail, etc.), si hay SMTP_HOST: como antes.
// Sin ninguna de las dos, no se envía y se avisa (AVISO_CORREO).

import nodemailer from 'nodemailer';

export const RESEND_URL = 'https://api.resend.com/emails';
export const MAX_DESTINATARIOS = 50;   // Resend acepta hasta 50 destinatarios por correo
export const AVISO_CORREO = 'Correo no configurado: falta RESEND_API_KEY (o SMTP_HOST) en el servidor';

export const proveedorCorreo = (env = process.env) => env.RESEND_API_KEY ? 'resend' : env.SMTP_HOST ? 'smtp' : null;
export const correoConfigurado = (env = process.env) => !!proveedorCorreo(env);

// «a@x.pe, b@x.pe» o ['a@x.pe', …] → ['a@x.pe', 'b@x.pe'] (sin vacíos ni repetidos)
export function destinatarios(to) {
  const lista = (Array.isArray(to) ? to : String(to || '').split(',')).map(s => String(s).trim()).filter(Boolean);
  return [...new Set(lista)];
}

// Remitente limpio: sin espacios ni saltos de línea sobrantes, sin comillas alrededor (en Render el valor
// se guarda tal cual) y con < > aunque se hayan copiado como « » o ‹ ›
export function limpiarRemitente(v) {
  let s = String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  while (/^(["'`“”‘’]).*\1$|^[“‘].*[”’]$/.test(s) && s.length > 1) s = s.slice(1, -1).trim();
  s = s.replace(/[«‹]/g, '<').replace(/[»›]/g, '>').replace(/\s+/g, ' ');
  return s;
}
// email@dominio o Nombre <email@dominio>
export const remitenteValido = s => /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(s) || /^[^<>]*<[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>$/.test(s);

async function porResend({ to, subject, html }, env, fetchImpl) {
  const from = limpiarRemitente(env.MAIL_FROM);
  if (!from) throw new Error('Falta MAIL_FROM: el remitente de un dominio verificado en Resend (p. ej. «Radar Ibero <radar@tu-dominio.com>»)');
  if (!remitenteValido(from)) throw new Error(`MAIL_FROM no tiene el formato de remitente: se recibió ${JSON.stringify(String(env.MAIL_FROM))}. Debe ser, sin comillas: Radar Ibero <radar@tu-dominio.com>`);
  const ids = [];
  // Más de 50 destinatarios: un correo por grupo de 50
  for (let i = 0; i < to.length; i += MAX_DESTINATARIOS) {
    const r = await fetchImpl(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: to.slice(i, i + MAX_DESTINATARIOS), subject, html }),
      signal: AbortSignal.timeout(15000)
    });
    const cuerpo = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Resend rechazó el correo (${r.status}): ${cuerpo.message || cuerpo.error || r.statusText}`);
    ids.push(cuerpo.id);
  }
  return { proveedor: 'resend', messageId: ids.join(',') || null };
}

async function porSmtp({ to, subject, html }, env) {
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST, port: Number(env.SMTP_PORT || 587),
    secure: String(env.SMTP_SECURE || 'false') === 'true',
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000
  });
  const info = await transport.sendMail({ from: limpiarRemitente(env.MAIL_FROM) || env.SMTP_USER, to: to.join(','), subject, html });
  return { proveedor: 'smtp', messageId: info.messageId || null };
}

/**
 * Envía un correo. Lanza un error si no se pudo (sin configuración, rechazo o tiempo de espera).
 * @param {{ to: string|string[], subject: string, html: string }} correo
 * @returns {Promise<{ proveedor: 'resend'|'smtp', messageId: string|null }>}
 */
export async function enviarCorreo({ to, subject, html }, { env = process.env, fetchImpl = fetch } = {}) {
  const lista = destinatarios(to);
  if (!lista.length) throw new Error('El correo no tiene destinatarios');
  const p = proveedorCorreo(env);
  if (p === 'resend') return porResend({ to: lista, subject, html }, env, fetchImpl);
  if (p === 'smtp') return porSmtp({ to: lista, subject, html }, env);
  throw new Error(AVISO_CORREO);
}
