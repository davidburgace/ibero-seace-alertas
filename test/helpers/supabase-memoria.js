// Supabase en memoria para probar las rutas del Selector IOARR sin red (solo pruebas).
// Cubre lo que usan esas rutas: select (con relaciones «alias:tabla(...)» y «(count)»),
// insert, upsert (onConflict), update, delete, eq, neq, in, not(col, 'is', null),
// order, range, limit, maybeSingle, single, y storage (download / remove / upload).

export function supabaseMemoria(tablas = {}) {
  const tabla = t => (tablas[t] ??= []);
  const clonar = x => JSON.parse(JSON.stringify(x));
  let ids = 0;

  function consulta(t) {
    const filtros = [], orden = [];
    let op = 'select', valores = null, conflicto = null, columnas = '*', rango = null, limite = null, uno = null, contar = false, devolver = false;
    const coincide = f => filtros.every(fn => fn(f));
    // Relaciones del select: alias:tabla(cols) → null; alias:tabla(count) → [{ count }]
    const relaciones = () => [...String(columnas).matchAll(/(\w+):(\w+)\(([^)]*)\)/g)].map(m => ({ alias: m[1], tabla: m[2], count: m[3].trim() === 'count' }));
    const conRelaciones = f => {
      const out = { ...f };
      for (const r of relaciones()) out[r.alias] = r.count ? [{ count: tabla(r.tabla).filter(x => x.proyecto_id === f.id).length }] : null;
      return out;
    };
    const ejecutar = () => {
      const filas = tabla(t);
      let afectadas = [];
      if (op === 'insert' || op === 'upsert') {
        const nuevas = (Array.isArray(valores) ? valores : [valores]).map(v => ({ ...v }));
        const claves = conflicto ? conflicto.split(',').map(s => s.trim()) : null;
        for (const v of nuevas) {
          const previa = claves ? filas.find(f => claves.every(k => f[k] === v[k])) : null;
          if (previa && op === 'upsert') { Object.assign(previa, v); afectadas.push(previa); }
          else if (previa) { /* ignoreDuplicates */ }
          else { const f = { id: v.id ?? `id-${t}-${++ids}`, creado_en: new Date().toISOString(), ...v }; filas.push(f); afectadas.push(f); }
        }
      } else if (op === 'update') { afectadas = filas.filter(coincide); afectadas.forEach(f => Object.assign(f, valores)); }
      else if (op === 'delete') { afectadas = filas.filter(coincide); tablas[t] = filas.filter(f => !afectadas.includes(f)); }
      else afectadas = filas.filter(coincide);
      if (op !== 'select' && !devolver) return { data: null, error: null };
      let out = afectadas.map(f => conRelaciones(clonar(f)));
      for (const [c, asc] of [...orden].reverse()) out.sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (asc ? 1 : -1));
      if (rango) out = out.slice(rango[0], rango[1] + 1);
      if (limite != null) out = out.slice(0, limite);
      if (contar) return { data: null, count: out.length, error: null };
      if (uno === 'maybe') return { data: out[0] ?? null, error: null };
      if (uno === 'single') return out.length ? { data: out[0], error: null } : { data: null, error: { message: 'No rows', code: 'PGRST116' } };
      return { data: out, error: null };
    };
    const q = {
      select(cols = '*', opts = {}) { columnas = cols; if (op !== 'select') devolver = true; if (opts.count) contar = true; return q; },
      insert(v) { op = 'insert'; valores = v; return q; },
      upsert(v, o = {}) { op = 'upsert'; valores = v; conflicto = o.onConflict || null; if (o.ignoreDuplicates) op = 'insert'; return q; },
      update(v) { op = 'update'; valores = v; return q; },
      delete() { op = 'delete'; return q; },
      eq(c, v) { filtros.push(f => f[c] === v); return q; },
      neq(c, v) { filtros.push(f => f[c] !== v); return q; },
      in(c, vs) { filtros.push(f => vs.includes(f[c])); return q; },
      not(c, o, v) { filtros.push(f => o === 'is' && v === null ? f[c] != null : f[c] !== v); return q; },
      or() { return q; },
      ilike() { return q; },
      order(c, o = {}) { orden.push([c, o.ascending !== false]); return q; },
      range(a, b) { rango = [a, b]; return q; },
      limit(n) { limite = n; return q; },
      maybeSingle() { uno = 'maybe'; return q; },
      single() { uno = 'single'; return q; },
      then(ok, ko) { return Promise.resolve().then(ejecutar).then(ok, ko); }
    };
    return q;
  }

  const bucket = new Map();
  return {
    tablas, bucket,
    from: consulta,
    storage: {
      from: () => ({
        upload: async (ruta, buf) => { bucket.set(ruta, Buffer.from(buf)); return { data: { path: ruta }, error: null }; },
        download: async ruta => bucket.has(ruta) ? { data: new Blob([bucket.get(ruta)]), error: null } : { data: null, error: { message: 'no existe' } },
        remove: async rutas => { rutas.forEach(r => bucket.delete(r)); return { data: null, error: null }; },
        createSignedUrl: async ruta => ({ data: { signedUrl: 'https://ejemplo.invalid/' + ruta }, error: null })
      })
    }
  };
}
