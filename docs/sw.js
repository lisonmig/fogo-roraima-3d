// Fogo em Roraima 3D – modo sem internet.
// Página e dados: primeiro a rede (sempre o mais novo); sem internet, a última cópia guardada.
// Arquivos que quase não mudam (biblioteca 3D, letras, ícones, relevo, imagem): primeiro a cópia guardada.
// Outros sites (imagem nítida da EOX, previsão do tempo) não passam por aqui.
const CACHE = 'fogo-rr-v1';
const SHELL = ['./', 'index.html', 'termos.html', 'sobre.html', 'fonts.css', 'vendor/three.min.js', 'vendor/OrbitControls.js', 'manifest.webmanifest', 'icone-192.png', 'icone.svg', 'favicon.ico'];
const STATIC = /\.(js|css|woff2|png|webp|jpg|svg|ico|webmanifest)$/;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  const isStatic = STATIC.test(url.pathname) && !url.pathname.endsWith('sw.js');
  if (isStatic) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => { if (res.ok) caches.open(CACHE).then(c => c.put(req, res.clone())); return res; })));
    return;
  }
  // page and data (.json): network first, cached copy when offline
  e.respondWith(fetch(req).then(res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return res; })
    .catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || caches.match('index.html'))));
});
