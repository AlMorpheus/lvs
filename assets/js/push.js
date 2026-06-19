// Веб-пуши: подписка/отписка на стороне клиента. Подписку шифруем тем же конвертом, что и
// ставки (encryptBet → wrapAction), и кладём в data/push-subs/<userId>.json. Бот в Action
// расшифровывает её своим ACTION_PRIVATE_KEY и шлёт уведомления через VAPID при смене состава.
//
// iOS: Web Push работает ТОЛЬКО когда сайт добавлен на экран «Домой» (standalone), iOS 16.4+.
import { encryptBet } from './crypto.js?v=63';
import { putFile, deleteFile } from './github.js?v=63';

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isStandalone() {
  return window.navigator.standalone === true || !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
}

// VAPID-ключ приходит как base64url-строка, а pushManager.subscribe ждёт Uint8Array.
function urlB64ToUint8(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

const SW_URL = 'sw.js'; // относительно базового пути приложения (scope = /lvs/)

/** Зарегистрировать сервис-воркер заранее (без запроса разрешений). */
export async function registerSW() {
  if (!pushSupported()) return null;
  try {
    return await navigator.serviceWorker.register(SW_URL);
  } catch (e) {
    console.warn('SW register:', e);
    return null;
  }
}

/** Текущее состояние: 'unsupported' | 'needs-standalone' | 'denied' | 'off' | 'on'. */
export async function pushState() {
  // на iOS в обычной вкладке Push API нет вовсе — сначала зовём добавить на «Домой»
  if (isIOS() && !isStandalone()) return 'needs-standalone';
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && (await reg.pushManager.getSubscription());
    return sub ? 'on' : 'off';
  } catch {
    return 'off';
  }
}

/** Включить уведомления: разрешение → подписка → зашифрованный коммит в репо. */
export async function enablePush(session, app) {
  if (!pushSupported()) throw new Error('unsupported');
  if (isIOS() && !isStandalone()) throw new Error('needs-standalone');
  const key = app.push?.vapidPublicKey;
  if (!key) throw new Error('no-vapid');

  const reg = (await navigator.serviceWorker.getRegistration()) || (await registerSW());
  await navigator.serviceWorker.ready;

  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('denied');

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(key) });
  }

  await saveSub(session, app, sub, 'push-sub');
}

const LAST_EP = 'lvs.push.endpoint'; // последний сохранённый endpoint — чтобы не коммитить зря

async function saveSub(session, app, sub, msgPrefix) {
  const payload = { sub: sub.toJSON(), name: session.name, savedAt: new Date().toISOString() };
  const file = encryptBet(payload, session.userKey, app.actionPublicKey);
  await putFile(app.repo, `data/push-subs/${session.userId}.json`, JSON.stringify(file, null, 2), `${msgPrefix}: ${session.userId}`, session.token);
  try { localStorage.setItem(LAST_EP, sub.endpoint); } catch {}
}

/**
 * Поддержание подписки в актуальном состоянии. Вызывается при каждом запуске приложения.
 * iOS периодически меняет push-подписку (ротация): старый endpoint ещё отвечает 201, но
 * доставка прекращается. Поэтому сверяем текущую подписку с сохранённой и, если изменилась
 * (или пропала — пере-подписываемся), перезаписываем файл в репо. Без изменений — ничего не шлём.
 */
export async function refreshSubscription(session, app) {
  if (!pushSupported() || (isIOS() && !isStandalone())) return;
  if (Notification.permission !== 'granted') return; // не подписан/запрещён — не трогаем
  try {
    const reg = (await navigator.serviceWorker.getRegistration()) || (await registerSW());
    if (!reg) return;
    await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const key = app.push?.vapidPublicKey;
      if (!key) return;
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(key) });
    }
    let last = null;
    try { last = localStorage.getItem(LAST_EP); } catch {}
    if (sub.endpoint === last) return; // не изменилось — лишний коммит не нужен
    await saveSub(session, app, sub, 'push-sub refresh');
    console.info('push: подписка обновлена');
  } catch (e) {
    console.warn('refreshSubscription:', e);
  }
}

/** Выключить уведомления: локальная отписка + удаление файла из репо. */
export async function disablePush(session, app) {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && (await reg.pushManager.getSubscription());
    if (sub) await sub.unsubscribe();
  } catch (e) {
    console.warn('unsubscribe:', e);
  }
  try {
    await deleteFile(app.repo, `data/push-subs/${session.userId}.json`, `push-sub off: ${session.userId}`, session.token);
  } catch (e) {
    console.warn('delete sub file:', e);
  }
}
