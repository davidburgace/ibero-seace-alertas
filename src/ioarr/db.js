// Cliente Supabase del módulo Radar IOARR (mismas variables que server.js).
// Usa la clave secreta: salta RLS, por eso SOLO se usa en el servidor.
import { createClient } from '@supabase/supabase-js';

const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

export const supabase = process.env.SUPABASE_URL && SUPABASE_KEY
  ? createClient(process.env.SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })
  : null;
