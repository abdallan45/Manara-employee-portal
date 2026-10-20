// App-shell cache. API calls are never cached: attendance must always hit the server.
const CACHE = 'attendance-shell-v4';
const SHELL = ['/', '/index.html', '/style.css', '/admin.js', '/employees.js', '/app.js', '/manifest.webmanifest', '/icon.svg', '/fonts/orbitron-latin-wght-normal.woff2', '/fonts/montserrat-latin-wght-normal.woff2', '/fonts/ibm-plex-sans-arabic-arabic-400-normal.woff2', '/fonts/ibm-plex-sans-arabic-arabic-600-normal.woff2', '/fonts/ibm-plex-sans-arabic-arabic-700-normal.woff2'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Network first so updates show immediately; fall back to cache when offline.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/index.html')))
  );
});
