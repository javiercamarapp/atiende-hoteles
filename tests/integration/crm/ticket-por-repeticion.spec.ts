// REQ-CRM-003 (P1/F): "El sistema debe generar automáticamente un ticket de
// mantenimiento cuando se acumulan N menciones negativas del mismo tema en una
// ventana de tiempo definida (p.ej. 3 en 14 días)." Contra la app real y
// `embedded-postgres` (ADR-003), nunca contra un mock. Cubre el caso literal de
// docs/ACEPTACION.md: "verificado con N y N-1 menciones".
//
// Elección de tema para los casos principales: "personal" (fuera de `TICKET_TOPICS`
// de REQ-CRM-002) -- una sola mención negativa de "personal" NUNCA crea un ticket por
// sí sola (ver reputacion-clasificador.spec.ts), así que cualquier ticket que aparezca
// en estas pruebas solo puede venir de la acumulación de REQ-CRM-003, aislando el
// comportamiento nuevo del de REQ-CRM-002.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

describe("ticket automático por acumulación de reseñas negativas (REQ-CRM-003)", () => {
  let fixture: ApiFixture;
  let frontdeskToken: string;
  let hotelId: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    frontdeskToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "frontdesk")!.email);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  function auth(token: string) {
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
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
    acciones: AccionBody[];
  }

  async function clasificar(texto: string): Promise<ClasificacionBody> {
    const res = await fixture.app.request(`/hoteles/${hotelId}/reputacion/resenas`, {
      method: "POST",
      headers: auth(frontdeskToken),
      body: JSON.stringify({ fuente: "encuesta_propia", texto }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as ClasificacionBody;
  }

  function accionesTicketAcumulacion(body: ClasificacionBody, tema: string): AccionBody[] {
    return body.acciones.filter(
      (a) => a.tipo === "ticket_mantenimiento" && a.detalle.tema === tema && String(a.razon).includes("REQ-CRM-003"),
    );
  }

  // ---------------------------------------------------------------------------
  // 1) N-1 menciones (2 de 3) del mismo tema (fuera de TICKET_TOPICS) NO disparan
  //    ticket -- ni por REQ-CRM-002 (el tema no está en TICKET_TOPICS) ni por
  //    REQ-CRM-003 (el umbral default es 3).
  // ---------------------------------------------------------------------------
  it("2 menciones negativas de 'personal' (N-1, umbral=3) no generan ningún ticket", async () => {
    const r1 = await clasificar("El personal fue muy grosero con nosotros, pésimo trato en la recepción.");
    expect(r1.temas.some((t) => t.topic === "personal")).toBe(true);
    expect(["negativo", "muy_negativo"]).toContain(r1.sentimiento);
    expect(r1.acciones.some((a) => a.tipo === "ticket_mantenimiento")).toBe(false);

    const r2 = await clasificar("El trato del personal fue grosero y descortés otra vez, terrible experiencia.");
    expect(r2.temas.some((t) => t.topic === "personal")).toBe(true);
    // 2 menciones < umbral 3 -- todavía no acumula lo suficiente.
    expect(accionesTicketAcumulacion(r2, "personal")).toHaveLength(0);
    expect(r2.acciones.some((a) => a.tipo === "ticket_mantenimiento")).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 2) La 3ra mención negativa del MISMO tema (N, umbral=3) SÍ dispara el ticket
  //    automático por acumulación -- caso literal de docs/ACEPTACION.md.
  // ---------------------------------------------------------------------------
  it("la 3ra mención negativa de 'personal' (N=3) dispara un ticket automático por acumulación", async () => {
    const r3 = await clasificar("Otra vez el personal grosero, de muy mal trato con los huéspedes, una pesadilla.");
    expect(r3.temas.some((t) => t.topic === "personal")).toBe(true);

    const ticketsAcumulacion = accionesTicketAcumulacion(r3, "personal");
    expect(ticketsAcumulacion).toHaveLength(1);
    const ticket = ticketsAcumulacion[0]!;
    expect(ticket.estado).toBe("ejecutada");
    expect(ticket.ticketId).toBeTruthy();

    // El ticket está persistido de verdad en maintenance_ticket, no solo en la
    // respuesta HTTP.
    const { rows } = await fixture.engine.admin.query<{ title: string; origin: string; hotel_id: string }>(
      "select title, origin::text as origin, hotel_id::text as hotel_id from public.maintenance_ticket where id = $1;",
      [ticket.ticketId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toContain("personal");
    expect(rows[0]!.hotel_id).toBe(hotelId);
  });

  // ---------------------------------------------------------------------------
  // 3) Una 4ta mención negativa del mismo tema, con el ticket de acumulación ya
  //    creado y todavía vigente (dentro de la ventana), NUNCA duplica el ticket.
  // ---------------------------------------------------------------------------
  it("una 4ta mención de 'personal' no duplica el ticket ya disparado por la acumulación", async () => {
    const r4 = await clasificar("El personal sigue siendo grosero y de mal trato, cuarta vez que nos pasa.");
    expect(r4.temas.some((t) => t.topic === "personal")).toBe(true);
    expect(accionesTicketAcumulacion(r4, "personal")).toHaveLength(0);

    // Sigue existiendo UN SOLO ticket de mantenimiento abierto por acumulación para
    // "personal" en toda la base -- no dos.
    const { rows } = await fixture.engine.admin.query<{ count: string }>(
      `select count(*)::text as count
       from public.guest_review_action
       where hotel_id = $1 and action_type = 'ticket_mantenimiento' and detail->>'tema' = 'personal';`,
      [hotelId],
    );
    expect(rows[0]!.count).toBe("1");
  });

  // ---------------------------------------------------------------------------
  // 4) Menciones POSITIVAS del mismo tema nunca cuentan para la acumulación.
  // ---------------------------------------------------------------------------
  it("menciones positivas de un tema no acumulan hacia el umbral de ticket automático", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await clasificar(`El desayuno estuvo increíble y delicioso, personal ${i} de 3 excelente y muy amable.`);
      expect(r.acciones.some((a) => a.tipo === "ticket_mantenimiento")).toBe(false);
    }
  });

  // ---------------------------------------------------------------------------
  // 5) Un tema de TICKET_TOPICS (REQ-CRM-002, p.ej. "ruido") ya crea un ticket en la
  //    PRIMERA mención negativa -- la acumulación de REQ-CRM-003 nunca duplica ese
  //    ticket en reseñas subsecuentes del mismo tema dentro de la ventana.
  // ---------------------------------------------------------------------------
  it("un tema de TICKET_TOPICS ya ticketeado individualmente nunca recibe un segundo ticket por acumulación", async () => {
    const r1 = await clasificar("Mucho ruido de los vecinos toda la noche, no se puede dormir, terrible.");
    const ticketRuidoR1 = r1.acciones.find((a) => a.tipo === "ticket_mantenimiento" && a.detalle.tema === "ruido");
    expect(ticketRuidoR1).toBeDefined(); // ticket inmediato de REQ-CRM-002.
    expect(accionesTicketAcumulacion(r1, "ruido")).toHaveLength(0); // nunca DOS tickets en la misma reseña.

    const r2 = await clasificar("Otra vez mucho ruido en la noche, pésimo, no se puede descansar.");
    expect(accionesTicketAcumulacion(r2, "ruido")).toHaveLength(0);

    const r3 = await clasificar("El ruido de los vecinos sigue siendo terrible, tercera noche sin dormir.");
    expect(accionesTicketAcumulacion(r3, "ruido")).toHaveLength(0);
  });
});
