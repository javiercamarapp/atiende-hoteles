// auditoria-1/datos [MEDIO] "idempotency_key no tiene TTL ni columna de expiracion"
// (docs/auditoria-1/datos.md). `expires_at` (migración 0022) + `withIdempotency()`
// (apps/api/src/lib/idempotency.ts, `ON CONFLICT ... DO UPDATE ... WHERE expires_at <
// now()`): una llave ya expirada se puede reclamar de nuevo (nuevo cuerpo, nueva
// respuesta), en vez de proteger la operación original "para siempre".
//
// Se prueba contra POST .../cargos (folios) en vez de POST /reservas: `reservation`
// tiene ADEMÁS su propia columna `idempotency_key` con un UNIQUE por tenant (0006),
// independiente del mecanismo genérico de `idempotency_key` — reusar la misma clave
// para una SEGUNDA reserva chocaría contra ESA constraint incluso con la ventana ya
// expirada, lo cual es correcto pero mezclaría dos mecanismos distintos en una sola
// prueba. `charge`/`payment` no tienen esa columna propia: aíslan el comportamiento del
// mecanismo genérico que es el que esta migración cambia.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../support/api-fixture.ts";

// Bug real de CI (10-sep-2026): fechas que eran literales absolutos se quedan fuera
// de la ventana de tarifa/disponibilidad sembrada por seedDev (siempre desde "hoy"
// real, 30 días) tarde o temprano -- corregidas a offsets relativos, nunca "hoy" mismo.
function isoDate(daysFromNow: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}


describe("idempotency_key: ventana de expiración (auditoria-1/datos MEDIO)", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let hotelId: string;
  let roomTypeId: string;
  let folioId: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    roomTypeId = hotelA.roomTypes[0]!.id;
    gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);

    const reservaRes = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { ...auth(), "idempotency-key": randomUUID() },
      body: JSON.stringify({ roomTypeId, checkInDate: isoDate(22), checkOutDate: isoDate(23) }),
    });
    const reserva = (await reservaRes.json()) as { id: string };

    const confirmRes = await fixture.app.request(
      `/hoteles/${hotelId}/reservas/${reserva.id}/transicion`,
      { method: "PATCH", headers: auth(), body: JSON.stringify({ toStatus: "confirmada" }) },
    );
    const confirmada = (await confirmRes.json()) as { folioId: string };
    folioId = confirmada.folioId;
    expect(folioId).toBeTruthy();
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  function auth() {
    return { authorization: `Bearer ${gmToken}`, "content-type": "application/json" };
  }

  async function postCargo(key: string, body: unknown) {
    return fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cargos`, {
      method: "POST",
      headers: { ...auth(), "idempotency-key": key },
      body: JSON.stringify(body),
    });
  }

  it("una fila recién insertada tiene expires_at en el futuro (no 'para siempre')", async () => {
    const key = randomUUID();
    const res = await postCargo(key, { descripcion: "Minibar", monto: 150 });
    expect(res.status).toBe(201);

    const { rows } = await fixture.engine.admin.query<{ expires_at: string; created_at: string }>(
      "select expires_at, created_at from public.idempotency_key where scope = 'charge.create' and key = $1;",
      [key],
    );
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0]!.expires_at).getTime()).toBeGreaterThan(new Date(rows[0]!.created_at).getTime());
    expect(new Date(rows[0]!.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("una llave EXPIRADA se puede reclamar de nuevo (cuerpo distinto crea un cargo NUEVO, no 422 ni la respuesta vieja)", async () => {
    const key = randomUUID();
    const primero = await postCargo(key, { descripcion: "Minibar", monto: 150 });
    expect(primero.status).toBe(201);
    const primerCargo = (await primero.json()) as { id: string };

    // Fuerza la expiración (simula que pasaron los 7 días de la ventana) sin esperar el
    // reloj real -- manipula solo la fila de prueba, con el cliente admin.
    await fixture.engine.admin.query(
      "update public.idempotency_key set expires_at = now() - interval '1 minute' where scope = 'charge.create' and key = $1;",
      [key],
    );

    const segundo = await postCargo(key, { descripcion: "Room service", monto: 480 });
    // Con la llave vigente esto hubiera sido 422 (idempotency_key_conflict, cuerpo
    // distinto con la misma clave) -- expirada, se acepta como una operación NUEVA.
    expect(segundo.status).toBe(201);
    const segundoCargo = (await segundo.json()) as { id: string; concepto: string };
    expect(segundoCargo.id).not.toBe(primerCargo.id);

    // H5 (folio reescrito, migración 0030) separó `concepto` (categoría fija:
    // hospedaje/ab/extras/ajuste/propina/otro) de `descripcion` (texto libre) -- la
    // respuesta de POST .../cargos ya no expone `descripcion`, así que el texto libre
    // se verifica contra la fila persistida (`charge.description`) en vez del cuerpo
    // de la respuesta.
    const { rows } = await fixture.engine.admin.query<{ description: string }>(
      "select description from public.charge where id = $1;",
      [segundoCargo.id],
    );
    expect(rows[0]!.description).toBe("Room service");

    const { rows: countRows } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.charge where id in ($1, $2);",
      [primerCargo.id, segundoCargo.id],
    );
    expect(countRows[0]!.count).toBe("2");
  });

  it("una llave VIGENTE (no expirada) sigue rechazando cuerpo distinto con 422, como antes", async () => {
    const key = randomUUID();
    const primero = await postCargo(key, { descripcion: "Minibar", monto: 150 });
    expect(primero.status).toBe(201);

    const segundo = await postCargo(key, { descripcion: "Otro concepto", monto: 999 });
    expect(segundo.status).toBe(422);
  });
});
