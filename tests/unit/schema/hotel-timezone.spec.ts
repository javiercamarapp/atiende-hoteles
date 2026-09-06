// auditoria-1/datos [MEDIO] "ninguna tabla del dominio hotelero registra la zona
// horaria del hotel" (docs/auditoria-1/datos.md). `hotel.timezone` (migración 0023):
// nombre de zona IANA (no un offset fijo), con un default explícito y validación básica
// de forma.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, openPglite, seedDev, type PgliteEngine, type SeedResult } from "@atiende-hoteles/db";

describe("hotel.timezone: cimiento para anclar 'qué día es hoy' a la zona real del hotel", () => {
  let engine: PgliteEngine;
  let seed: SeedResult;

  beforeAll(async () => {
    engine = await openPglite();
    await applyMigrations(engine.admin);
    seed = await seedDev(engine.admin);
  });

  afterAll(async () => {
    await engine.close();
  });

  it("todo hotel sembrado tiene un timezone IANA no vacío por default", async () => {
    const { rows } = await engine.admin.query<{ timezone: string }>(
      "select timezone from public.hotel where id = $1;",
      [seed.hotels[0]!.id],
    );
    expect(rows[0]!.timezone).toBe("America/Mexico_City");
  });

  it("Postgres reconoce el default como una zona horaria IANA válida (AT TIME ZONE no truena)", async () => {
    const { rows } = await engine.admin.query<{ local: string }>(
      "select (now() at time zone h.timezone)::text as local from public.hotel h where h.id = $1;",
      [seed.hotels[0]!.id],
    );
    expect(rows[0]!.local).toBeTruthy();
  });

  it("rechaza un valor claramente mal formado (no Continente/Ciudad)", async () => {
    await expect(
      engine.admin.query("update public.hotel set timezone = $1 where id = $2;", [
        "-05:00",
        seed.hotels[0]!.id,
      ]),
    ).rejects.toThrow(/hotel_timezone_formato_iana/);
  });

  it("acepta reasignar a otra zona IANA real (ej. un hotel en Cancún, sin DST)", async () => {
    await engine.admin.query("update public.hotel set timezone = $1 where id = $2;", [
      "America/Cancun",
      seed.hotels[0]!.id,
    ]);
    const { rows } = await engine.admin.query<{ timezone: string }>(
      "select timezone from public.hotel where id = $1;",
      [seed.hotels[0]!.id],
    );
    expect(rows[0]!.timezone).toBe("America/Cancun");
  });
});
