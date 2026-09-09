// REQ-AB-012 (P1/NF): la doble verificación de identidad para un cargo de
// consumo/servicio a la habitación (fraude "cárguelo al 304") DEBE aplicarse por el
// hecho económico (concepto real del cargo), NUNCA condicionada a que el mismo actor
// que hace la petición haya elegido declararlo como concept='ab'.
//
// Dos intentos anteriores (2026-09-09) fallaron exactamente por esto: protegían el
// VALOR 'ab' del enum, no el hecho económico -- declarar 'extras' u omitir el campo
// (default 'otro') para el MISMO cargo evadía el control por completo. Este test
// reproduce EXACTAMENTE el ataque confirmado por la auditoría adversarial:
// "Botella de tequila + 4 cervezas - bar alberca" cobrado a la habitación de un
// huésped real, sin ser ese huésped, declarando cualquier concepto que no sea 'ab'.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, crearFolioConfirmado, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

describe("REQ-AB-012: el bypass por concepto declarado queda cerrado (auditoría adversarial)", () => {
  let fixture: ApiFixture;
  let frontdeskToken: string;
  let hotelId: string;
  let roomTypeId: string;
  let guestId: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    roomTypeId = hotelA.roomTypes[0]!.id;
    frontdeskToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "frontdesk")!.email);

    // Huésped real con apellido/teléfono en archivo, mismo criterio que otros
    // adversariales de este repo (auditoria-2-lote-a-seguridad-legal.spec.ts).
    const { rows } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.guest (tenant_id, hotel_id, full_name, phone) values ($1, $2, $3, $4) returning id;",
      [fixture.seed.orgId, hotelId, "María Fernanda López", "5512345678"],
    );
    guestId = rows[0]!.id;
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  function auth(token: string) {
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
  }

  let nextDay = 1;

  async function crearFolioConHuesped() {
    const dia = nextDay++;
    const checkInDate = `2026-10-${String(dia).padStart(2, "0")}`;
    const checkOutDate = `2026-10-${String(dia + 1).padStart(2, "0")}`;
    const { folioId, reservationId } = await crearFolioConfirmado(fixture.app, frontdeskToken, hotelId, {
      roomTypeId,
      checkInDate,
      checkOutDate,
    });
    await fixture.engine.admin.query("update public.reservation set guest_id = $1 where id = $2;", [guestId, reservationId]);
    return folioId;
  }

  it("BYPASS ORIGINAL (concepto='extras', sin verificación, actor NO admin): ahora se rechaza con 403", async () => {
    const folioId = await crearFolioConHuesped();
    const res = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cargos`, {
      method: "POST",
      headers: { ...auth(frontdeskToken), "idempotency-key": randomUUID() },
      body: JSON.stringify({ descripcion: "Botella de tequila + 4 cervezas - bar alberca", monto: 850, concepto: "extras" }),
    });
    expect(res.status).toBe(403);

    // Confirma en la base que NO quedó ninguna fila cobrable -- no solo que la
    // respuesta HTTP fue 403 (podría haber insertado igual con un bug de rollback).
    const { rows } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.charge where folio_id = $1;",
      [folioId],
    );
    expect(rows[0]!.count).toBe("0");
  });

  it("BYPASS ORIGINAL (concepto omitido -> default 'otro'): también se rechaza", async () => {
    const folioId = await crearFolioConHuesped();
    const res = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cargos`, {
      method: "POST",
      headers: { ...auth(frontdeskToken), "idempotency-key": randomUUID() },
      body: JSON.stringify({ descripcion: "Consumo de bar sin especificar", monto: 500 }),
    });
    expect(res.status).toBe(403);
  });

  it("con verificación de identidad que SÍ coincide con el huésped real, el cargo se acepta", async () => {
    const folioId = await crearFolioConHuesped();
    const res = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cargos`, {
      method: "POST",
      headers: { ...auth(frontdeskToken), "idempotency-key": randomUUID() },
      body: JSON.stringify({
        descripcion: "Botella de tequila + 4 cervezas - bar alberca",
        monto: 850,
        concepto: "extras",
        verificacionIdentidad: { apellido: "López", telefonoUlt4: "5678" },
      }),
    });
    expect(res.status).toBe(201);
  });

  it("una DISCREPANCIA activa (apellido no coincide) se rechaza siempre, sin importar el rol -- nunca overridable", async () => {
    const folioId = await crearFolioConHuesped();
    const res = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cargos`, {
      method: "POST",
      headers: { ...auth(frontdeskToken), "idempotency-key": randomUUID() },
      body: JSON.stringify({
        descripcion: "Consumo bar",
        monto: 200,
        concepto: "ab",
        verificacionIdentidad: { apellido: "Ramírez", telefonoUlt4: "5678" },
      }),
    });
    expect(res.status).toBe(403);
  });

  it("un barrido de TODOS los conceptos del enum nunca produce un cargo sin verificar salvo hospedaje/ajuste/propina (mismo folio, cargos independientes)", async () => {
    const folioId = await crearFolioConHuesped();
    const conceptosSinControlDeIdentidad = new Set(["hospedaje", "ajuste", "propina"]);
    for (const concepto of ["hospedaje", "ab", "extras", "ajuste", "propina", "otro"] as const) {
      const res = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cargos`, {
        method: "POST",
        headers: { ...auth(frontdeskToken), "idempotency-key": randomUUID() },
        body: JSON.stringify({ descripcion: `Cargo sin verificar (${concepto})`, monto: 100, concepto }),
      });
      if (conceptosSinControlDeIdentidad.has(concepto)) {
        expect(res.status, `concepto=${concepto} debería aceptarse sin control de identidad`).toBe(201);
      } else {
        expect(res.status, `concepto=${concepto} debería exigir verificación de identidad`).toBe(403);
      }
    }
  });

  it("un rol administrativo (gm/owner) SIN reclamo de identidad SÍ puede postear (override, folio sin discrepancia activa)", async () => {
    const gmToken = await loginAs(fixture.app, fixture.seed.hotels[0]!.staff.find((s) => s.role === "gm")!.email);
    const folioId = await crearFolioConHuesped();
    const res = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cargos`, {
      method: "POST",
      headers: { ...auth(gmToken), "idempotency-key": randomUUID() },
      body: JSON.stringify({ descripcion: "Cortesía de bienvenida", monto: 300, concepto: "extras" }),
    });
    expect(res.status).toBe(201);
  });
});
