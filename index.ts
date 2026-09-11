// supabase/functions/send-alert-push/index.ts
//
// Esta función se dispara sola cuando se inserta una fila nueva en
// panic_alerts (el botón de pánico del conductor). Le manda una notificación
// push REAL a todos los checadores y dueños suscritos, para que les llegue
// como notificación del sistema operativo aunque tengan el panel cerrado o
// el celular bloqueado/suspendido.
//
// CÓMO DESPLEGARLA (desde tu compu, con la Supabase CLI instalada):
//
//   1) supabase functions deploy send-alert-push
//
//   2) supabase secrets set \
//        VAPID_PUBLIC_KEY=tu_public_key \
//        VAPID_PRIVATE_KEY=tu_private_key \
//        VAPID_SUBJECT=mailto:tucorreo@dominio.com
//
//   3) En el Dashboard de Supabase → Database → Webhooks → Create a new hook:
//        - Tabla: panic_alerts
//        - Evento: INSERT
//        - Tipo: Edge Function
//        - Función: send-alert-push
//
// A partir de ahí, cada vez que un conductor presione el botón de pánico,
// esta función se ejecuta sola y manda el push a checadores y dueños.

import webpush from 'npm:web-push@3.6.7';

const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!;
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:soporte@example.com';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

Deno.serve(async (req) => {
  try {
    const payload = await req.json();
    // Los Database Webhooks de Supabase mandan la fila nueva en payload.record
    const alert = payload.record;
    if (!alert) return new Response('Sin registro en el payload', { status: 400 });

    const restHeaders = {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    };

    // Nombre del conductor, para que la notificación diga quién mandó la alerta
    let driverName = 'Un conductor';
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/drivers?id=eq.${alert.driver_id}&select=name`, {
        headers: restHeaders,
      });
      const rows = await r.json();
      if (rows?.[0]?.name) driverName = rows[0].name;
    } catch (_) {
      // si falla, seguimos con el nombre genérico
    }

    // Todos los checadores y dueños suscritos a push
    const subsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/push_subscriptions?role=in.(checador,dueno)&select=*`,
      { headers: restHeaders }
    );
    const subs = await subsRes.json();

    const notifPayload = JSON.stringify({
      title: '🚨 Alerta de pánico',
      body: `${driverName} activó el botón de pánico. Toca para ver su ubicación.`,
      tag: `panic-${alert.id}`,
      url: 'dueno.html',
      vibrate: [300, 100, 300, 100, 300, 100, 600],
    });

    const results = await Promise.allSettled(
      (subs || []).map(async (s: { endpoint: string; p256dh: string; auth: string }) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            notifPayload
          );
        } catch (err: any) {
          // Suscripción vencida/inválida (410/404) -> la borramos para no reintentar en vano
          if (err?.statusCode === 410 || err?.statusCode === 404) {
            await fetch(
              `${SUPABASE_URL}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(s.endpoint)}`,
              { method: 'DELETE', headers: restHeaders }
            );
          }
          throw err;
        }
      })
    );

    const sent = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.length - sent;

    return new Response(JSON.stringify({ sent, failed, total: results.length }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[send-alert-push] error:', err);
    return new Response(String(err), { status: 500 });
  }
});
