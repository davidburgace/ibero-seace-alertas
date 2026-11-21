// src/correo.js — envío por Resend (API web) o SMTP, según las variables de entorno
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enviarCorreo, proveedorCorreo, correoConfigurado, destinatarios, limpiarRemitente, remitenteValido, RESEND_URL, MAX_DESTINATARIOS, AVISO_CORREO } from '../src/correo.js';

const RESEND = { RESEND_API_KEY: 're_prueba', MAIL_FROM: 'Radar Ibero <radar@erpiberoperu.com>' };
function fetchFalso(respuestas = []) {
  const llamadas = [];
  const f = async (url, o) => { llamadas.push({ url, ...o, body: JSON.parse(o.body) }); const r = respuestas[llamadas.length - 1] || { status: 200, json: { id: 'msg_' + llamadas.length } };
    return { ok: r.status < 300, status: r.status, statusText: '', json: async () => r.json }; };
  f.llamadas = llamadas;
  return f;
}

test('proveedor: Resend si hay RESEND_API_KEY (aunque haya SMTP); si no, SMTP; si no, ninguno', () => {
  assert.equal(proveedorCorreo({ RESEND_API_KEY: 'x', SMTP_HOST: 'smtp.sendgrid.net' }), 'resend');
  assert.equal(proveedorCorreo({ SMTP_HOST: 'smtp.sendgrid.net' }), 'smtp');
  assert.equal(proveedorCorreo({}), null);
  assert.equal(correoConfigurado({}), false);
});

test('destinatarios: texto con comas o lista, sin vacíos ni repetidos', () => {
  assert.deepEqual(destinatarios('a@x.pe, b@x.pe,,a@x.pe '), ['a@x.pe', 'b@x.pe']);
  assert.deepEqual(destinatarios(['a@x.pe', ' ', 'c@x.pe']), ['a@x.pe', 'c@x.pe']);
  assert.deepEqual(destinatarios(null), []);
});

test('Resend: POST a la API con la clave, el remitente, los destinatarios, el asunto y el HTML', async () => {
  const f = fetchFalso();
  const r = await enviarCorreo({ to: 'a@x.pe,b@x.pe', subject: 'Hola', html: '<p>Hola</p>' }, { env: RESEND, fetchImpl: f });
  assert.deepEqual(r, { proveedor: 'resend', messageId: 'msg_1' });
  const [l] = f.llamadas;
  assert.equal(l.url, RESEND_URL); assert.equal(l.method, 'POST');
  assert.equal(l.headers.Authorization, 'Bearer re_prueba');
  assert.deepEqual(l.body, { from: RESEND.MAIL_FROM, to: ['a@x.pe', 'b@x.pe'], subject: 'Hola', html: '<p>Hola</p>' });
});

test('Resend: más de 50 destinatarios van en varios correos', async () => {
  const f = fetchFalso(), to = Array.from({ length: MAX_DESTINATARIOS + 5 }, (_, i) => `v${i}@x.pe`);
  const r = await enviarCorreo({ to, subject: 'S', html: 'h' }, { env: RESEND, fetchImpl: f });
  assert.deepEqual(f.llamadas.map(l => l.body.to.length), [50, 5]);
  assert.equal(r.messageId, 'msg_1,msg_2');
});

test('Resend: sin MAIL_FROM, rechazo de la API o sin destinatarios dan un error claro', async () => {
  await assert.rejects(enviarCorreo({ to: 'a@x.pe', subject: 'S', html: 'h' }, { env: { RESEND_API_KEY: 'x' }, fetchImpl: fetchFalso() }), /Falta MAIL_FROM/);
  const f = fetchFalso([{ status: 403, json: { message: 'The erpiberoperu.com domain is not verified' } }]);
  await assert.rejects(enviarCorreo({ to: 'a@x.pe', subject: 'S', html: 'h' }, { env: RESEND, fetchImpl: f }), /Resend rechazó el correo \(403\): The erpiberoperu\.com domain is not verified/);
  await assert.rejects(enviarCorreo({ to: '', subject: 'S', html: 'h' }, { env: RESEND, fetchImpl: fetchFalso() }), /no tiene destinatarios/);
});

test('sin configuración: no envía y avisa', async () => {
  await assert.rejects(enviarCorreo({ to: 'a@x.pe', subject: 'S', html: 'h' }, { env: {}, fetchImpl: fetchFalso() }), new RegExp(AVISO_CORREO.slice(0, 20)));
});

test('remitente: quita comillas, espacios y saltos de línea; « » pasan a < >', () => {
  const ok = 'Radar Ibero <radar@erpiberoperu.com>';
  for (const v of [ok, `"${ok}"`, `'${ok}'`, ` ${ok}\n`, '“Radar Ibero <radar@erpiberoperu.com>”', 'Radar Ibero «radar@erpiberoperu.com»', `"  ${ok} "`])
    assert.equal(limpiarRemitente(v), ok, JSON.stringify(v));
  assert.equal(limpiarRemitente('"radar@erpiberoperu.com"'), 'radar@erpiberoperu.com');
  for (const v of [ok, 'radar@erpiberoperu.com']) assert.ok(remitenteValido(v), v);
  for (const v of ['Radar Ibero', 'Radar Ibero radar@erpiberoperu.com', '<radar@erpiberoperu>', 'Radar <a b@x.pe>']) assert.equal(remitenteValido(v), false, v);
});

test('Resend: el remitente con comillas se limpia; uno sin formato da un error que muestra lo recibido', async () => {
  const f = fetchFalso();
  await enviarCorreo({ to: 'a@x.pe', subject: 'S', html: 'h' }, { env: { ...RESEND, MAIL_FROM: '"Radar Ibero <radar@erpiberoperu.com>"' }, fetchImpl: f });
  assert.equal(f.llamadas[0].body.from, 'Radar Ibero <radar@erpiberoperu.com>');
  await assert.rejects(enviarCorreo({ to: 'a@x.pe', subject: 'S', html: 'h' }, { env: { ...RESEND, MAIL_FROM: 'Radar Ibero' }, fetchImpl: fetchFalso() }),
    /MAIL_FROM no tiene el formato de remitente: se recibió "Radar Ibero"/);
});
