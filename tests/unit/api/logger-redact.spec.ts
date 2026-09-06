// H8 · ADR-008 "ninguna traza persistida contiene PII sin redactar" (dataset de
// prueba con datos sintéticos, nunca reales). Construye un logger real (pino real, no
// un mock) con un destino en memoria y verifica línea por línea que la PII sintética
// nunca aparece en el JSON emitido -- solo el censor "[redactado]".
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "@atiende-hoteles/api";

function capturingLogger() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const logger = createLogger({}, destination as unknown as import("pino").DestinationStream);
  return { logger, lines };
}

describe("apps/api logger: redacción de PII (REQ-AGT-006/ADR-008)", () => {
  it("redacta password/token en cualquier profundidad del objeto logueado", () => {
    const { logger, lines } = capturingLogger();
    logger.info(
      {
        request_id: "req-1",
        user: { email: "sensible@ejemplo.test", password: "hunter2-sintetico" },
        token: "refresh-sintetico",
      },
      "evento_sintetico",
    );

    expect(lines).toHaveLength(1);
    const raw = lines[0]!;
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    expect(raw).not.toContain("hunter2-sintetico");
    expect(raw).not.toContain("refresh-sintetico");
    expect((parsed.user as { password: string }).password).toBe("[redactado]");
    expect(parsed.token).toBe("[redactado]");
  });

  it("redacta req.headers.authorization (forma real de un log de request de Hono/pino)", () => {
    const { logger, lines } = capturingLogger();
    logger.info({ req: { headers: { authorization: "Bearer real-simulado-no-real" } } }, "request");

    const raw = lines[0]!;
    expect(raw).not.toContain("real-simulado-no-real");
    const parsed = JSON.parse(raw) as { req: { headers: { authorization: string } } };
    expect(parsed.req.headers.authorization).toBe("[redactado]");
  });

  it("redacta campos de identidad de huésped (email/teléfono/RFC/CURP/número de documento) sin importar el contenedor", () => {
    const { logger, lines } = capturingLogger();
    logger.info(
      {
        huesped: {
          email: "huesped-sintetico@ejemplo.test",
          telefono: "+52-555-000-0000",
          rfc: "XAXX010101000",
          curp: "XAXX010101HDFXXX09",
          numeroDocumento: "G12345678",
        },
      },
      "huesped_creado",
    );

    const raw = lines[0]!;
    for (const valor of [
      "huesped-sintetico@ejemplo.test",
      "+52-555-000-0000",
      "XAXX010101000",
      "XAXX010101HDFXXX09",
      "G12345678",
    ]) {
      expect(raw).not.toContain(valor);
    }
  });

  it("NO redacta campos operativos normales (org_id/hotel_id/reservation_id/status) -- la redacción no debe volver los logs inútiles", () => {
    const { logger, lines } = capturingLogger();
    logger.info({ request_id: "req-2", org_id: "org-1", hotel_id: "hotel-1", status: 201, method: "POST" }, "request");

    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed.org_id).toBe("org-1");
    expect(parsed.hotel_id).toBe("hotel-1");
    expect(parsed.status).toBe(201);
    expect(parsed.method).toBe("POST");
  });
});
