// Service worker mínimo de `hotel-staff-pwa` (ADR-002): cachea el shell de
// la app (documento raíz + manifest + favicon) para que el panel cargue e
// instale con wifi débil/intermitente. NO cachea respuestas de la API ni
// implementa sincronización offline-first (eso es REQ-REC-013, fuera de
// alcance de esta PWA — ver ADR-002 "hotel-staff-pwa: qué es y qué no es").
//
// H12b · "pantalla offline honesta": bump de versión de caché (v1 -> v2) porque el
// SHELL ahora incluye `/offline.html` -- una instalación existente con el cache v1
// nunca vería ese archivo si solo se agregara a la lista sin cambiar el nombre (el
// evento `install` de un service worker YA instalado no vuelve a correr `cache.addAll`
// sobre una versión de caché que ya existe).
const CACHE = "atiende-hoteles-shell-v2";
const SHELL = ["/", "/manifest.json", "/favicon.svg", "/offline.html"];

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
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).catch(() => {
        // Sin caché y sin red: para una NAVEGACIÓN (el usuario abriendo una pantalla),
        // la pantalla offline honesta -- nunca un error de red crudo ni datos
        // simulados. Para cualquier otro recurso (CSS/JS/imagen) no hay nada honesto
        // que servir: se deja que la petición falle tal cual.
        if (request.mode === "navigate") {
          return caches.match("/offline.html");
        }
        return undefined;
      });
    }),
  );
});
