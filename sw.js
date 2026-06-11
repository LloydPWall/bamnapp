const CACHE = 'bamnapp-v50';
const ASSETS = ['./index.html', './manifest.json', './Kitchen%20Tables.png', './Terrace%20Tables.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
    .then(() => {
      // Tell all open clients to reload so they get the new version immediately
      return self.clients.matchAll({type:'window'}).then(clients => {
        clients.forEach(client => client.postMessage({type:'SW_UPDATED'}));
      });
    })
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never intercept API calls or cross-origin requests — always go to network
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (url.pathname.endsWith('.html') || url.pathname.endsWith('/')) {
    // Network-first for HTML — always get latest, fall back to cache offline
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
  } else {
    // Cache-first for static assets (images, manifest, sw itself)
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request))
    );
  }
});
