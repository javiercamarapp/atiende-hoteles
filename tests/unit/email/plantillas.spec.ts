// H12a · Verifica, para cada una de las 12 plantillas de packages/email, que renderizar
// sus datos de muestra no lanza, que ni el HTML ni el texto quedan con basura de
// interpolación (`undefined`/`[object Object]`) y que ambos formatos contienen al menos
// un dato clave de la muestra (no solo el HTML -- el texto plano es obligatorio, ver
// port.ts).
import { describe, expect, it } from "vitest";
import { TEMPLATES } from "@atiende-hoteles/email";

const CLAVES: Record<string, string[]> = {
  "verificacion-cuenta": ["Casa Mérida", "24 horas"],
  "magic-link": ["reservaciones@casamerida.mx", "15 minutos"],
  "bienvenida-hotel": ["Casa Mérida", "Mariana Cetina"],
  "invitacion-staff": ["Casa Mérida", "Recepción"],
  "restablecer-contrasena": ["reservaciones@casamerida.mx"],
  "cambio-correo": ["administracion@casamerida.mx"],
  "confirmacion-reserva": ["CM-48213", "$5,940.00"],
  "recordatorio-prellegada": ["CM-48213", "15:00"],
  "agradecimiento-poststay": ["Casa Mérida", "Luis Fernando Aguilar"],
  "recibo-pago": ["F-2026-00981", "$5,940.00"],
  "cfdi-disponible": ["3F2A9C10-6B4D-4E7A-9F1C-2D8E5A0B7C34"],
  "prospeccion-comercial": ["Hacienda San Ignacio", "Roberto Peón"],
};

describe("plantillas de correo (H12a)", () => {
  for (const slug of Object.keys(TEMPLATES)) {
    it(`${slug}: renderiza sin lanzar y sin basura de interpolación`, () => {
      const { render, sample } = TEMPLATES[slug]!;
      const data = sample();

      let rendered;
      expect(() => {
        rendered = render(data);
      }).not.toThrow();

      expect(rendered).toBeDefined();
      const { subject, preheader, html, text } = rendered!;

      for (const value of [html, text]) {
        expect(value).not.toContain("undefined");
        expect(value).not.toContain("[object Object]");
        expect(value).not.toContain("[object");
      }

      expect(preheader.length).toBeGreaterThan(0);
      expect(subject.length).toBeGreaterThan(0);

      const claves = CLAVES[slug] ?? [];
      expect(claves.length).toBeGreaterThan(0);

      // El HTML debe contener el subject o al menos un dato clave de la muestra.
      const algunaClaveEnHtml = claves.some((clave) => html.includes(clave));
      expect(html.includes(subject) || algunaClaveEnHtml).toBe(true);

      // El texto plano también debe llevar al menos un dato clave de la muestra --
      // no basta con que el HTML lo tenga (algunos clientes solo muestran texto).
      const algunaClaveEnTexto = claves.some((clave) => text.includes(clave));
      expect(algunaClaveEnTexto).toBe(true);
    });
  }
});
