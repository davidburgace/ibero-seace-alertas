-- ============================================================================
-- Seguimiento Comercial — solo los usuarios con rol proveedor
-- Ejecutar después de 009 (idempotente).
--
-- Antes: reuniones, procesos_seguimiento, visitas_comerciales y
-- contactos_frecuentes tenían la política «acceso_total» (rol public, using
-- true). Con la clave pública, que está en el navegador, cualquiera podía
-- leerlas, cambiarlas y borrarlas.
-- Ahora: solo un usuario con sesión y rol proveedor en `perfiles`. El servidor
-- usa la clave secreta, que salta RLS, así que los cron y Admin no cambian.
--
-- También quita «Allow insert demo» de opportunities: dejaba que cualquiera
-- insertara oportunidades con la clave pública. Las inserta solo el servidor.
-- ============================================================================

-- ¿El usuario de esta petición es proveedor? security definer porque perfiles
-- tiene RLS sin políticas (el navegador no la puede leer).
create or replace function public.es_proveedor()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.perfiles where id = auth.uid() and rol = 'proveedor');
$$;
revoke all on function public.es_proveedor() from public, anon;
grant execute on function public.es_proveedor() to authenticated;

do $$
declare t text;
begin
  foreach t in array array['reuniones', 'procesos_seguimiento', 'visitas_comerciales', 'contactos_frecuentes'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists acceso_total on public.%I', t);
    execute format('drop policy if exists solo_proveedores on public.%I', t);
    execute format(
      'create policy solo_proveedores on public.%I for all to authenticated
         using (public.es_proveedor()) with check (public.es_proveedor())', t);
    -- Sin sesión no hay nada que hacer con estas tablas
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

drop policy if exists "Allow insert demo" on public.opportunities;
