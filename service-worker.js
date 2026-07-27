const CACHE_NAME = "smashup-pickban-v4";
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./firebase-init.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Estratégia: network-first com fallback pro cache (pro app abrir mesmo offline/instável),
// mas nunca cachear chamadas ao Firestore (precisa sempre de dados frescos; usa conexões
// de streaming de longa duração, que não fazem sentido passar pelo cache HTTP) nem ao
// Apps Script (upload de foto pro Drive).
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.hostname.endsWith("googleapis.com") || url.hostname.includes("script.google.com")) return;
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
