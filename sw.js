// Service worker de la app instalable. Solo guarda la página y sus
// íconos para que abra aunque la red esté lenta; los datos (Apps Script,
// otro dominio) nunca se guardan: siempre piden token y van directo.
// Primero la red, así una versión nueva de la página llega en cuanto se publica;
// pero si la red tarda más de ESPERA_MS se abre la copia guardada (y la red
// la actualiza para la próxima vez).
// El dominio lalagunatp.github.io lo comparten otras apps (informeseguimiento):
// solo se tocan los caches que empiezan con "ctt-".
const CACHE = 'ctt-v3';
const ARCHIVOS = ['./', 'index.html', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
const ESPERA_MS = 2500;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.startsWith('ctt-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  const red = fetch(req).then(res => {
    if (res.ok) { const copia = res.clone(); caches.open(CACHE).then(c => c.put(req, copia)); }
    return res;
  });
  e.waitUntil(red.catch(() => {}));   // que la copia se actualice aunque ya se haya contestado
  const guardada = () => caches.match(req).then(r => r || caches.match('./'));
  e.respondWith(new Promise(resolve => {
    let listo = false;
    const dar = r => { if (!listo && r) { listo = true; resolve(r); } };
    const t = setTimeout(() => guardada().then(dar), ESPERA_MS);
    red.then(r => { clearTimeout(t); dar(r); })
      .catch(() => { clearTimeout(t); guardada().then(r => { dar(r); if (!listo) resolve(Response.error()); }); });
  }));
});
