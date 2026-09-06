// Service worker mínimo de `hotel-staff-pwa` (ADR-002): cachea el shell de
// la app (documento raíz + manifest + favicon) para que el panel cargue e
// instale con wifi débil/intermitente. NO cachea respuestas de la API ni
// implementa sincronización offline-first (eso es REQ-REC-013, fuera de
// alcance de esta PWA — ver ADR-002 "hotel-staff-pwa: qué es y qué no es").
const CACHE = "atiende-hoteles-shell-v1";
const SHELL = ["/", "/manifest.json", "/favicon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).catch(() => undefined),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  // Nunca interceptar llamadas a la API: sin backend disponible, deben
  // fallar de forma honesta (EstadoError), no servir una respuesta cacheada
  // que finja ser un dato real.
  if (request.method !== "GET" || new URL(request.url).pathname.startsWith("/api")) {
    return;
  }
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).catch(() => cached)),
  );
});
