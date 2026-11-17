// Offline app shell: everything is network-first (always fresh), with the cached copy used when offline.
const VERSION = 'wth-v13';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'remote.js', 'vendor/hls.min.js', 'icon.svg', 'icon-192.png', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // never touch video streams
  if (url.pathname.includes('/data/')) {
    e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
    return;
  }
  // app files: fresh from the network when online (updates show immediately), cached copy when offline
  e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); } return r; }).catch(() => caches.match(e.request)));
});
