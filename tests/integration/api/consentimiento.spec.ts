// REQ-HUE-024 (docs/REQUISITOS.md/docs/ACEPTACION.md): "El sistema debe registrar y
// consultar un consent ledger multi-país [...]." Contra embedded-postgres real
// (ADR-003): ejercita las dos rutas nuevas
// (`apps/api/src/routes/consentimiento.ts`) -- registrar un consentimiento de un
// huésped identificado (usa la MISMA función `record_consent()` SECURITY DEFINER que
// checkinOnline.ts, REQ-SEG-002) y consultar el ledger anotado con jurisdicción,
// filtrable por país/tipo, con su resumen agregado.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

interface ConsentimientoResponse {
  id: string;
  guestId: string;
  channel: string;
  consentKind: string;
  avisoVersion: string;
  granted: boolean;
  jurisdiccion: string;
}

interface LedgerEntry {
  id: string;
  guestId: string;
  canal: string;
  tipo: string;
  otorgado: boolean;
  jurisdiccion: string;
}

interface LedgerBucket {
  jurisdiction: string;
  consentKind: string;
  granted: number;
  revoked: number;
}

describe("REQ-HUE-024: consent ledger multi-país", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let frontdeskToken: string;
  let hotelId: string;
  let guestMxId: string;
  let guestUsId: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotel = fixture.seed.hotels[0]!;
    hotelId = hotel.id;
    gmToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "gm")!.email);
    frontdeskToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "frontdesk")!.email);

    const insertGuest = async (phone: string, name: string) => {
      const { rows } = await fixture.engine.admin.query<{ id: string }>(
        `insert into public.guest (tenant_id, hotel_id, full_name, phone)
         values ((select org_id from public.hotel where id = $1), $1, $2, $3)
         returning id;`,
        [hotelId, name, phone],
      );
      return rows[0]!.id;
    };
    guestMxId = await insertGuest("+528111234567", "Huésped MX de prueba");
    guestUsId = await insertGuest("+14155551234", "Huésped US de prueba");
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  it("no existe ninguna ruta previa para registrar consentimiento de marketing (huésped sin fila)", async () => {
    const { rows } = await fixture.engine.admin.query<{ n: string }>(
      "select count(*)::text as n from public.consent where guest_id in ($1, $2);",
      [guestMxId, guestUsId],
    );
    expect(rows[0]!.n).toBe("0");
  });

  it("POST registra un consentimiento de marketing para un huésped MX, devolviendo la jurisdicción derivada", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/huespedes/${guestMxId}/consentimiento`, {
      method: "POST",
      headers: { authorization: `Bearer ${frontdeskToken}`, "content-type": "application/json" },
      body: JSON.stringify({ consentKind: "marketing", channel: "whatsapp", granted: true, avisoVersion: "aviso-v1" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as ConsentimientoResponse;
    expect(body.guestId).toBe(guestMxId);
    expect(body.consentKind).toBe("marketing");
    expect(body.granted).toBe(true);
    expect(body.jurisdiccion).toBe("MX");
  });

  it("POST registra un opt-out de marketing para un huésped US/CA", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/huespedes/${guestUsId}/consentimiento`, {
      method: "POST",
      headers: { authorization: `Bearer ${frontdeskToken}`, "content-type": "application/json" },
      body: JSON.stringify({ consentKind: "marketing", channel: "whatsapp", granted: false, avisoVersion: "aviso-v1" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as ConsentimientoResponse;
    expect(body.jurisdiccion).toBe("US_CA");
    expect(body.granted).toBe(false);
  });

  it("POST exige avisoVersion no vacía", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/huespedes/${guestMxId}/consentimiento`, {
      method: "POST",
      headers: { authorization: `Bearer ${frontdeskToken}`, "content-type": "application/json" },
      body: JSON.stringify({ consentKind: "marketing", channel: "whatsapp", granted: true, avisoVersion: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST a un huésped de otro hotel (o inexistente) da 404", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/huespedes/00000000-0000-0000-0000-000000000000/consentimiento`, {
      method: "POST",
      headers: { authorization: `Bearer ${frontdeskToken}`, "content-type": "application/json" },
      body: JSON.stringify({ consentKind: "marketing", channel: "whatsapp", granted: true, avisoVersion: "aviso-v1" }),
    });
    expect(res.status).toBe(404);
  });

  it("GET ledger (owner/gm) lista ambas filas anotadas con su jurisdicción", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/consentimiento/ledger`, {
      headers: { authorization: `Bearer ${gmToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ledger: LedgerEntry[]; resumen: LedgerBucket[] };
    const porGuest = new Map(body.ledger.map((e) => [e.guestId, e]));
    expect(porGuest.get(guestMxId)?.jurisdiccion).toBe("MX");
    expect(porGuest.get(guestUsId)?.jurisdiccion).toBe("US_CA");
    expect(body.resumen).toContainEqual({ jurisdiction: "MX", consentKind: "marketing", granted: 1, revoked: 0 });
    expect(body.resumen).toContainEqual({ jurisdiction: "US_CA", consentKind: "marketing", granted: 0, revoked: 1 });
  });

  it("GET ledger filtra por jurisdicción", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/consentimiento/ledger?jurisdiccion=MX`, {
      headers: { authorization: `Bearer ${gmToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ledger: LedgerEntry[] };
    expect(body.ledger.every((e) => e.jurisdiccion === "MX")).toBe(true);
    expect(body.ledger.some((e) => e.guestId === guestMxId)).toBe(true);
    expect(body.ledger.some((e) => e.guestId === guestUsId)).toBe(false);
  });

  it("GET ledger rechaza una jurisdicción inválida", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/consentimiento/ledger?jurisdiccion=NARNIA`, {
      headers: { authorization: `Bearer ${gmToken}` },
    });
    expect(res.status).toBe(400);
  });

  it("GET ledger está restringido a owner/gm (reporte de cumplimiento, no operación de piso)", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/consentimiento/ledger`, {
      headers: { authorization: `Bearer ${frontdeskToken}` },
    });
    expect(res.status).toBe(403);
  });
});
