// REQ-CRM-002 (P1/F) · clasificación automática de reseñas/encuestas por tema y
// sentimiento, disparando la acción correspondiente (ticket, mensaje proactivo,
// compensación reglada) -- contra la app real y `embedded-postgres` (ADR-003), nunca
// contra un mock. Incluye el caso explícito del criterio de aceptación: "un tema local
// nuevo → clasificado y acción disparada".
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

describe("clasificación temática de reseñas (REQ-CRM-002)", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let frontdeskToken: string;
  let housekeepingToken: string;
  let accountantToken: string;
  let hotelId: string;
  let roomTypeId: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    roomTypeId = hotelA.roomTypes[0]!.id;
    gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);
    frontdeskToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "frontdesk")!.email);
    housekeepingToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "housekeeping")!.email);
    accountantToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "accountant")!.email);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  function auth(token: string) {
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
  }

  let siguienteOffsetDias = 1;
  function isoDate(daysFromNow: number): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + daysFromNow);
    return d.toISOString().slice(0, 10);
  }

  async function crearHuesped(): Promise<string> {
    const res = await fixture.app.request(`/hoteles/${hotelId}/huespedes`, {
      method: "POST",
      headers: auth(gmToken),
      body: JSON.stringify({ nombre: `Huésped de prueba ${crypto.randomUUID()}` }),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    return id;
  }

  /** Crea una reservación (opcionalmente con huésped) y la transiciona al estado
   *  pedido -- devuelve `reservationId`. */
  async function crearReserva(status: "confirmada" | "en_estancia" | "check_out", guestId?: string): Promise<string> {
    const checkInDate = isoDate(siguienteOffsetDias);
    const checkOutDate = isoDate(siguienteOffsetDias + 2);
    siguienteOffsetDias += 2;

    const created = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { ...auth(gmToken), "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ roomTypeId, checkInDate, checkOutDate, guestId: guestId ?? null }),
    });
    expect(created.status).toBe(201);
    const { id: reservationId } = (await created.json()) as { id: string };

    // La máquina de estados real (reservationStateMachine.ts + trigger de Postgres,
    // migrations/0006) exige la cadena completa confirmada -> check_in -> en_estancia
    // -> check_out, nunca un salto directo -- nunca se salta un paso aquí.
    const cadena: Record<typeof status, ("confirmada" | "check_in" | "en_estancia" | "check_out")[]> = {
      confirmada: ["confirmada"],
      en_estancia: ["confirmada", "check_in", "en_estancia"],
      check_out: ["confirmada", "check_in", "en_estancia", "check_out"],
    };
    for (const toStatus of cadena[status]) {
      const t = await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationId}/transicion`, {
        method: "PATCH",
        headers: auth(gmToken),
        body: JSON.stringify({ toStatus }),
      });
      expect(t.status).toBe(200);
    }
    return reservationId;
  }

  async function clasificar(body: Record<string, unknown>, token: string = frontdeskToken) {
    return fixture.app.request(`/hoteles/${hotelId}/reputacion/resenas`, {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify(body),
    });
  }

  interface AccionBody {
    id: string;
    tipo: string;
    estado: string;
    ticketId: string | null;
    detalle: Record<string, unknown>;
    razon: string;
  }
  interface ClasificacionBody {
    id: string;
    yaExistente: boolean;
    temas: { topic: string; esConocido: boolean; menciones: number }[];
    sentimiento: string;
    puntajeSentimiento: number;
    acciones: AccionBody[];
  }

  // ---------------------------------------------------------------------------
  // 1) Tema conocido reparable -> ticket de mantenimiento REAL.
  // ---------------------------------------------------------------------------
  it("una reseña negativa sobre wifi crea un ticket de mantenimiento real (persistido en maintenance_ticket)", async () => {
    const res = await clasificar({
      fuente: "encuesta_propia",
      texto: "El wifi del hotel nunca funcionó durante toda la estancia, muy mal servicio.",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as ClasificacionBody;

    expect(body.temas.some((t) => t.topic === "wifi")).toBe(true);
    expect(["negativo", "muy_negativo"]).toContain(body.sentimiento);

    const ticket = body.acciones.find((a) => a.tipo === "ticket_mantenimiento");
    expect(ticket).toBeDefined();
    expect(ticket?.estado).toBe("ejecutada");
    expect(ticket?.ticketId).toBeTruthy();

    const { rows } = await fixture.engine.admin.query<{ title: string; origin: string; hotel_id: string }>(
      "select title, origin::text as origin, hotel_id::text as hotel_id from public.maintenance_ticket where id = $1;",
      [ticket!.ticketId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.origin).toBe("huesped");
    expect(rows[0]!.hotel_id).toBe(hotelId);
  });

  // ---------------------------------------------------------------------------
  // 2) Tema LOCAL NO ENTRENADO PREVIAMENTE -> clasificado y acción disparada
  //    (caso explícito de docs/ACEPTACION.md para REQ-CRM-002).
  // ---------------------------------------------------------------------------
  it("un tema local nuevo (nunca antes en ningún diccionario) se clasifica y dispara la acción correspondiente", async () => {
    const guestId = await crearHuesped();
    const reservationId = await crearReserva("en_estancia", guestId);

    // "cucarachas" no existe en ningún diccionario de temas del clasificador.
    const res = await clasificar({
      fuente: "encuesta_propia",
      texto: "Vimos cucarachas en el baño de la habitación, es terrible y asqueroso.",
      huespedId: guestId,
      reservaId: reservationId,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as ClasificacionBody;

    const temaLocal = body.temas.find((t) => t.topic === "local:cucarachas");
    expect(temaLocal).toBeDefined();
    expect(temaLocal?.esConocido).toBe(false);
    expect(body.sentimiento).toBe("muy_negativo");

    // Huésped identificado y en estancia con sentimiento muy negativo -> mensaje
    // proactivo disparado (persistido pendiente de envío humano, ver comentario de
    // routes/reputacion.ts).
    const mensaje = body.acciones.find((a) => a.tipo === "mensaje_proactivo");
    expect(mensaje).toBeDefined();
    expect(mensaje?.estado).toBe("pendiente");

    const { rows } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.guest_review_action where id = $1 and status = 'pendiente';",
      [mensaje!.id],
    );
    expect(rows[0]!.count).toBe("1");
  });

  // ---------------------------------------------------------------------------
  // 3) Compensación reglada (tema del catálogo + muy_negativo + huésped identificado).
  // ---------------------------------------------------------------------------
  it("sargazo muy_negativo con huésped identificado dispara compensacion_reglada con el valor exacto del catálogo", async () => {
    const guestId = await crearHuesped();
    const reservationId = await crearReserva("check_out", guestId);

    const res = await clasificar({
      fuente: "tripadvisor",
      externalId: `ta-${crypto.randomUUID()}`,
      texto: "Demasiado sargazo en la playa, no se podía ni entrar al mar, pésima experiencia.",
      huespedId: guestId,
      reservaId: reservationId,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as ClasificacionBody;

    expect(body.temas.some((t) => t.topic === "sargazo")).toBe(true);
    expect(body.sentimiento).toBe("muy_negativo");

    const compensacion = body.acciones.find((a) => a.tipo === "compensacion_reglada");
    expect(compensacion).toBeDefined();
    expect(compensacion?.estado).toBe("pendiente");
    expect(compensacion?.detalle).toMatchObject({
      tema: "sargazo",
      compensacion: { tipo: "credito_fnb", valor: 300, unidad: "monto_mxn" },
    });
  });

  // ---------------------------------------------------------------------------
  // 4) Sin huésped identificado: la compensación/mensaje NUNCA se disparan.
  // ---------------------------------------------------------------------------
  it("una reseña pública sin huésped identificado solo dispara el ticket, nunca mensaje ni compensación", async () => {
    const res = await clasificar({
      fuente: "google",
      externalId: `g-${crypto.randomUUID()}`,
      texto: "El aire acondicionado estaba descompuesto, hacía muchísimo calor, terrible.",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as ClasificacionBody;

    expect(body.acciones.some((a) => a.tipo === "ticket_mantenimiento")).toBe(true);
    expect(body.acciones.some((a) => a.tipo === "mensaje_proactivo")).toBe(false);
    expect(body.acciones.some((a) => a.tipo === "compensacion_reglada")).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 5) Idempotencia de ingesta: la MISMA reseña externa nunca se re-clasifica ni
  //    re-dispara sus acciones dos veces.
  // ---------------------------------------------------------------------------
  it("re-enviar la misma reseña externa (mismo source+externalId) no duplica el ticket ni la clasificación", async () => {
    const externalId = `booking-${crypto.randomUUID()}`;
    const payload = { fuente: "booking", externalId, texto: "El cuarto estaba sucio, muy mala limpieza." };

    const primera = await clasificar(payload);
    expect(primera.status).toBe(201);
    const primeraBody = (await primera.json()) as ClasificacionBody;
    expect(primeraBody.yaExistente).toBe(false);
    const ticketId = primeraBody.acciones.find((a) => a.tipo === "ticket_mantenimiento")?.ticketId;
    expect(ticketId).toBeTruthy();

    const segunda = await clasificar(payload);
    expect(segunda.status).toBe(200);
    const segundaBody = (await segunda.json()) as ClasificacionBody;
    expect(segundaBody.yaExistente).toBe(true);
    expect(segundaBody.id).toBe(primeraBody.id);
    expect(segundaBody.acciones.find((a) => a.tipo === "ticket_mantenimiento")?.ticketId).toBe(ticketId);

    const { rows } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.guest_review where hotel_id = $1 and source = 'booking' and external_id = $2;",
      [hotelId, externalId],
    );
    expect(rows[0]!.count).toBe("1");
  });

  // ---------------------------------------------------------------------------
  // 6) Reseña positiva: ninguna acción.
  // ---------------------------------------------------------------------------
  it("una reseña positiva no dispara ninguna acción", async () => {
    const res = await clasificar({
      fuente: "encuesta_propia",
      texto: "Todo excelente, el personal fue increíble y el desayuno delicioso.",
      calificacion: 5,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as ClasificacionBody;
    expect(["positivo", "muy_positivo"]).toContain(body.sentimiento);
    expect(body.acciones).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 7) Listado + resolución de una acción pendiente.
  // ---------------------------------------------------------------------------
  it("GET lista la reseña con sus acciones, y PATCH resuelve una acción pendiente", async () => {
    const guestId = await crearHuesped();
    const reservationId = await crearReserva("en_estancia", guestId);
    const clasificacion = await clasificar({
      fuente: "encuesta_propia",
      texto: "Hay mucho ruido de los vecinos, no puedo dormir, pésimo.",
      huespedId: guestId,
      reservaId: reservationId,
    });
    const body = (await clasificacion.json()) as ClasificacionBody;
    const mensaje = body.acciones.find((a) => a.tipo === "mensaje_proactivo");
    expect(mensaje).toBeDefined();

    const listado = await fixture.app.request(`/hoteles/${hotelId}/reputacion/resenas`, { headers: auth(accountantToken) });
    expect(listado.status).toBe(200);
    const resenas = (await listado.json()) as { id: string; acciones: AccionBody[] }[];
    const encontrada = resenas.find((r) => r.id === body.id);
    expect(encontrada).toBeDefined();
    expect(encontrada?.acciones.some((a) => a.id === mensaje!.id)).toBe(true);

    const resolver = await fixture.app.request(`/hoteles/${hotelId}/reputacion/acciones/${mensaje!.id}`, {
      method: "PATCH",
      headers: auth(gmToken),
      body: JSON.stringify({ estado: "ejecutada" }),
    });
    expect(resolver.status).toBe(200);
    const resuelto = (await resolver.json()) as { id: string; estado: string };
    expect(resuelto.estado).toBe("ejecutada");

    // Volver a resolver la misma acción ya resuelta -> 404 (no hay pendiente que resolver).
    const segundaResolucion = await fixture.app.request(`/hoteles/${hotelId}/reputacion/acciones/${mensaje!.id}`, {
      method: "PATCH",
      headers: auth(gmToken),
      body: JSON.stringify({ estado: "ejecutada" }),
    });
    expect(segundaResolucion.status).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // 8) Control de acceso por rol.
  // ---------------------------------------------------------------------------
  describe("control de acceso por rol", () => {
    it("housekeeping NO puede clasificar una reseña (403)", async () => {
      const res = await clasificar({ fuente: "encuesta_propia", texto: "Todo bien." }, housekeepingToken);
      expect(res.status).toBe(403);
    });

    it("housekeeping NO puede listar reseñas (403), pero accountant sí", async () => {
      const listHk = await fixture.app.request(`/hoteles/${hotelId}/reputacion/resenas`, { headers: auth(housekeepingToken) });
      expect(listHk.status).toBe(403);

      const listAccountant = await fixture.app.request(`/hoteles/${hotelId}/reputacion/resenas`, { headers: auth(accountantToken) });
      expect(listAccountant.status).toBe(200);
    });

    it("frontdesk NO puede resolver una acción (solo owner/gm/accountant, compensación es dinero)", async () => {
      const res = await clasificar({
        fuente: "encuesta_propia",
        texto: "El wifi no sirvió, muy mal.",
      });
      const body = (await res.json()) as ClasificacionBody;
      const ticket = body.acciones.find((a) => a.tipo === "ticket_mantenimiento")!;

      // El ticket ya quedó 'ejecutada' al crearse, así que se prueba el 403 con el
      // intento de un rol no autorizado (frontdesk) contra ESE registro.
      const resolver = await fixture.app.request(`/hoteles/${hotelId}/reputacion/acciones/${ticket.id}`, {
        method: "PATCH",
        headers: auth(frontdeskToken),
        body: JSON.stringify({ estado: "descartada" }),
      });
      expect(resolver.status).toBe(403);
    });
  });
});
