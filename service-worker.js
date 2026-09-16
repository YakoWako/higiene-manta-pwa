const CACHE='higiene-manta-v03-20260915';
const ASSETS=[
  './','./index.html','./app.css','./app.js','./config.js','./manifest.webmanifest',
  './icons/icon-192.png','./icons/icon-512.png',
  './data/barrios.geojson','./data/parroquias.geojson','./data/puntos.json'
];

self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()));
});

self.addEventListener('activate',event=>{
  event.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  const url=new URL(event.request.url);

  // Navegación: prioriza red para recibir actualizaciones, con respaldo offline en index.html.
  if(event.request.mode==='navigate'){
    event.respondWith(
      fetch(event.request)
        .then(response=>{const copy=response.clone();caches.open(CACHE).then(c=>c.put('./index.html',copy));return response;})
        .catch(()=>caches.match('./index.html'))
    );
    return;
  }

  // Archivos propios: cache-first para que capas y lógica funcionen sin conexión.
  if(url.origin===self.location.origin){
    event.respondWith(
      caches.match(event.request).then(cached=>cached||fetch(event.request).then(response=>{
        const copy=response.clone();caches.open(CACHE).then(c=>c.put(event.request,copy));return response;
      }))
    );
    return;
  }

  // Recursos externos (Leaflet / OpenStreetMap): se solicitan normalmente a la red.
  // No hacemos precarga masiva de teselas cartográficas.
  event.respondWith(fetch(event.request));
});
