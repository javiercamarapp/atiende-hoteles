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
  let ownerToken: string;
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
    ownerToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "owner")!.email);
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

  // REQ-SEG-014 "doble control pleno": revelar el número completo ahora exige TRES
  // pasos -- (1) un owner/gm solicita, (2) un owner/gm DISTINTO aprueba, (3) solo quien
  // solicitó puede exponer el documento de una solicitud ya aprobada, una sola vez.
  describe("revelar el número completo con doble control (REQ-SEG-014)", () => {
    async function registrarIdentidad(offset: number): Promise<string> {
      const reservationId = await crearReservaConfirmada(offset);
      const registro = await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationId}/identidad`, {
        method: "POST",
        headers: auth(frontdeskToken),
        body: JSON.stringify({ mrzLine1: mrzValida.line1, mrzLine2: mrzValida.line2 }),
      });
      expect(registro.status).toBe(201);
      const { id } = (await registro.json()) as { id: string };
      return id;
    }

    async function solicitar(identityRefId: string, token: string, motivo: string) {
      return fixture.app.request(`/hoteles/${hotelId}/identidad/${identityRefId}/revelar/solicitudes`, {
        method: "POST",
        headers: auth(token),
        body: JSON.stringify({ motivo }),
      });
    }

    function decidir(requestId: string, token: string, decision: "aprobar" | "rechazar") {
      return fixture.app.request(`/hoteles/${hotelId}/identidad/solicitudes/${requestId}/decision`, {
        method: "POST",
        headers: auth(token),
        body: JSON.stringify({ decision }),
      });
    }

    function exponer(requestId: string, token: string) {
      return fixture.app.request(`/hoteles/${hotelId}/identidad/solicitudes/${requestId}/revelar`, {
        method: "POST",
        headers: auth(token),
      });
    }

    it("frontdesk NO puede ni solicitar ni decidir sobre el revelado -- solo owner/gm", async () => {
      const identityRefId = await registrarIdentidad(6);
      const rechazoSolicitar = await solicitar(identityRefId, frontdeskToken, "verificación de rutina");
      expect(rechazoSolicitar.status).toBe(403);
    });

    it("flujo completo feliz: gm solicita, owner (persona distinta) aprueba, gm expone el documento una sola vez", async () => {
      const identityRefId = await registrarIdentidad(7);

      const solicitud = await solicitar(identityRefId, gmToken, "solicitud de autoridad migratoria, folio 123");
      expect(solicitud.status).toBe(201);
      const { id: requestId, estado } = (await solicitud.json()) as { id: string; estado: string };
      expect(estado).toBe("pendiente");

      // Antes de aprobarse, exponer el documento debe fallar (doble control real, no
      // solo de nombre).
      const exponerPrematuro = await exponer(requestId, gmToken);
      expect(exponerPrematuro.status).toBe(409);

      // La misma persona que solicitó NO puede aprobar su propia solicitud.
      const autoaprobacion = await decidir(requestId, gmToken, "aprobar");
      expect(autoaprobacion.status).toBe(403);

      const aprobacion = await decidir(requestId, ownerToken, "aprobar");
      expect(aprobacion.status).toBe(200);
      expect(((await aprobacion.json()) as { estado: string }).estado).toBe("aprobada");

      // Alguien que NO solicitó (aunque tenga rol owner/gm y la solicitud ya esté
      // aprobada) no puede exponer el documento en su lugar.
      const exponerAjeno = await exponer(requestId, ownerToken);
      expect(exponerAjeno.status).toBe(403);

      const revelado = await exponer(requestId, gmToken);
      expect(revelado.status).toBe(200);
      const body = (await revelado.json()) as { numeroDocumento: string };
      expect(body.numeroDocumento).toBe("G7654321");

      // Un solo uso: la misma solicitud aprobada no puede consumirse dos veces.
      const segundaExposicion = await exponer(requestId, gmToken);
      expect(segundaExposicion.status).toBe(409);

      const { rows: auditoria } = await fixture.engine.admin.query<{ action: string; payload: Record<string, unknown> }>(
        "select action, payload from public.audit_log where entity_id = $1 and (action like 'identity_vault.access%' or action = 'identity_vault.decrypted') order by created_at asc;",
        [identityRefId],
      );
      const acciones = auditoria.map((r) => r.action);
      expect(acciones).toEqual(
        expect.arrayContaining(["identity_vault.access_requested", "identity_vault.access_approved", "identity_vault.decrypted"]),
      );
      const decrypted = auditoria.find((r) => r.action === "identity_vault.decrypted")!;
      expect(String((decrypted.payload as { reason: string }).reason)).toMatch(/autoridad migratoria/);
    });

    it("solicitud rechazada por la segunda persona: nunca puede exponerse el documento", async () => {
      const identityRefId = await registrarIdentidad(8);
      const solicitud = await solicitar(identityRefId, gmToken, "motivo cualquiera pero suficientemente largo");
      const { id: requestId } = (await solicitud.json()) as { id: string };

      const rechazo = await decidir(requestId, ownerToken, "rechazar");
      expect(rechazo.status).toBe(200);
      expect(((await rechazo.json()) as { estado: string }).estado).toBe("rechazada");

      const intentoExponer = await exponer(requestId, gmToken);
      expect(intentoExponer.status).toBe(409);
    });
  });

  it("retención ≤30 días post-checkout con purga automática (t=31 días → 0 filas restantes; t=10 días → conservada)", async () => {
    const reservationVencida = await crearReservaConfirmada(9);
    const reservationVigente = await crearReservaConfirmada(10);

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
