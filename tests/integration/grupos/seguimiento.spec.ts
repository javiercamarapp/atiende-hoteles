// REQ-RES-013 (docs/ACEPTACION.md, fila exacta): "Solicitud de grupo sin respuesta
// recibe seguimiento automático a las 48h y a los 7 días; ninguna propuesta de RFP sale
// sin un registro de validación humana previa (0 propuestas sin ese registro)." Contra
// embedded-postgres real (ADR-003), de punta a punta: crea la solicitud por la API real
// (`POST /hoteles/:hotelId/grupos`, `routes/grupos.ts`), ejercita el job de seguimiento
// (`runGroupFollowUps`, `apps/api/src/jobs/seguimientoSolicitudGrupo.ts`) con reloj
// simulado avanzando exactamente a las ventanas de 48h/7 días, y el flujo completo de
// validación humana → propuesta de RFP (`POST .../validaciones` → `POST .../propuestas`).
// El bypass adversarial directo del trigger de Postgres (`propuesta_rfp_guard`, 0130)
// vive en `tests/adversarial/propuesta-rfp-sin-validacion.spec.ts`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";
import { runGroupFollowUps } from "../../../apps/api/src/jobs/seguimientoSolicitudGrupo.ts";
import { FakeWhatsappAdapter } from "@atiende-hoteles/mcp-whatsapp";

interface SolicitudResponse {
  id: string;
  estado: string;
  creadaEn: string;
  seguimientos: { id: string; tipo: "48h" | "7d"; programadoPara: string; ejecutadoEn: string | null }[];
}

describe("REQ-RES-013: seguimiento automático de solicitudes de grupo (48h/7d) + gate de validación humana para RFP", () => {
  let fixture: ApiFixture;
  let reservationsToken: string;
  let hotelId: string;
  let tenantId: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    tenantId = fixture.seed.orgId;
    reservationsToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "reservations")!.email);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  const auth = () => ({ authorization: `Bearer ${reservationsToken}`, "content-type": "application/json" });

  async function crearSolicitud(descripcion: string): Promise<SolicitudResponse> {
    const res = await fixture.app.request(`/hoteles/${hotelId}/grupos`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        organizadorNombre: "Congreso Nacional de Turismo A.C.",
        organizadorTelefono: "+525512345678",
        organizadorEmail: "organizador@congreso.test",
        descripcion,
      }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as SolicitudResponse;
  }

  it("al crear la solicitud, programa EXACTAMENTE 2 seguimientos: a las 48h y a los 7 días de su creación", async () => {
    const before = Date.now();
    const solicitud = await crearSolicitud("Bloque de 40 habitaciones para congreso, marzo 2027.");
    const after = Date.now();

    expect(solicitud.estado).toBe("pendiente");
    expect(solicitud.seguimientos).toHaveLength(2);

    const creadaEnMs = new Date(solicitud.creadaEn).getTime();
    expect(creadaEnMs).toBeGreaterThanOrEqual(before);
    expect(creadaEnMs).toBeLessThanOrEqual(after);

    const s48 = solicitud.seguimientos.find((s) => s.tipo === "48h")!;
    const s7d = solicitud.seguimientos.find((s) => s.tipo === "7d")!;
    expect(s48.ejecutadoEn).toBeNull();
    expect(s7d.ejecutadoEn).toBeNull();
    expect(new Date(s48.programadoPara).getTime() - creadaEnMs).toBe(48 * 60 * 60 * 1000);
    expect(new Date(s7d.programadoPara).getTime() - creadaEnMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("no envía ningún seguimiento antes de que se cumpla la ventana de 48h", async () => {
    const solicitud = await crearSolicitud("Boda, 15 habitaciones, junio 2027.");
    const creadaEnMs = new Date(solicitud.creadaEn).getTime();
    const fake = new FakeWhatsappAdapter();

    const result = await runGroupFollowUps(
      fixture.engine.admin,
      { hotelId, tenantId },
      { now: () => new Date(creadaEnMs + 47 * 60 * 60 * 1000), messagingPort: fake },
    );

    expect(result.ejecutados.filter((e) => e.solicitudId === solicitud.id)).toHaveLength(0);
  });

  it("envía el seguimiento de 48h en cuanto se cumple la ventana, y es idempotente (una segunda corrida no lo reenvía)", async () => {
    const solicitud = await crearSolicitud("Tour operador, 25 habitaciones, agosto 2027.");
    const creadaEnMs = new Date(solicitud.creadaEn).getTime();
    const fake = new FakeWhatsappAdapter();
    const at48h = () => new Date(creadaEnMs + 48 * 60 * 60 * 1000);

    const primeraCorrida = await runGroupFollowUps(fixture.engine.admin, { hotelId, tenantId }, { now: at48h, messagingPort: fake });
    const enviados48h = primeraCorrida.ejecutados.filter((e) => e.solicitudId === solicitud.id);
    expect(enviados48h).toHaveLength(1);
    expect(enviados48h[0]!.tipo).toBe("48h");
    expect(enviados48h[0]!.externalMessageId).toBeTruthy();

    // Segunda corrida en el MISMO instante (o después, todavía antes de los 7 días):
    // el seguimiento de 48h ya se marcó ejecutado, no vuelve a dispararse.
    const segundaCorrida = await runGroupFollowUps(fixture.engine.admin, { hotelId, tenantId }, { now: at48h, messagingPort: fake });
    expect(segundaCorrida.ejecutados.filter((e) => e.solicitudId === solicitud.id)).toHaveLength(0);
  });

  it("envía el seguimiento de 7 días cuando se cumple esa ventana, sin reenviar el de 48h", async () => {
    const solicitud = await crearSolicitud("Grupo corporativo, 60 habitaciones, octubre 2027.");
    const creadaEnMs = new Date(solicitud.creadaEn).getTime();
    const fake = new FakeWhatsappAdapter();

    await runGroupFollowUps(fixture.engine.admin, { hotelId, tenantId }, { now: () => new Date(creadaEnMs + 48 * 60 * 60 * 1000), messagingPort: fake });
    const corrida7d = await runGroupFollowUps(
      fixture.engine.admin,
      { hotelId, tenantId },
      { now: () => new Date(creadaEnMs + 7 * 24 * 60 * 60 * 1000), messagingPort: fake },
    );

    const enviados = corrida7d.ejecutados.filter((e) => e.solicitudId === solicitud.id);
    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.tipo).toBe("7d");
  });

  it("una solicitud que YA fue respondida nunca recibe seguimiento, aunque el reloj avance más allá de ambas ventanas", async () => {
    const solicitud = await crearSolicitud("Retiro corporativo, 10 habitaciones, enero 2028.");
    const creadaEnMs = new Date(solicitud.creadaEn).getTime();

    const responder = await fixture.app.request(`/hoteles/${hotelId}/grupos/${solicitud.id}/responder`, {
      method: "PATCH",
      headers: auth(),
    });
    expect(responder.status).toBe(200);
    expect(((await responder.json()) as { estado: string }).estado).toBe("respondida");

    const fake = new FakeWhatsappAdapter();
    const result = await runGroupFollowUps(
      fixture.engine.admin,
      { hotelId, tenantId },
      { now: () => new Date(creadaEnMs + 30 * 24 * 60 * 60 * 1000), messagingPort: fake },
    );
    expect(result.ejecutados.filter((e) => e.solicitudId === solicitud.id)).toHaveLength(0);
  });

  it("0 propuestas sin registro de validación humana: la ruta rechaza el envío sin validacionId válido, y lo permite tras registrar la validación", async () => {
    const solicitud = await crearSolicitud("Convención médica, 80 habitaciones, febrero 2028.");

    // Sin ningún registro de validación humana previo -- rechazado, nunca crea la propuesta.
    const sinValidacion = await fixture.app.request(`/hoteles/${hotelId}/grupos/${solicitud.id}/propuestas`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ validacionId: "00000000-0000-0000-0000-000000000000", contenido: "Propuesta preliminar de RFP.", montoTotal: 450000, moneda: "MXN" }),
    });
    expect(sinValidacion.status).toBe(400);

    const listaSinPropuestas = await fixture.app.request(`/hoteles/${hotelId}/grupos/${solicitud.id}`, { headers: auth() });
    expect(((await listaSinPropuestas.json()) as { propuestas: unknown[] }).propuestas).toHaveLength(0);

    // Se registra la validación humana (un humano real revisó la solicitud) --
    const validacionRes = await fixture.app.request(`/hoteles/${hotelId}/grupos/${solicitud.id}/validaciones`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ notas: "Revisado por reservaciones: disponibilidad confirmada." }),
    });
    expect(validacionRes.status).toBe(201);
    const validacion = (await validacionRes.json()) as { id: string };

    // Ahora SÍ se puede enviar la propuesta, referenciando esa validación real.
    const conValidacion = await fixture.app.request(`/hoteles/${hotelId}/grupos/${solicitud.id}/propuestas`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ validacionId: validacion.id, contenido: "Propuesta final de RFP.", montoTotal: 450000, moneda: "MXN" }),
    });
    expect(conValidacion.status).toBe(201);
    const propuesta = (await conValidacion.json()) as { validacionHumanaId: string; solicitudId: string };
    expect(propuesta.validacionHumanaId).toBe(validacion.id);
    expect(propuesta.solicitudId).toBe(solicitud.id);

    const listaConPropuesta = await fixture.app.request(`/hoteles/${hotelId}/grupos/${solicitud.id}`, { headers: auth() });
    const detalle = (await listaConPropuesta.json()) as { propuestas: unknown[]; validaciones: unknown[] };
    expect(detalle.propuestas).toHaveLength(1);
    expect(detalle.validaciones).toHaveLength(1);
  });

  it("rechaza una propuesta cuya validación pertenece a OTRA solicitud de grupo", async () => {
    const solicitudA = await crearSolicitud("Solicitud A, festival gastronómico.");
    const solicitudB = await crearSolicitud("Solicitud B, torneo deportivo.");

    const validacionDeA = await fixture.app.request(`/hoteles/${hotelId}/grupos/${solicitudA.id}/validaciones`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({}),
    });
    expect(validacionDeA.status).toBe(201);
    const { id: validacionId } = (await validacionDeA.json()) as { id: string };

    const propuestaCruzada = await fixture.app.request(`/hoteles/${hotelId}/grupos/${solicitudB.id}/propuestas`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ validacionId, contenido: "Intento de propuesta con validación de otra solicitud." }),
    });
    expect(propuestaCruzada.status).toBe(400);
  });
});
