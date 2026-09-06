import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@atiende/ui/styles.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// hotel-staff-pwa (ADR-002): registra el service worker del shell cacheado.
// No implementa sincronización de datos offline — ver public/sw.js.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Registro best-effort: si falla (ej. entorno de pruebas sin HTTPS),
      // la app sigue funcionando normalmente, solo sin instalación offline.
    });
  });
}
