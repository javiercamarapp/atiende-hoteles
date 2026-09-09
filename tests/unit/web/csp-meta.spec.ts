// H12b · LAUNCH-021: la CSP de apps/web se construye en `apps/web/tools/cspMetaPlugin.ts`
// (inyectada como <meta> en cada `vite build`, resuelta por entorno). Prueba estática de
// las invariantes de seguridad sin necesitar un build completo de Vite.
import { describe, expect, it } from "vitest";
import { buildCsp } from "../../../apps/web/tools/cspMetaPlugin.ts";

describe("apps/web CSP (cspMetaPlugin)", () => {
  it("script-src es 'self' sin unsafe-inline ni unsafe-eval", () => {
    const csp = buildCsp([]);
    const scriptSrc = csp.split(";").find((d) => d.trim().startsWith("script-src"));
    expect(scriptSrc).toBe(" script-src 'self'");
  });

  it("style-src permite 'unsafe-inline' (documentado: style={{}} de React) y la hoja de Google Fonts", () => {
    const csp = buildCsp([]);
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
  });

  it("connect-src incluye 'self' más los orígenes de API/Supabase resueltos por entorno", () => {
    const csp = buildCsp(["https://api.ejemplo.com", "https://proyecto.supabase.co"]);
    expect(csp).toContain("connect-src 'self' https://api.ejemplo.com https://proyecto.supabase.co");
  });

  it("descarta orígenes undefined (entorno sin VITE_API_URL/VITE_SUPABASE_URL configuradas)", () => {
    const csp = buildCsp([undefined, undefined]);
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("undefined");
  });

  it("no contiene 'unsafe-eval' en ninguna directiva", () => {
    const csp = buildCsp(["https://api.ejemplo.com"]);
    expect(csp).not.toContain("unsafe-eval");
  });

  it("frame-src/object-src están en 'none' (sin iframes ni plugins embebidos en el panel)", () => {
    const csp = buildCsp([]);
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("object-src 'none'");
  });
});
