// Datos de prueba del documento equivalente: una IOARR de primaria con kit y escritorio docente
export const HOY = '2026-10-25';

export const CTX_DE = {
  nivel: 'P', nivel_nombre: 'Primaria', igv: 18,
  metas: [
    { k: 'kit', nombre: 'Kit de mobiliario (mesa + silla del estudiante)', unidad: 'Kit de mobiliario', cantidad: 120, costo: 70800 },
    { k: 'esc', nombre: 'Escritorio docente', unidad: 'Número de mobiliario', cantidad: 4, costo: 2360 }
  ],
  total_activos: 73160, total_07c: 83300.15,
  locales: [
    { cod: '398477', nombre: 'IE 43001 Prueba', direccion: 'Av. Principal s/n', dist: 'Moquegua', prov: 'Mariscal Nieto', dpto: 'MOQUEGUA', cp: 'Moquegua', rural: false, ugel: 'UGEL Mariscal Nieto' },
    { cod: '397642', nombre: 'IE 43002 Prueba', direccion: 'Jr. Lima 120', dist: 'Samegua', prov: 'Mariscal Nieto', dpto: 'MOQUEGUA', cp: 'Samegua', rural: true, ugel: 'UGEL Mariscal Nieto' }
  ],
  precio_ref: { precio: 250, n: 3, modo: 'mediana' }
};

const cot = (id, proveedor, incluye_igv, precios, extra = {}) => ({
  id, proveedor, ruc: '20123456789', fecha: '2026-10-01', vigencia_dias: 60, incluye_igv, plazo_entrega_dias: 45, precios,
  archivo_ruta: `de/prueba/${id}.pdf`, archivo_nombre: `${proveedor}.pdf`, ...extra
});
// Kit: 3 sin IGV (240, 260, 250) → promedio 250. Escritorio: 3 con IGV (354, 413, 472) → sin IGV 300, 350, 400 → promedio 350
export const COTIZACIONES_DE = [
  cot('aaaaaaaa-0000-4000-8000-000000000001', 'Proveedor Uno SAC', false, { kit: 240 }),
  cot('aaaaaaaa-0000-4000-8000-000000000002', 'Proveedor Dos SAC', false, { kit: 260 }),
  cot('aaaaaaaa-0000-4000-8000-000000000003', 'Proveedor Tres EIRL', false, { kit: 250 }),
  cot('aaaaaaaa-0000-4000-8000-000000000004', 'Muebles Cuatro SAC', true, { esc: 354 }),
  cot('aaaaaaaa-0000-4000-8000-000000000005', 'Muebles Cinco SAC', true, { esc: 413 }),
  cot('aaaaaaaa-0000-4000-8000-000000000006', 'Muebles Seis SAC', true, { esc: 472 })
];

// Ficha completa: todo lo APP y lo MANUAL lleno, PARCIALES revisados
export const FICHA_DE = {
  NOMBRE_IOARR: 'ADQUISICIÓN DE MOBILIARIO DE AULA EN 2 INSTITUCIONES EDUCATIVAS DE NIVEL PRIMARIA, DEPARTAMENTO DE PRUEBA',
  CUI: '2700001', ENTIDAD: 'Gobierno Regional de Prueba', NIVEL: 'Primaria',
  LOCALIZACION: 'Departamento de MOQUEGUA; distritos de Moquegua (Mariscal Nieto) y Samegua (Mariscal Nieto)',
  NORMAS_TECNICAS: 'RVM N° 331-2021-MINEDU; RM N° 355-2023-MINEDU', normas_verificadas: true,
  PLAZO_EJECUCION_DIAS: 60,
  BREVE_DESCRIPCION: 'Reposición de mobiliario de aula del nivel primaria en 2 instituciones educativas.',
  OBJETIVOS: 'Mejorar la calidad del servicio educativo con mobiliario adecuado.',
  CRONOGRAMA_ENTREGABLES: 'Plan de trabajo a los 3 días; versión final a los 30 días.',
  FINALIDAD_PUBLICA: 'Finalidad pública de prueba.', OBJETIVO_PRINCIPAL: 'Reponer el mobiliario en mal estado.',
  CONDICIONES_AMBIENTALES: 'Costa, 1400 m s. n. m., clima templado.', SUSTENTO_TECNICO: 'Fichas técnicas y certificados.',
  CRONOGRAMA_EJECUCION: 'Fabricación 30 días, transporte 10, entrega 20.', CRITERIOS_COSTOS: 'Promedio de cotizaciones vigentes.',
  revisados: Object.fromEntries(['BREVE_DESCRIPCION', 'OBJETIVOS', 'CRONOGRAMA_ENTREGABLES', 'FINALIDAD_PUBLICA', 'OBJETIVO_PRINCIPAL', 'CONDICIONES_AMBIENTALES', 'SUSTENTO_TECNICO', 'CRONOGRAMA_EJECUCION', 'CRITERIOS_COSTOS'].map(k => [k, true])),
  CRONOGRAMA_ACTIVIDADES: 'Semana 1: plan de trabajo (jefe de proyecto).', PLAZOS_REVISION: '5 días hábiles.',
  RESPONSABLE_ELABORACION: 'Empresa Privada de Prueba SAC – Ing. Responsable', CRONOGRAMA_CIPRL: 'Tras la conformidad.',
  CONFORMIDADES: 'Conformidad del supervisor.', POST_VENTA: 'Atención en 72 horas.', GARANTIA_COMERCIAL: '2 años.',
  FORMA_ENTREGA: 'Embalado e instalado en el aula.', VICIOS_OCULTOS: '1 año.', MODALIDAD_EJECUCION: 'Por contrata.',
  CONSIDERACIONES_TECNICAS: 'Inspección en fábrica.', EXPERIENCIA_PROVEEDORES: 'Dos ventas similares.', FORMULA_REAJUSTE: 'No aplica.',
  CONFORMIDAD_PRESTACION: 'Acta de recepción.', ANEXOS_FORMATOS: 'Formato de acta.', PUESTA_EN_FUNCIONAMIENTO: 'No requiere capacitación.',
  COSTO_SUPERVISION: 'Según la oferta de la supervisora.',
  MONTO_CONVENIO_EJECUCION: 72000, MONTO_DOC_EQUIVALENTE: 2287.5, MONTO_SUPERVISION: 4500,
  GG_PCT: 0, UTILIDAD_PCT: 0,
  cantidades: { kit: 120, esc: 4 },
  cotizaciones: COTIZACIONES_DE,
  bases_origen: 'Bases del Proceso de Selección N° 001-2026-CE-PRUEBA, Anexo 3-A', N_PROCESO: '001-2026-CE-PRUEBA'
};
