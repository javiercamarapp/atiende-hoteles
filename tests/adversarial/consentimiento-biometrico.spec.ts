// REQ-HUE-022/REQ-SEG-003 · "El check-in online no debe usar reconocimiento facial;
// cualquier dato biométrico requiere consentimiento explícito y diferenciado, separado
// del aviso general" (verificado: flujo sin ese consentimiento → dato biométrico no se
// persiste).
//
// Estado real del flujo (apps/api/src/routes/checkinOnline.ts,
// packages/db/migrations/0054_checkin_online.sql): captura documento (MRZ, cifrado en
// bóveda), firma de registro y ETA/RFC -- CERO reconocimiento facial, y el único
// consentimiento que existe (`consent_kind` = 'tratamiento_datos', migración 0068) es
// el aviso general de privacidad, nunca uno diferenciado de biometría (ese tipo de
// consentimiento no existe en el enum porque no hay ninguna captura biométrica que
// gatear -- ver auditoria-2/legal.md: "búsqueda exhaustiva ... no encontró ningún
// código relacionado").
//
// Este archivo NO prueba una función que no existe ("consentimiento biométrico
// diferenciado") -- prueba el invariante real que el criterio de aceptación exige:
// un atacante que intenta colar un campo de captura biométrica (plantilla facial,
// huella, vector de reconocimiento) en el body del check-in público, SIN que exista
// (ni pueda existir) un consentimiento diferenciado para ese dato, NUNCA logra que
// ese dato quede persistido en ninguna tabla -- ni siquiera cuando el check-in se
// completa con éxito usando solo el aviso general. La prueba de reconocimiento facial
// en código (0 uso) vive en `scripts/checks/no-biometria-facial.ts`, ejecutado junto a
// este archivo por el comando de aceptación (ver docs/ACEPTACION.md, REQ-HUE-022).
import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, crearFolioConfirmado, destroyApiFixture, loginAs, type ApiFixture } from "../support/api-fixture.ts";

describe("REQ-HUE-022/REQ-SEG-003: consentimiento diferenciado de dato biométrico en check-in online", () => {
  let fixture: ApiFixture;

  beforeAll(async () => {
    fixture = await createApiFixture();
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  function d(offsetDays: number): string {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + offsetDays);
    return date.toISOString().slice(0, 10);
  }

  async function emitirEnlace(offsetDays: number): Promise<{ token: string; reservationId: string; hotelId: string }> {
    const hotelA = fixture.seed.hotels[0]!;
    const gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);
    const { reservationId } = await crearFolioConfirmado(fixture.app, gmToken, hotelA.id, {
      roomTypeId: hotelA.roomTypes[0]!.id,
      checkInDate: d(offsetDays),
      checkOutDate: d(offsetDays + 1),
    });
    const emitir = await fixture.app.request(`/hoteles/${hotelA.id}/reservas/${reservationId}/checkin-link`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}` },
    });
    expect(emitir.status).toBe(201);
    const { token } = (await emitir.json()) as { token: string };
    return { token, reservationId, hotelId: hotelA.id };
  }

  async function mrzValida(documentNumber: string, surname: string) {
    const { buildPassportMrz } = await import("../../packages/domain-hotel/src/mrz.ts");
    return buildPassportMrz({
      countryCode: "MEX",
      surname,
      givenNames: "PRUEBA",
      documentNumber,
      nationality: "MEX",
      birthDateYyMmDd: "900101",
      sex: "F",
      expiryDateYyMmDd: "320101",
    });
  }

  /** Busca `marker` como subcadena en TODAS las columnas de texto/jsonb de las tablas
   *  que el check-in online podría llegar a tocar -- guest (datos del huésped),
   *  checkin_submission (lo que realmente escribe `complete_checkin_public`),
   *  identity_ref (referencia segura de identidad, expuesta al resto del sistema),
   *  consent (registro de consentimiento) y audit_log (bitácora, incluye el payload
   *  jsonb del evento `checkin_online.completed`). Devuelve el conteo total de filas
   *  que contienen `marker` en cualquiera de esas columnas -- 0 significa "no se
   *  persistió en ningún lugar buscable". */
  async function contarCoincidencias(engine: ApiFixture["engine"], marker: string): Promise<Record<string, number>> {
    const consultas: Record<string, string> = {
      guest: `select count(*)::int as n from public.guest
              where full_name ilike $1 or coalesce(email, '') ilike $1 or coalesce(phone, '') ilike $1`,
      checkin_submission: `select count(*)::int as n from public.checkin_submission
              where coalesce(rfc, '') ilike $1 or signature_data_url ilike $1`,
      identity_ref: `select count(*)::int as n from public.identity_ref
              where full_name ilike $1 or nationality ilike $1 or document_type ilike $1 or document_last4 ilike $1`,
      consent: `select count(*)::int as n from public.consent
              where aviso_version ilike $1 or channel::text ilike $1 or consent_kind::text ilike $1`,
      audit_log: `select count(*)::int as n from public.audit_log
              where payload::text ilike $1 or action ilike $1 or entity_type ilike $1`,
    };
    const resultado: Record<string, number> = {};
    for (const [tabla, sql] of Object.entries(consultas)) {
      const { rows } = await engine.admin.query<{ n: number }>(sql, [`%${marker}%`]);
      resultado[tabla] = rows[0]!.n;
    }
    return resultado;
  }

  function totalCoincidencias(mapa: Record<string, number>): number {
    return Object.values(mapa).reduce((a, b) => a + b, 0);
  }

  /** Genera un RFC con formato VÁLIDO (`RFC_PATTERN` de checkinOnline.ts: 3-4 letras +
   *  6 dígitos + 3 alfanuméricos) pero con un sufijo aleatorio único, para poder usarlo
   *  como marcador buscable en el control positivo sin que la validación de esquema lo
   *  rechace. */
  function rfcValidoUnico(): string {
    const digits = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const suffix = randomUUID().replace(/[^A-Z0-9]/gi, "").toUpperCase().slice(0, 3).padEnd(3, "X");
    return `ABC${digits}${suffix}`;
  }

  it("control positivo: la búsqueda SÍ encuentra un valor real persistido (RFC legítimo en checkin_submission) -- confirma que el mecanismo de búsqueda funciona, para que un '0' más abajo no sea un falso negativo por una query rota", async () => {
    const { token } = await emitirEnlace(1);
    const rfcLegitimo = rfcValidoUnico();
    const mrz = await mrzValida("A1234567", "CONTROL POSITIVO");

    const completar = await fixture.app.request(`/checkin-publico/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nombreCompleto: "Control Positivo Prueba",
        firmaDataUrl: "data:image/png;base64,AAAA",
        mrzLine1: mrz.line1,
        mrzLine2: mrz.line2,
        rfc: rfcLegitimo,
        consentimientoAvisoPrivacidad: true,
      }),
    });
    expect(completar.status).toBe(201);

    const coincidencias = await contarCoincidencias(fixture.engine, rfcLegitimo);
    expect(coincidencias.checkin_submission).toBeGreaterThanOrEqual(1);
  });

  it("un intento de colar captura biométrica (plantilla facial / huella / vector de reconocimiento) en el body del check-in público NO queda persistido en ninguna tabla, aun cuando el check-in se completa con éxito usando SOLO el aviso general de privacidad (no existe ni se pide un consentimiento biométrico diferenciado)", async () => {
    const { token, reservationId } = await emitirEnlace(3);
    const marker = `BIOMETRIC-MARKER-${randomUUID()}`;
    const mrz = await mrzValida("B2222222", "SIN CONSENTIMIENTO BIOMETRICO");

    // El body sólo declara `consentimientoAvisoPrivacidad` (el aviso GENERAL, único
    // que existe hoy) -- nunca un campo de consentimiento biométrico diferenciado,
    // porque ese consentimiento no existe en el esquema (consent_kind sólo admite
    // 'tratamiento_datos'/'marketing', ver más abajo). Los campos adicionales simulan
    // a un atacante (o a un cliente comprometido) intentando colar dato biométrico de
    // todas formas.
    const completar = await fixture.app.request(`/checkin-publico/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nombreCompleto: "Huesped Con Intento Biometrico",
        firmaDataUrl: "data:image/png;base64,AAAA",
        mrzLine1: mrz.line1,
        mrzLine2: mrz.line2,
        consentimientoAvisoPrivacidad: true,
        // -- campos NO declarados en el esquema Zod de completarSchema: deben ser
        // ignorados por completo (zod no-strict) y jamás llegar a la base de datos.
        datoBiometricoFacial: marker,
        plantillaFacial: marker,
        vectorReconocimientoFacial: marker,
        huellaDactilarBase64: marker,
        identificadorBiometrico: marker,
        biometricTemplate: marker,
        faceEmbedding: marker,
        consentimientoBiometricoDiferenciado: true, // ni siquiera esto existe -- se ignora igual
      }),
    });
    // El check-in se completa con éxito: la ÚNICA razón por la que puede completarse
    // sin consentimiento biométrico diferenciado es que estructuralmente NO captura
    // ningún dato biométrico -- si lo hiciera, completarse sin ese consentimiento
    // sería exactamente el incumplimiento que este test busca atrapar.
    expect(completar.status).toBe(201);

    const coincidencias = await contarCoincidencias(fixture.engine, marker);
    expect(totalCoincidencias(coincidencias)).toBe(0);

    // Defensa adicional a nivel de base de datos: `complete_checkin_public` (0054) es
    // el ÚNICO punto de escritura del check-in online y recibe 13 parámetros
    // posicionales fijos -- ninguno es "dato biométrico". Se confirma aquí que la
    // firma real de la función en la base sigue siendo esa (si alguien le agregara un
    // parámetro biométrico sin pasar por este test, el conteo cambiaría).
    const { rows: fnRows } = await fixture.engine.admin.query<{ nargs: number }>(
      `select pronargs::int as nargs from pg_proc where proname = 'complete_checkin_public'`,
    );
    expect(fnRows[0]!.nargs).toBe(13);

    // El registro de consentimiento de ESTA reserva es únicamente 'tratamiento_datos'
    // (el aviso general) -- nunca un tipo de consentimiento biométrico, porque ese
    // tipo no existe.
    const { rows: consentRows } = await fixture.engine.admin.query<{ consent_kind: string }>(
      `select consent_kind::text as consent_kind from public.consent where reservation_id = $1`,
      [reservationId],
    );
    expect(consentRows.length).toBeGreaterThanOrEqual(1);
    for (const row of consentRows) {
      expect(row.consent_kind).toBe("tratamiento_datos");
    }
  });

  it("el esquema no tiene (ni permite registrar) un consentimiento diferenciado de biometría: consent_kind sólo admite 'tratamiento_datos'/'marketing'/'contacto_real_ota'/'ugc' -- consistente con que este flujo nunca captura dato biométrico alguno que necesitaría uno", async () => {
    const { rows } = await fixture.engine.admin.query<{ enumlabel: string }>(
      `select e.enumlabel from pg_enum e
       join pg_type t on t.oid = e.enumtypid
       where t.typname = 'consent_kind'
       order by e.enumsortorder`,
    );
    const labels = rows.map((r) => r.enumlabel).sort();
    // REQ-RES-018 (migración 0133) agregó 'contacto_real_ota' -- consentimiento
    // explícito de REVELAR el contacto real cuando una OTA lo enmascaraba, tan poco
    // biométrico como 'marketing'/'tratamiento_datos'. REQ-CRM-010 (migración 0148)
    // agregó 'ugc' -- consentimiento de USO de contenido generado por el huésped
    // (foto/video en publicaciones del hotel), igual de no-biométrico: es un permiso
    // sobre contenido que el huésped mandó voluntariamente, nunca una plantilla facial/
    // huella/vector de reconocimiento capturado del cuerpo del huésped. Este test sigue
    // verificando lo mismo de siempre: que NINGÚN valor del enum sea un consentimiento
    // de biometría.
    expect(labels).toEqual(["contacto_real_ota", "marketing", "tratamiento_datos", "ugc"]);
  });

  it("`documentImageBase64` (foto del documento, declarada RECIBIDA-Y-DESCARTADA en el propio esquema) se descarta de verdad: no aparece en ninguna tabla tras completar el check-in", async () => {
    const { token } = await emitirEnlace(5);
    const marker = `DOC-IMAGE-MARKER-${randomUUID()}`;
    const mrz = await mrzValida("C3333333", "FOTO DESCARTADA");

    const completar = await fixture.app.request(`/checkin-publico/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nombreCompleto: "Huesped Foto Descartada",
        firmaDataUrl: "data:image/png;base64,AAAA",
        mrzLine1: mrz.line1,
        mrzLine2: mrz.line2,
        documentImageBase64: marker,
        consentimientoAvisoPrivacidad: true,
      }),
    });
    expect(completar.status).toBe(201);

    const coincidencias = await contarCoincidencias(fixture.engine, marker);
    expect(totalCoincidencias(coincidencias)).toBe(0);
  });

  it("completar el check-in SIN aceptar ni siquiera el aviso general de privacidad es rechazado (400) -- el aviso general sigue siendo obligatorio aunque no exista captura biométrica", async () => {
    const { token } = await emitirEnlace(7);
    const mrz = await mrzValida("D4444444", "SIN AVISO GENERAL");

    const completar = await fixture.app.request(`/checkin-publico/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nombreCompleto: "Huesped Sin Aviso",
        firmaDataUrl: "data:image/png;base64,AAAA",
        mrzLine1: mrz.line1,
        mrzLine2: mrz.line2,
        // consentimientoAvisoPrivacidad omitido a propósito
      }),
    });
    expect(completar.status).toBe(400);
  });
});
