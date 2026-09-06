// H7 · Adversarial: aislamiento por hotel/rol del runtime de agentes (REQ-AGT-022,
// REQ-TEN-001/GOB-038, REQ-AGT-001/018) -- ENTREGA punto 5 "adversarial (usuario de
// hotel A no ejecuta agente con contexto de hotel B; rol housekeeping no ejecuta agente
// de revenue; input del cliente no puede fijar hotel_id/gate)".
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../support/api-fixture.ts";

let fixture: ApiFixture;
let hotelAId: string;
let hotelBId: string;
let frontdeskAToken: string;
let housekeepingAToken: string;
let ownerAToken: string;

function slugFromEmail(email: string): string {
  return email.split("@")[1]!.replace(".demo", "");
}

beforeAll(async () => {
  fixture = await createApiFixture();
  hotelAId = fixture.seed.hotels[0]!.id;
  hotelBId = fixture.seed.hotels[1]!.id;
  const slugA = slugFromEmail(fixture.seed.hotels[0]!.staff[0]!.email);
  frontdeskAToken = await loginAs(fixture.app, `frontdesk@${slugA}.demo`);
  housekeepingAToken = await loginAs(fixture.app, `housekeeping@${slugA}.demo`);
  ownerAToken = await loginAs(fixture.app, `owner@${slugA}.demo`);
});

afterAll(async () => {
  await destroyApiFixture(fixture);
});

function auth(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

describe("aislamiento por hotel", () => {
  it("un usuario del hotel A no puede ejecutar un agente sobre la ruta del hotel B", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelBId}/agentes/recepcion_virtual/ejecutar`, {
      method: "POST",
      headers: auth(frontdeskAToken),
      body: JSON.stringify({ mensaje: "hola", demo: true }),
    });
    expect(res.status).toBe(403);
  });

  it("un usuario del hotel A no puede leer costos/roi del hotel B", async () => {
    const resCostos = await fixture.app.request(`/hoteles/${hotelBId}/agentes/costos`, { headers: auth(frontdeskAToken) });
    expect(resCostos.status).toBe(403);
    const resRoi = await fixture.app.request(`/hoteles/${hotelBId}/roi`, { headers: auth(frontdeskAToken) });
    expect(resRoi.status).toBe(403);
  });

  it("el header X-Hotel-Id no puede sustituir al hotel de la ruta para colarse a otro hotel", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelBId}/agentes/recepcion_virtual/ejecutar`, {
      method: "POST",
      headers: { ...auth(frontdeskAToken), "x-hotel-id": hotelAId },
      body: JSON.stringify({ mensaje: "hola", demo: true }),
    });
    expect(res.status).toBe(403);
  });
});

describe("aislamiento por rol", () => {
  it("housekeeping no puede ejecutar el agente de revenue/cierre (auditor_nocturno)", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelAId}/agentes/auditor_nocturno/ejecutar`, {
      method: "POST",
      headers: auth(housekeepingAToken),
      body: JSON.stringify({ mensaje: "cierre", demo: true }),
    });
    expect(res.status).toBe(403);
  });

  it("housekeeping tampoco puede cambiar el gate/techo de ningún agente", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelAId}/agentes/recepcion_virtual/config`, {
      method: "PATCH",
      headers: auth(housekeepingAToken),
      body: JSON.stringify({ gate: "autopilot" }),
    });
    expect(res.status).toBe(403);

    const { rows } = await fixture.engine.admin.query(
      "select 1 from public.agent_config where hotel_id = $1 and agent_name = 'recepcion_virtual';",
      [hotelAId],
    );
    expect(rows).toHaveLength(0);
  });

  it("housekeeping tampoco puede ejecutar recepción virtual (no está en su lista de roles permitidos)", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelAId}/agentes/recepcion_virtual/ejecutar`, {
      method: "POST",
      headers: auth(housekeepingAToken),
      body: JSON.stringify({ mensaje: "hola", demo: true }),
    });
    expect(res.status).toBe(403);
  });

  it("frontdesk (rol permitido de recepcion_virtual) SÍ puede ejecutarlo -- confirma que el 403 de arriba es por ROL, no por el hotel ni por un error genérico", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelAId}/agentes/recepcion_virtual/ejecutar`, {
      method: "POST",
      headers: auth(frontdeskAToken),
      body: JSON.stringify({ mensaje: "hola", demo: true }),
    });
    expect(res.status).toBe(200);
  });
});

describe("el cliente nunca puede fijar identidad/gate", () => {
  it("un body con hotelId/orgId/gate desconocidos para el endpoint se rechaza (esquema .strict())", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelAId}/agentes/recepcion_virtual/ejecutar`, {
      method: "POST",
      headers: auth(frontdeskAToken),
      body: JSON.stringify({ mensaje: "hola", demo: true, hotelId: hotelBId, orgId: "otra-org", gate: "autopilot" }),
    });
    expect(res.status).toBe(400);
  });

  it("aunque el body no tenga campos desconocidos, el gate SIEMPRE sale de agent_config/default -- nunca de una corrida previa insertada a mano por el cliente", async () => {
    // Confirma que, sin haber configurado nada, el gate efectivo es el default de
    // código ("shadow") -- ver AGENT_DEFINITIONS en packages/agent-core/src/agents.ts.
    const res = await fixture.app.request(`/hoteles/${hotelAId}/agentes/enrutador_mensajes/ejecutar`, {
      method: "POST",
      headers: auth(ownerAToken),
      body: JSON.stringify({ mensaje: "hola", demo: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { gate: string };
    expect(body.gate).toBe("shadow");
  });
});
