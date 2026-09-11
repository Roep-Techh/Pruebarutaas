// push-notifications.js
// Módulo compartido por checador-logic.js, conductor-logic.js y dueno-logic.js
// para activar notificaciones push REALES (Web Push), que llegan aunque el
// panel esté cerrado y el celular bloqueado/suspendido.
//
// ⚠️ PARA QUE ESTO FUNCIONE DE VERDAD FALTAN 4 PASOS (fuera de este archivo):
//
//  1) Generar tus llaves VAPID una sola vez, desde tu compu:
//       npx web-push generate-vapid-keys
//     Te da una "Public Key" y una "Private Key".
//
//  2) Pegar la Public Key abajo en VAPID_PUBLIC_KEY.
//
//  3) Correr el archivo push_subscriptions.sql en el SQL Editor de tu
//     proyecto de Supabase (crea la tabla donde se guardan las suscripciones).
//
//  4) Desplegar la Edge Function "send-alert-push" (incluida aparte) con:
//       supabase functions deploy send-alert-push
//       supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:tucorreo@dominio.com
//     y crear un Database Webhook en Supabase (Database → Webhooks) que
//     dispare esa función cada vez que se inserte una fila en panic_alerts.
//
// Sin esos 4 pasos, el navegador pedirá permiso pero nadie estará mandando
// el push real — las alertas solo se seguirán viendo mientras el panel esté
// abierto en pantalla, como hasta ahora.

import { supabase } from './supabase-config.js';

// 🔑 Pega aquí tu VAPID PUBLIC KEY real (paso 1 y 2 de arriba)
const VAPID_PUBLIC_KEY = 'BDZ7Gye3tdi9bpq-6ynvZWdBen_HywwbOMwl2zx8Iom4zzyOyiMpvKewUsG8t-ITnS6WaUVXyT9oKG40b7KFKaA';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

/**
 * Activa las notificaciones push forzosas para este panel y guarda la
 * suscripción en Supabase para que la Edge Function le pueda mandar alertas.
 *
 * @param {'checador'|'conductor'|'dueno'} role
 * @param {string|null} refId  id del checador / conductor / dueño en sesión
 * @param {string|null} label  nombre para identificarlo (opcional, solo informativo)
 */
export async function initPushNotifications(role, refId, label) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.warn('[push] Este navegador no soporta notificaciones push reales. Las alertas solo se verán con el panel abierto.');
    return;
  }

  if (!VAPID_PUBLIC_KEY || VAPID_PUBLIC_KEY.startsWith('PEGA_AQUI')) {
    console.warn('[push] Falta configurar VAPID_PUBLIC_KEY en push-notifications.js (ver instrucciones en la parte de arriba del archivo). Las notificaciones push reales están desactivadas por ahora.');
    return;
  }

  try {
    const registration = await navigator.serviceWorker.register('./sw.js');
    await navigator.serviceWorker.ready;

    let permission = Notification.permission;
    if (permission === 'default') {
      permission = await Notification.requestPermission();
    }
    if (permission !== 'granted') {
      console.warn('[push] La persona no dio permiso de notificaciones. No podremos forzar la entrega de alertas en este dispositivo.');
      return;
    }

    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }

    await saveSubscription(subscription, role, refId, label);

    // Si el service worker renueva la suscripción sola, la volvemos a guardar
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'rss-push-resubscribed') {
        saveSubscription(event.data.subscription, role, refId, label);
      }
    });

    console.log('[push] Notificaciones push activas para', role, label || '');
  } catch (err) {
    console.error('[push] Error activando notificaciones push:', err);
  }
}

async function saveSubscription(subscription, role, refId, label) {
  const raw = typeof subscription.toJSON === 'function' ? subscription.toJSON() : subscription;
  const { error } = await supabase.from('push_subscriptions').upsert(
    {
      endpoint: raw.endpoint,
      p256dh: raw.keys.p256dh,
      auth: raw.keys.auth,
      role,
      ref_id: refId || null,
      label: label || null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'endpoint' }
  );
  if (error) console.error('[push] No se pudo guardar la suscripción en Supabase:', error);
}
