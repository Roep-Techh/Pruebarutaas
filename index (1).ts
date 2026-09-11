// Edge Function: admin-owners
// Crea y borra dueños (fila en "owners" + usuario de Supabase Auth).
// Corre del lado del servidor porque necesita la service_role key,
// que NUNCA debe exponerse en el navegador.
//
// Seguridad: antes de hacer cualquier cosa, verifica que quien llama
// (el JWT que manda el admin-logic.js) es un owner con role = 'admin'.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace("Bearer ", "");
    if (!jwt) return json({ error: "Falta el token de autorización." }, 401);

    // Cliente admin (service role) — puede hacer lo que sea, por eso
    // primero verificamos abajo que quien llama tiene permiso.
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // ¿Quién llama? (validamos el JWT que mandó el navegador del admin)
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) {
      return json({ error: "Sesión no válida." }, 401);
    }

    // ¿Es desarrollador de verdad? (rol exclusivo de este panel, distinto
    // del "admin" de negocio que ya usan dueno.html/checador.html)
    const { data: callerOwner, error: callerErr } = await admin
      .from("owners")
      .select("role")
      .eq("id", userData.user.id)
      .single();

    if (callerErr || !callerOwner || callerOwner.role !== "developer") {
      return json({ error: "No tienes permisos de desarrollador." }, 403);
    }

    const body = await req.json();

    // ---------- CREAR DUEÑO ----------
    if (body.action === "create") {
      const { full_name, email, password, role } = body;
      if (!full_name || !email || !password) {
        return json({ error: "Faltan datos (nombre, correo o contraseña)." }, 400);
      }

      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true, // no manda correo de confirmación, queda listo para usarse
      });
      if (createErr) return json({ error: createErr.message }, 400);

      const allowedRoles = ["owner", "admin", "developer"];
      const { error: insertErr } = await admin.from("owners").insert({
        id: created.user.id,
        full_name,
        email,
        role: allowedRoles.includes(role) ? role : "owner",
      });

      if (insertErr) {
        // Si falla la fila, no dejamos huérfano el usuario de Auth
        await admin.auth.admin.deleteUser(created.user.id);
        return json({ error: insertErr.message }, 400);
      }

      return json({ ok: true, id: created.user.id });
    }

    // ---------- BORRAR DUEÑO ----------
    if (body.action === "delete") {
      const { id } = body;
      if (!id) return json({ error: "Falta el id del dueño a borrar." }, 400);

      await admin.from("owners").delete().eq("id", id);
      const { error: deleteAuthErr } = await admin.auth.admin.deleteUser(id);
      if (deleteAuthErr) {
        // La fila ya se borró; avisamos si el usuario de Auth no se pudo borrar
        return json({ ok: true, warning: "Fila borrada, pero el usuario de Auth no: " + deleteAuthErr.message });
      }

      return json({ ok: true });
    }

    return json({ error: "Acción no reconocida." }, 400);
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
