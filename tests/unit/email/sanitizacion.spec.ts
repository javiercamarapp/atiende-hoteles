// H12a · Prueba de sanitización XSS: todo dato que venga de un huésped/staff/formulario
// (nombre de huésped, nombre de hotel escrito por el usuario, notas) DEBE pasar por
// `escapeHtml()` antes de interpolarse en el HTML (ver layout.ts). Esta prueba confirma
// que payloads de inyección reales quedan neutralizados en el HTML resultante -- si
// alguna plantilla interpola un campo externo sin escapar, esta prueba debe fallar.
import { describe, expect, it } from "vitest";
import {
  renderConfirmacionReserva,
  sampleConfirmacionReservaData,
  renderInvitacionStaff,
  sampleInvitacionStaffData,
  renderBienvenidaHotel,
  sampleBienvenidaHotelData,
} from "@atiende-hoteles/email";

const SCRIPT_PAYLOAD = "<script>alert(1)</script>Hotel Test";
const IMG_PAYLOAD = "<img src=x onerror=alert(1)>Juan";

function expectSanitized(html: string, rawPayload: string) {
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img src=x onerror");
  // El payload debe seguir "presente" pero neutralizado (entidades HTML), nunca crudo.
  expect(html).not.toContain(rawPayload);
}

describe("sanitización XSS de datos externos (H12a)", () => {
  it("confirmacionReserva: nombreHuesped y nombreHotel con payload HTML quedan escapados", () => {
    const data = { ...sampleConfirmacionReservaData(), nombreHuesped: IMG_PAYLOAD, nombreHotel: SCRIPT_PAYLOAD };
    const { html } = renderConfirmacionReserva(data);
    expectSanitized(html, IMG_PAYLOAD);
    expectSanitized(html, SCRIPT_PAYLOAD);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
  });

  it("invitacionStaff: nombreHotel y nombreQuienInvita con payload HTML quedan escapados", () => {
    const data = { ...sampleInvitacionStaffData(), nombreHotel: SCRIPT_PAYLOAD, nombreQuienInvita: IMG_PAYLOAD };
    const { html } = renderInvitacionStaff(data);
    expectSanitized(html, SCRIPT_PAYLOAD);
    expectSanitized(html, IMG_PAYLOAD);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
  });

  it("bienvenidaHotel: nombreHotel, nombreOwner y cada paso de onboarding quedan escapados", () => {
    const data = {
      ...sampleBienvenidaHotelData(),
      nombreHotel: SCRIPT_PAYLOAD,
      nombreOwner: IMG_PAYLOAD,
      pasosOnboarding: ["<script>alert('paso')</script>Configura tus tarifas"],
    };
    const { html } = renderBienvenidaHotel(data);
    expectSanitized(html, SCRIPT_PAYLOAD);
    expectSanitized(html, IMG_PAYLOAD);
    expect(html).not.toContain("<script>alert('paso')</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
