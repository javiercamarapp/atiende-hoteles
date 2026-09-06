// REQ-UX-004: "El panel del dueño/gerente debe mostrar, junto a cada línea de cobro
// variable, un enlace al reporte de ahorro/valor que la sustenta." El frontend
// (apps/web/src/pages/BackOffice.tsx) ya sabe renderizar el enlace o el aviso
// honesto ("sin justificación registrada"); esta prueba verifica el backend que le da
// datos reales (GET /hoteles/:hotelId/back-office/cobros, routes/backOffice.ts) --
// nunca simula un `roi_event` que no exista (REQ-UX-002), y degrada de forma honesta
// si la tabla existe con una forma inesperada (H7 en curso, propietario real del
// esquema).
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

describe("GET /hoteles/:hotelId/back-office/cobros (REQ-UX-004)", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let frontdeskToken: string;
  let hotelId: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);
    frontdeskToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "frontdesk")!.email);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  afterEach(async () => {
    await fixture.engine.admin.query("drop table if exists public.roi_event;").catch(() => {});
  });

  function auth(token: string) {
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
  }

  it("sin roi_event en este entorno (estado real de H7 en curso): devuelve [] honesto, nunca un error", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/back-office/cobros`, { headers: auth(gmToken) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("solo owner/gm pueden ver los cobros variables del hotel", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/back-office/cobros`, { headers: auth(frontdeskToken) });
    expect(res.status).toBe(403);
  });

  it("si roi_event existe con la forma esperada: mapea cada fila con su roiEventUrl real", async () => {
    await fixture.engine.admin.query(`
      create table public.roi_event (
        id uuid primary key default gen_random_uuid(),
        hotel_id uuid not null,
        concepto text not null,
        monto_verificado numeric(12,2) not null,
        created_at timestamptz not null default now()
      );
      grant select on public.roi_event to authenticated;
    `);
    const eventoId = randomUUID();
    await fixture.engine.admin.query(
      "insert into public.roi_event (id, hotel_id, concepto, monto_verificado) values ($1, $2, $3, $4);",
      [eventoId, hotelId, "Ahorro de energía verificado (kWh/hab-noche)", 1234.5],
    );

    const res = await fixture.app.request(`/hoteles/${hotelId}/back-office/cobros`, { headers: auth(gmToken) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; concepto: string; monto: number; roiEventUrl: string }[];
    expect(body).toHaveLength(1);
    expect(body[0]!.concepto).toBe("Ahorro de energía verificado (kWh/hab-noche)");
    expect(body[0]!.monto).toBe(1234.5);
    expect(body[0]!.roiEventUrl).toContain(eventoId);
  });

  it("si roi_event existe con una forma INESPERADA: degrada a [] honesto en vez de romper la pantalla", async () => {
    await fixture.engine.admin.query(`
      create table public.roi_event (
        id uuid primary key default gen_random_uuid(),
        alguna_columna_completamente_distinta text
      );
    `);

    const res = await fixture.app.request(`/hoteles/${hotelId}/back-office/cobros`, { headers: auth(gmToken) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});
