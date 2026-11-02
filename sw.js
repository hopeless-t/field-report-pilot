const CACHE='field-report-pilot-v13';
const ASSETS=['./','index.html','style.css','app.js','manifest.webmanifest'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(Promise.all([
  caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('field-report-pilot-')&&k!==CACHE).map(k=>caches.delete(k)))),
  self.clients.claim()
])));
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  e.respondWith(fetch(e.request).then(response=>{
    const copy=response.clone();
    caches.open(CACHE).then(c=>c.put(e.request,copy));
    return response;
  }).catch(()=>caches.open(CACHE).then(c=>c.match(e.request)).then(r=>r||caches.match('./'))));
});
