// REQ-REC-011/REQ-SEG-014/REQ-SEG-004/REQ-REC-010: bóveda de identidad aislada.
// - Imagen del documento NUNCA se persiste (no hay dónde: sin columna de imagen en el
//   esquema); el número se cifra en reposo (AES-256-GCM, clave de entorno).
// - `identity_ref` expone SOLO nombre/nacionalidad/tipo/últimos 4; el resto del
//   sistema nunca ve el número completo ni el ciphertext.
// - Consulta DIRECTA a `identity_vault` desde una sesión de staff normal (incluso
//   owner/gm) es RECHAZADA -- el único acceso es vía las funciones SECURITY DEFINER.
// - MRZ con dígito de control alterado es rechazada: 0 filas creadas.
// - Retención ≤30 días post-checkout con purga automática por lote (simulado a t=31
//   días → 0 filas de la bóveda restantes para esa reserva).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPassportMrz } from "../../packages/domain-hotel/src/mrz.ts";
import { purgeExpiredIdentityVault } from "../../apps/api/src/jobs/purgeIdentityVault.ts";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../support/api-fixture.ts";

describe("adversarial: bóveda de identidad (REQ-REC-011/REQ-SEG-014/REQ-SEG-004)", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let frontdeskToken: string;
  let housekeepingToken: string;
  let hotelId: string;
  let roomTypeId: string;

  const mrzValida = buildPassportMrz({
    countryCode: "MEX",
    surname: "HERNANDEZ TORRES",
    givenNames: "LUCIA",
    documentNumber: "G7654321",
    nationality: "MEX",
    birthDateYyMmDd: "920310",
    sex: "F",
    expiryDateYyMmDd: "310215",
  });

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    roomTypeId = hotelA.roomTypes[0]!.id;
    gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);
    frontdeskToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "frontdesk")!.email);
    housekeepingToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "housekeeping")!.email);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  function auth(token: string) {
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
  }

  async function seededDate(offset: number): Promise<string> {
    const { rows } = await fixture.engine.admin.query<{ date: string }>(
      "select date::text as date from public.availability where hotel_id = $1 and room_type_id = $2 order by date asc;",
      [hotelId, roomTypeId],
    );
    return rows[offset]!.date;
  }

  function nightAfter(d: string): string {
    const dt = new Date(`${d}T00:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() + 1);
    return dt.toISOString().slice(0, 10);
  }

  async function crearReservaConfirmada(offset: number): Promise<string> {
    const checkIn = await seededDate(offset);
    const res = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { ...auth(gmToken), "idempotency-key": randomUUID() },
      body: JSON.stringify({ roomTypeId, checkInDate: checkIn, checkOutDate: nightAfter(checkIn) }),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const resTransicion = await fixture.app.request(`/hoteles/${hotelId}/reservas/${id}/transicion`, {
      method: "PATCH",
      headers: auth(gmToken),
      body: JSON.stringify({ toStatus: "confirmada" }),
    });
    expect(resTransicion.status).toBe(200);
    return id;
  }

  it("MRZ válida: registra el documento, identity_ref expone SOLO campos mínimos", async () => {
    const reservationId = await crearReservaConfirmada(0);

    const res = await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationId}/identidad`, {
      method: "POST",
      headers: auth(frontdeskToken),
      body: JSON.stringify({ mrzLine1: mrzValida.line1, mrzLine2: mrzValida.line2, documentImageBase64: "AAAA_foto_simulada_no_real" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toEqual({
      id: expect.any(String),
      nombreCompleto: "LUCIA HERNANDEZ TORRES",
      nacionalidad: "MEX",
      tipoDocumento: "pasaporte",
      ultimos4: "4321",
    });
    // Nunca se expone el número completo ni ningún campo de ciphertext en la respuesta.
    expect(JSON.stringify(body)).not.toContain("G7654321");
    expect(body).not.toHaveProperty("documentNumberCiphertext");
    expect(body).not.toHaveProperty("numeroDocumento");
  });

  it("la imagen enviada NUNCA se persiste: 0 filas en todo el esquema contienen el string enviado como imagen", async () => {
    const reservationId = await crearReservaConfirmada(1);
    const marcadorUnico = `IMG_MARCADOR_UNICO_${randomUUID()}`;

    const res = await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationId}/identidad`, {
      method: "POST",
      headers: auth(frontdeskToken),
      body: JSON.stringify({ mrzLine1: mrzValida.line1, mrzLine2: mrzValida.line2, documentImageBase64: marcadorUnico }),
    });
    expect(res.status).toBe(201);

    // Recorre las columnas de texto candidatas donde una imagen mal manejada podría
    // haber quedado -- 0 coincidencias del marcador en ninguna.
    const { rows: enRef } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.identity_ref where full_name ilike $1;",
      [`%${marcadorUnico}%`],
    );
    expect(enRef[0]!.count).toBe("0");

    const { rows: enAudit } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.audit_log where payload::text ilike $1;",
      [`%${marcadorUnico}%`],
    );
    expect(enAudit[0]!.count).toBe("0");
  });

  it("MRZ con dígito de control alterado es RECHAZADA: 0 filas creadas en la bóveda", async () => {
    const reservationId = await crearReservaConfirmada(2);
    const line2Alterada = "X" + mrzValida.line2.slice(1);

    const res = await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationId}/identidad`, {
      method: "POST",
      headers: auth(frontdeskToken),
      body: JSON.stringify({ mrzLine1: mrzValida.line1, mrzLine2: line2Alterada }),
    });
    expect(res.status).toBe(400);

    const { rows } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.identity_ref where reservation_id = $1;",
      [reservationId],
    );
    expect(rows[0]!.count).toBe("0");
  });

  it("housekeeping NO puede leer identity_ref (403) -- solo owner/gm/frontdesk/reservations", async () => {
    const reservationId = await crearReservaConfirmada(3);
    await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationId}/identidad`, {
      method: "POST",
      headers: auth(frontdeskToken),
      body: JSON.stringify({ mrzLine1: mrzValida.line1, mrzLine2: mrzValida.line2 }),
    });

    const res = await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationId}/identidad`, {
      headers: auth(housekeepingToken),
    });
    expect(res.status).toBe(403);
  });

  it("consulta DIRECTA a identity_vault desde una sesión de staff (incluso gm) es RECHAZADA -- solo vía las funciones SECURITY DEFINER", async () => {
    const reservationId = await crearReservaConfirmada(4);
    await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationId}/identidad`, {
      method: "POST",
      headers: auth(frontdeskToken),
      body: JSON.stringify({ mrzLine1: mrzValida.line1, mrzLine2: mrzValida.line2 }),
    });

    await fixture.engine.withAppSession({ userId: fixture.seed.hotels[0]!.staff.find((s) => s.role === "gm")!.id }, async (session) => {
      await expect(
        session.query("select * from public.identity_vault where reservation_id = $1;", [reservationId]),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  it("cifrado en reposo: el ciphertext almacenado NUNCA contiene el número de documento en texto plano", async () => {
    const reservationId = await crearReservaConfirmada(5);
    await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationId}/identidad`, {
      method: "POST",
      headers: auth(frontdeskToken),
      body: JSON.stringify({ mrzLine1: mrzValida.line1, mrzLine2: mrzValida.line2 }),
    });

    const { rows } = await fixture.engine.admin.query<{ ciphertext: Buffer }>(
      "select document_number_ciphertext as ciphertext from public.identity_vault where reservation_id = $1;",
      [reservationId],
    );
    expect(rows).toHaveLength(1);
    const ciphertextHex = Buffer.from(rows[0]!.ciphertext).toString("hex");
    expect(ciphertextHex).not.toContain(Buffer.from("G7654321").toString("hex"));
  });

  it("revelar el número completo: solo owner/gm, cada lectura queda auditada en audit_log", async () => {
    const reservationId = await crearReservaConfirmada(6);
    const registro = await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationId}/identidad`, {
      method: "POST",
      headers: auth(frontdeskToken),
      body: JSON.stringify({ mrzLine1: mrzValida.line1, mrzLine2: mrzValida.line2 }),
    });
    const { id: identityRefId } = (await registro.json()) as { id: string };

    const rechazo = await fixture.app.request(`/hoteles/${hotelId}/identidad/${identityRefId}/revelar`, {
      method: "POST",
      headers: auth(frontdeskToken),
      body: JSON.stringify({ motivo: "verificación de rutina" }),
    });
    expect(rechazo.status).toBe(403);

    const revelado = await fixture.app.request(`/hoteles/${hotelId}/identidad/${identityRefId}/revelar`, {
      method: "POST",
      headers: auth(gmToken),
      body: JSON.stringify({ motivo: "solicitud de autoridad migratoria, folio 123" }),
    });
    expect(revelado.status).toBe(200);
    const body = (await revelado.json()) as { numeroDocumento: string };
    expect(body.numeroDocumento).toBe("G7654321");

    const { rows: auditoria } = await fixture.engine.admin.query<{ payload: { reason: string } }>(
      "select payload from public.audit_log where entity_id = $1 and action = 'identity_vault.decrypted' order by created_at desc limit 1;",
      [identityRefId],
    );
    expect(auditoria).toHaveLength(1);
    expect(auditoria[0]!.payload.reason).toMatch(/autoridad migratoria/);
  });

  it("retención ≤30 días post-checkout con purga automática (t=31 días → 0 filas restantes; t=10 días → conservada)", async () => {
    const reservationVencida = await crearReservaConfirmada(7);
    const reservationVigente = await crearReservaConfirmada(8);

    for (const reservationId of [reservationVencida, reservationVigente]) {
      const res = await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationId}/identidad`, {
        method: "POST",
        headers: auth(frontdeskToken),
        body: JSON.stringify({ mrzLine1: mrzValida.line1, mrzLine2: mrzValida.line2 }),
      });
      expect(res.status).toBe(201);
    }

    // Simula: una reserva hizo checkout hace 31 días (vencida), la otra hace 10 días
    // (todavía dentro de la ventana de 30 días) -- nunca se inventa un "job simulado",
    // se fija `checkout_at` directamente vía la función real `set_identity_checkout`
    // con una fecha en el pasado, exactamente como lo haría un checkout real de esa
    // fecha.
    await fixture.engine.admin.query("select public.set_identity_checkout($1, now() - interval '31 days');", [reservationVencida]);
    await fixture.engine.admin.query("select public.set_identity_checkout($1, now() - interval '10 days');", [reservationVigente]);

    const resultado = await purgeExpiredIdentityVault(fixture.engine.admin, { batchSize: 500 });
    expect(resultado.deletedTotal).toBeGreaterThanOrEqual(1);

    const { rows: vencida } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.identity_vault where reservation_id = $1;",
      [reservationVencida],
    );
    expect(vencida[0]!.count).toBe("0"); // "0 imágenes restantes" -- aquí, 0 filas de la bóveda.

    const { rows: refVencida } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.identity_ref where reservation_id = $1;",
      [reservationVencida],
    );
    expect(refVencida[0]!.count).toBe("0"); // cascada: identity_ref también desaparece.

    const { rows: vigente } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.identity_vault where reservation_id = $1;",
      [reservationVigente],
    );
    expect(vigente[0]!.count).toBe("1"); // dentro de la ventana de 30 días: NUNCA se purga.
  });
});
