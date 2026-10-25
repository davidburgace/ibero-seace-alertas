// Ficha de bases completa con datos de prueba (ficticios) para el generador de bases OxI.
// Nombres y números inventados: no corresponden a una entidad ni a un proceso reales.
export const CTX_PRUEBA = {
  nivel: 'P', nivel_nombre: 'Primaria', region: 'Moquegua',
  escenario_texto: 'Escenario de cantidad: Solo Malo (mobiliario en estado malo del Censo Educativo 2025).', kit: true,
  metas: [
    { k: 'kit', nombre: 'Kit de mobiliario (mesa + silla del estudiante)', unidad: 'Número de mobiliario', cantidad: 120, costo: 72000 },
    { k: 'esc', nombre: 'Escritorio docente', unidad: 'Número de mobiliario', cantidad: 6, costo: 4200 }
  ],
  total_07c: 99000, liquidacion: 15000, control: 0, colegios: 3, ugels: ['UGEL Prueba'], borrador: false
};

export const FICHA_PRUEBA = {
  N_PROCESO: '001-2026-CE-PRUEBA', SIGLAS_ENTIDAD: 'GRP', reglamento: 'DS 038-2026-EF',
  VERIFICAR_REGLAMENTO_VIGENTE: true, VERIFICAR_VIGENCIA: false,
  NORMAS_ADICIONALES: 'Ley N° 28044, Ley General de Educación.',
  ENTIDAD: 'Gobierno Regional de Prueba', ENTIDAD_RUC: '20123456789', ENTIDAD_DOMICILIO: 'Av. Ejemplo 123, Ciudad Prueba',
  ENTIDAD_TELEFONO: '(01) 555-0000', ENTIDAD_CORREO_COMITE: 'comite@prueba.invalid', ENTIDAD_CORREOS_CIPRL: 'ciprl@prueba.invalid',
  ENTIDAD_DOMICILIO_CIPRL: 'Av. Ejemplo 123, oficina 2', PEI_ENTIDAD: 'PEI 2024-2028 del Gobierno Regional de Prueba', PMI_PERIODO: '2027-2029',
  PROVINCIA_NOTIFICACION: 'Prueba', CIUDAD_JURISDICCION: 'Ciudad Prueba', CAMARA_COMERCIO: 'Cámara de Comercio de Prueba',
  NOMBRE_REPRESENTANTE: 'Persona de Prueba', DNI_REPRESENTANTE: '12345678', CARGO_REPRESENTANTE: 'Gobernador Regional',
  SUSTENTO_FACULTADES: 'Credencial del Jurado Electoral de Prueba',
  NOMBRE_IOARR: 'ADQUISICIÓN DE MOBILIARIO DE AULA EN 3 INSTITUCIONES EDUCATIVAS DE NIVEL PRIMARIA, DEPARTAMENTO DE PRUEBA', CUI: '2700001',
  COMPONENTE: 'Equipamiento', UF_NOMBRE: 'Unidad Formuladora de Prueba', FECHA_07C: '2026-06-15',
  ACTO_PRIORIZACION: 'Acuerdo Regional N° 010-2026-CR', FECHA_PRIORIZACION: '2026-07-01',
  RESOLUCION_COMITE: 'Resolución Ejecutiva Regional N° 100-2026', FECHA_RESOLUCION_COMITE: '2026-07-10', AUTORIDAD_DESIGNA_COMITE: 'el Gobernador Regional',
  OFICIO_CGR: '000123-2026-CG', FECHA_OFICIO_CGR: '2026-08-01', INFORME_PREVIO_CGR: '000045-2026-CG/PRUEBA',
  RESOLUCION_BASES: 'Resolución Gerencial N° 050-2026', FECHA_BASES: '2026-08-20',
  nueva_convocatoria: false,
  MONTO_DOC_EQUIVALENTE: 2287.5, MONTO_EJECUCION: 76200, MONTO_SUP_DOC_EQUIVALENTE: 1000.25, MONTO_SUP_EJECUCION: 3812.4,
  PLAZO_DOC_EQUIVALENTE_DIAS: 30, PLAZO_EJECUCION_DIAS: 60, propuesta_min_pct: 90, propuesta_max_pct: 110,
  DIRECCION_COMITE: 'Av. Ejemplo 123, mesa de partes', HORARIO_RECEPCION: 'lunes a viernes de 8:00 a 13:00',
  FECHA_CONVOCATORIA: '2026-09-01', FECHA_EXPRESION_INICIO: '2026-09-02', FECHA_EXPRESION_FIN: '2026-09-08',
  FECHA_CONSULTAS_INICIO: '2026-09-02', FECHA_CONSULTAS_FIN: '2026-09-08', FECHA_ABSOLUCION_INICIO: '2026-09-09', FECHA_ABSOLUCION_FIN: '2026-09-11',
  FECHA_INTEGRACION: '2026-09-14', FECHA_PROPUESTAS: '2026-09-17', FECHA_EVALUACION_INICIO: '2026-09-18', FECHA_EVALUACION_FIN: '2026-09-22',
  FECHA_BUENA_PRO: '2026-09-23', FECHA_CONSENTIMIENTO: '2026-09-24', FECHA_CONVENIO: '2026-10-22',
  metodo_cantidades: 'app', normas_tecnicas: 'RVM N° 331-2021-MINEDU; RM N° 355-2023-MINEDU', normas_verificadas: true,
  _precarga: { MONTO_EJECUCION: 76200, COMPONENTE: 'Equipamiento' },
  _precarga_notas: { MONTO_EJECUCION: 'Costo directo con IGV (activos) de la estructura de costos.', COMPONENTE: 'Supuesto: la reposición de mobiliario es del componente Equipamiento.' }
};
