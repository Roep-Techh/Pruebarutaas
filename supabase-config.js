/* ============================================================
   CONFIGURACIÓN DE SUPABASE — Ruta San Simón (R-18)
   ============================================================
   NOTA: por ahora este archivo apunta al proyecto de Supabase de
   PRUEBAS (el mismo que usa Pruebasroep), a propósito, mientras se
   valida en producción la nueva funcionalidad de walkie-talkie y
   horarios de checador. Cuando esté todo probado, hay que regresar
   supabaseUrl / supabaseAnonKey a las del proyecto de producción. */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const supabaseUrl = 'https://exjjjcyepsrzzampbmut.supabase.co';
const supabaseAnonKey = 'sb_publishable_kJqa_WI3YTfvmcYpJneC7w_W85qrx_w';

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  }
});
