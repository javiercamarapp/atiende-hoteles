// H12b · PWA "pantalla offline honesta": apps/web/public/offline.html declara su propia
// CSP con un hash sha256 del <style> inline (sin `unsafe-inline`, ver LAUNCH-021 "sin
// unsafe-inline salvo estilos con hash"). Prueba estática: el hash declarado en la
// etiqueta <meta> coincide EXACTAMENTE con el contenido real del <style> -- si alguien
// edita el CSS sin recalcular el hash, el navegador bloquearía el estilo en silencio (la
// página se vería rota) y esta prueba lo atrapa antes de merge.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const OFFLINE_HTML_PATH = join(import.meta.dirname, "../../../apps/web/public/offline.html");

describe("apps/web/public/offline.html: CSP con hash del <style> inline", () => {
  const html = readFileSync(OFFLINE_HTML_PATH, "utf8");

  it("el hash sha256 declarado en la CSP coincide con el <style> real del archivo", () => {
    const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
    expect(styleMatch).not.toBeNull();
    const cssContent = styleMatch![1]!;
    const hashReal = `sha256-${createHash("sha256").update(cssContent, "utf8").digest("base64")}`;

    const cspMatch = html.match(/style-src '(sha256-[^']+)'/);
    expect(cspMatch).not.toBeNull();
    expect(cspMatch![1]).toBe(hashReal);
  });

  it("no usa 'unsafe-inline' en ninguna directiva", () => {
    expect(html).not.toContain("unsafe-inline");
  });

  it("default-src es 'none' (página estática sin scripts ni conexiones)", () => {
    expect(html).toMatch(/default-src 'none'/);
  });
});
