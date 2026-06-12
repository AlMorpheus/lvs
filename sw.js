// Service Worker для веб-пушей (iOS 16.4+ в режиме «на экране Домой», Android, десктоп).
// Лежит в корне сайта, чтобы scope покрывал всё приложение (/lvs/).
// Кэширование НЕ делаем — данные всегда свежие (no-store), задача воркера только push.

self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'ЛВС · ЧМ-2026', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'ЛВС · ЧМ-2026';
  const options = {
    body: data.body || '',
    icon: data.icon || 'assets/img/favicon-192.png',
    badge: 'assets/img/favicon-192.png',
    tag: data.tag || undefined, // одинаковый tag схлопывает дубликаты
    renotify: !!data.tag,
    data: { url: data.url || './' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        // уже открыто наше приложение — фокусируем и ведём на нужный экран
        if ('focus' in c) {
          c.focus();
          if ('navigate' in c && target) c.navigate(target).catch(() => {});
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
