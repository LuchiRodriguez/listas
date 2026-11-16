// Service worker de Listas: solo recibe avisos push y los muestra. NO cachea nada
// (sin handler de fetch): así las versiones nuevas de la app se ven siempre.

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {
    try { data = { body: event.data.text() }; } catch (e2) { data = {}; }
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'Listas';
  const options = {
    body: typeof data.body === 'string' ? data.body : '',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    data: { url: typeof data.url === 'string' ? data.url : './' },
  };
  if (typeof data.tag === 'string' && data.tag) options.tag = data.tag;
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const scope = self.registration.scope;
  let target;
  try { target = new URL((event.notification.data && event.notification.data.url) || './', scope); } catch (e) { target = new URL('./', scope); }
  // Solo URLs dentro de la app.
  if (!target.href.startsWith(scope)) target = new URL('./', scope);
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(scope)) {
        try { await w.focus(); } catch (e) { /* sigue */ }
        try { await w.navigate(target.href); return; } catch (e) { /* ventana no controlada: abrir una nueva */ }
        break;
      }
    }
    await self.clients.openWindow(target.href);
  })());
});
