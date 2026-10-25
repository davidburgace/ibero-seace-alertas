// ============================================================================
// src/selector-ioarr/entidades-gore.js — Datos de los 25 gobiernos regionales
//
// Para precargar la ficha de bases cuando la entidad es el Gobierno Regional
// de la región del proyecto. Fuente: padrón reducido de RUC de SUNAT
// (padron_reducido_ruc.zip, actualizado el 25-10-2026): RUC, razón social, estado,
// condición y domicilio fiscal de la sede central. El distrito y la provincia salen
// del ubigeo. La ciudad es la de la sede (para la jurisdicción de la DJ del postor).
//
// No están en el padrón y no se precargan: siglas, teléfono, correos, cámara de
// comercio ni representante. El domicilio fiscal suele ser el domicilio legal,
// pero la ficha pide verificarlo.
// Para actualizar: volver a filtrar el padrón y reemplazar las filas.
// ============================================================================

export const FUENTE_GORE = 'Padrón reducido de RUC de SUNAT, 25-10-2026';

export const GOBIERNOS_REGIONALES = [
  {"region":"Amazonas","ruc":"20479569861","entidad":"Gobierno Regional de Amazonas","razon_sunat":"GOBIERNO REGIONAL AMAZONAS","estado":"ACTIVO","condicion":"HABIDO","ubigeo":"010101","domicilio":"JR. ORTIZ ARRIETA N° 1250, distrito de Chachapoyas, provincia de Chachapoyas, departamento de Amazonas","provincia":"Chachapoyas","ciudad":"Chachapoyas"},
  {"region":"Áncash","ruc":"20530689019","entidad":"Gobierno Regional de Áncash","razon_sunat":"GOBIERNO REGIONAL DE ANCASH","estado":"ACTIVO","condicion":"HABIDO","ubigeo":"020105","domicilio":"CAMPAMENTO VICHAY S/N, distrito de Independencia, provincia de Huaraz, departamento de Áncash","provincia":"Huaraz","ciudad":"Huaraz"},
  {"region":"Apurímac","ruc":"20527141762","entidad":"Gobierno Regional de Apurímac","razon_sunat":"GOBIERNO REGIONAL DE APURIMAC","estado":"ACTIVO","condicion":"HABIDO","ubigeo":"030101","domicilio":"JR. PUNO N° 107, CERCADO, distrito de Abancay, provincia de Abancay, departamento de Apurímac","provincia":"Abancay","ciudad":"Abancay"},
  {"region":"Arequipa","ruc":"20498390570","entidad":"Gobierno Regional de Arequipa","razon_sunat":"GOBIERNO REGIONAL DE AREQUIPA","estado":"ACTIVO","condicion":"HABIDO","ubigeo":"040112","domicilio":"AV. UNION N° 200, URB. CESAR VALLEJO, distrito de Paucarpata, provincia de Arequipa, departamento de Arequipa","provincia":"Arequipa","ciudad":"Arequipa"},
  {"region":"Ayacucho","ruc":"20452393493","entidad":"Gobierno Regional de Ayacucho","razon_sunat":"GOBIERNO REGIONAL AYACUCHO","estado":"ACTIVO","condicion":"HABIDO","ubigeo":"050101","domicilio":"JR. CALLAO N° 122, distrito de Ayacucho, provincia de Huamanga, departamento de Ayacucho","provincia":"Huamanga","ciudad":"Ayacucho"},
  {"region":"Cajamarca","ruc":"20453744168","entidad":"Gobierno Regional de Cajamarca","razon_sunat":"GOBIERNO REGIONAL CAJAMARCA","estado":"ACTIVO","condicion":"HABIDO","ubigeo":"060101","domicilio":"JR. SANTA TERESA DE JOURNET N° 351, URB. LA ALAMEDA, distrito de Cajamarca, provincia de Cajamarca, departamento de Cajamarca","provincia":"Cajamarca","ciudad":"Cajamarca"},
  {"region":"Callao","ruc":"20505703554","entidad":"Gobierno Regional del Callao","razon_sunat":"GOBIERNO REGIONAL DEL CALLAO","estado":"ACTIVO","condicion":"HABIDO","ubigeo":"070101","domicilio":"AV. ELMER FAUCETT N° 3970, distrito de Callao, provincia de Callao, departamento de Callao","provincia":"Callao","ciudad":"Callao"},
  {"region":"Cusco","ruc":"20527147612","entidad":"Gobierno Regional de Cusco","razon_sunat":"GOBIERNO REGIONAL CUSCO","estado":"ACTIVO","condicion":"HABIDO","ubigeo":"080108","domicilio":"AV. TOMASA TTITO CONDEMAYTA S/N, distrito de Wanchaq, provincia de Cusco, departamento de Cusco","provincia":"Cusco","ciudad":"Cusco"},
  {"region":"Huancavelica","ruc":"20486020882","entidad":"Gobierno Regional de Huancavelica","razon_sunat":"GOBIERNO REGIONAL DE HUANCAVELICA","estado":"ACTIVO","condicion":"HABIDO","ubigeo":"090101","domicilio":"JR. TORRE TAGLE N° 336, CERCADO, distrito de Huancavelica, provincia de Huancavelica, departamento de Huancavelica","provincia":"Huancavelica","ciudad":"Huancavelica"},
  {"region":"Huánuco","ruc":"20489250731","entidad":"Gobierno Regional de Huánuco","razon_sunat":"GOBIERNO REGIONAL HUANUCO","estado":"ACTIVO","condicion":"HABIDO","ubigeo":"100102","domicilio":"CAR. CENTRAL N° 145, PAUCARBAMBA, distrito de Amarilis, provincia de Huánuco, departamento de Huánuco","provincia":"Huánuco","ciudad":"Huánuco"},
  {"region":"Ica","ruc":"20452393817","entidad":"Gobierno Regional de Ica","razon_sunat":"GOBIERNO REGIONAL ICA","estado":"ACTIVO","condicion":"HABIDO","ubigeo":"110101","domicilio":"AV. CUTERVO N° 920, distrito de Ica, provincia de Ica, departamento de Ica","provincia":"Ica","ciudad":"Ica"},
  {"region":"Junín","ruc":"20486021692","entidad":"Gobierno Regional de Junín","razon_sunat":"GOBIERNO REGIONAL JUNIN","estado":"ACTIVO","condicion":"HABIDO","ubigeo":"120101","domicilio":"JR. LORETO N° 363, distrito de Huancayo, provincia de Huancayo, departamento de Junín","provincia":"Huancayo","ciudad":"Huancayo"},
  {"region":"La Libertad","ruc":"20440374248","entidad":"Gobierno Regional de La Libertad","razon_sunat":"GOBIERNO REGIONAL LA LIBERTAD","estado":"ACTIVO","condicion":"HABIDO","ubigeo":"130105","domicilio":"CAL. BAQUIJANO Y CARRILLO ALTU S/N, PARTE ALTA ESPERANZA, distrito de La Esperanza, provincia de Trujillo, departamento de La Libertad","provincia":"Trujillo","ciudad":"Trujillo"},
  {"region":"Lambayeque","ruc":"20479569780","entidad":"Gobierno Regional de Lambayeque","razon_sunat":"GOBIERNO REGIONAL LAMBAYEQUE","estado":"ACTIVO","condicion":"HABIDO","ubigeo":"140101","domicilio":"AV. JUAN TOMIS STACK Km. 4.5, distrito de Chiclayo, provincia de Chiclayo, departamento de Lambayeque","provincia":"Chiclayo","ciudad":"Chiclayo"},
  {"region":"Lima","ruc":"20530688390","entidad":"Gobierno Regional de Lima","razon_sunat":"GOBIERNO REGIONAL DE LIMA","estado":"ACTIVO","condicion":"HABIDO","ubigeo":"150810","domicilio":"AV. CIRCUNVALACIÓN SUR Km. 147, distrito de Santa María, provincia de Huaura, departamento de Lima","provincia":"Huaura","ciudad":"Huacho"},
  {"region":"Loreto","ruc":"20493196902","entidad":"Gobierno Regional de Loreto","razon_sunat":"GOBIERNO REGIONAL DE LORETO","estado":"ACTIVO","condicion":"HABIDO","ubigeo":"160112","domicilio":"AV. JOSE ABELARDO QUIÑONES Km. 1.4, distrito de Belén, provincia de Maynas, departamento de Loreto","provincia":"Maynas","ciudad":"Iquitos"},
  {"region":"Madre de Dios","ruc":"20527143200","entidad":"Gobierno Regional de Madre de Dios","razon_sunat":"GOBIERNO REGIONAL MADRE DE DIOS","estado":"ACTIVO","condicion":"HABIDO","ubigeo":"170101","domicilio":"JR. TUPAC AMARU N° 10G3, distrito de Tambopata, provincia de Tambopata, departamento de Madre de Dios","provincia":"Tambopata","ciudad":"Puerto Maldonado"},
  {"region":"Moquegua","ruc":"20519752604","entidad":"Gobierno Regional de Moquegua","razon_sunat":"GOBIERNO REGIONAL MOQUEGUA","estado":"ACTIVO","condicion":"HABIDO","ubigeo":"180101","domicilio":"MLC. MARISCAL DOMINGO NIETO S/N, SEC. EL GRAMADAL, distrito de Moquegua, provincia de Mariscal Nieto, departamento de Moquegua","provincia":"Mariscal Nieto","ciudad":"Moquegua"},
  {"region":"Pasco","ruc":"20489252270","entidad":"Gobierno Regional de Pasco","razon_sunat":"GOBIERNO REGIONAL DE PASCO","estado":"ACTIVO","condicion":"HABIDO","ubigeo":"190113","domicilio":"CAL. 5 DE OCTUBRE S/N, URB. SAN JUAN, distrito de Yanacancha, provincia de Pasco, departamento de Pasco","provincia":"Pasco","ciudad":"Cerro de Pasco"},
  {"region":"Piura","ruc":"20484004421","entidad":"Gobierno Regional de Piura","razon_sunat":"GOBIERNO REGIONAL PIURA","estado":"ACTIVO","condicion":"HABIDO","ubigeo":"200101","domicilio":"AV. SAN RAMON S/N, URB. SAN EDUARDO, distrito de Piura, provincia de Piura, departamento de Piura","provincia":"Piura","ciudad":"Piura"},
  {"region":"Puno","ruc":"20406325815","entidad":"Gobierno Regional de Puno","razon_sunat":"GOBIERNO REGIONAL PUNO","estado":"ACTIVO","condicion":"HABIDO","ubigeo":"210101","domicilio":"JR. DEUSTUA N° 356, distrito de Puno, provincia de Puno, departamento de Puno","provincia":"Puno","ciudad":"Puno"},
  {"region":"San Martín","ruc":"20531375808","entidad":"Gobierno Regional de San Martín","razon_sunat":"GOBIERNO REGIONAL SAN MARTIN","estado":"ACTIVO","condicion":"HABIDO","ubigeo":"220101","domicilio":"CAL. AEROPUERTO N° 150, distrito de Moyobamba, provincia de Moyobamba, departamento de San Martín","provincia":"Moyobamba","ciudad":"Moyobamba"},
  {"region":"Tacna","ruc":"20519752515","entidad":"Gobierno Regional de Tacna","razon_sunat":"GOBIERNO REGIONAL DE TACNA","estado":"ACTIVO","condicion":"HABIDO","ubigeo":"230101","domicilio":"AV. MANUEL A. ODRIA N° 1245, distrito de Tacna, provincia de Tacna, departamento de Tacna","provincia":"Tacna","ciudad":"Tacna"},
  {"region":"Tumbes","ruc":"20484003883","entidad":"Gobierno Regional de Tumbes","razon_sunat":"GOBIERNO REGIONAL TUMBES","estado":"ACTIVO","condicion":"HABIDO","ubigeo":"240101","domicilio":"CAL. LA MARINA N° 200, distrito de Tumbes, provincia de Tumbes, departamento de Tumbes","provincia":"Tumbes","ciudad":"Tumbes"},
  {"region":"Ucayali","ruc":"20393066386","entidad":"Gobierno Regional de Ucayali","razon_sunat":"GOBIERNO REGIONAL DE UCAYALI","estado":"ACTIVO","condicion":"HABIDO","ubigeo":"250101","domicilio":"JR. RAYMONDI N° 220, distrito de Callería, provincia de Coronel Portillo, departamento de Ucayali","provincia":"Coronel Portillo","ciudad":"Pucallpa"}
];

const POR_REGION = new Map(GOBIERNOS_REGIONALES.map(g => [g.region, g]));
/** Gobierno Regional de una región del selector (nombre como en index.json, ej. «Áncash») */
export const goreDe = region => POR_REGION.get(region) || null;
/** La entidad es un Gobierno Regional (o no se sabe todavía) */
export const esEntidadGore = entidad => !entidad || /gobierno\s+regional/i.test(entidad);
