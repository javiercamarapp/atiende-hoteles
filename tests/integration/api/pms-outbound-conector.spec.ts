// H18 · conector-pms-enterprise: prueba de extremo a extremo, vía la API real, de que
// crear un `housekeeping_task`/`maintenance_ticket`/`guest_ticket` empuja la tarea al
// conector outbound genérico cuando el hotel lo tiene configurado y habilitado (y NO lo
// hace cuando no lo tiene, o cuando está deshabilitado) -- mismo criterio que
// tests/integration/api/housekeeping-mantenimiento.spec.ts, pero verificando el enganche
// de docs/integraciones/conector-pms-enterprise.md en vez del ciclo de vida normal.
// También cubre /hoteles/:hotelId/integraciones/pms-outbound (GET/PUT/DELETE).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "@atiende-hoteles/api";
import { FakeOutboundTaskSyncAdapter } from "@atiende-hoteles/mcp-outbound";
import type { Hono } from "hono";
import type { HonoEnvBindings } from "@atiende-hoteles/api";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

describe("conector outbound PMS-enterprise (integración real vía API)", () => {
  let fixture: ApiFixture;
  let app: Hono<HonoEnvBindings>;
  let outboundPort: FakeOutboundTaskSyncAdapter;
  let ownerToken: string;
  let frontdeskToken: string;
  let hotelId: string;
  let roomCode: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    outboundPort = new FakeOutboundTaskSyncAdapter();
    const deps: AppDeps = { ...fixture.deps, outboundTaskSync: outboundPort };
    app = createApp(deps);

    const hotel = fixture.seed.hotels[0]!;
    hotelId = hotel.id;
    ownerToken = await loginAs(app, hotel.staff.find((s) => s.role === "owner")!.email);
    frontdeskToken = await loginAs(app, hotel.staff.find((s) => s.role === "frontdesk")!.email);

    const { rows } = await fixture.engine.admin.query<{ code: string }>(
      "select code from public.room where hotel_id = $1 order by code limit 1;",
      [hotelId],
    );
    roomCode = rows[0]!.code;
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  beforeEach(async () => {
    outboundPort.pushed.length = 0;
    await fixture.engine.admin.exec(
      `truncate table public.hotel_pms_outbound_config, public.housekeeping_task,
         public.maintenance_ticket, public.guest_ticket restart identity cascade;`,
    );
  });

  const authOf = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

  describe("/hoteles/:hotelId/integraciones/pms-outbound", () => {
    it("GET sin configuración devuelve configurado:false", async () => {
      const res = await app.request(`/hoteles/${hotelId}/integraciones/pms-outbound`, { headers: authOf(ownerToken) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ configurado: false });
    });

    it("frontdesk NO puede ver ni configurar el conector (403) -- es una credencial técnica, no de soporte", async () => {
      const get = await app.request(`/hoteles/${hotelId}/integraciones/pms-outbound`, { headers: authOf(frontdeskToken) });
      expect(get.status).toBe(403);
      const put = await app.request(`/hoteles/${hotelId}/integraciones/pms-outbound`, {
        method: "PUT",
        headers: authOf(frontdeskToken),
        body: JSON.stringify({ webhookUrl: "https://sistema-del-hotel.example/tareas", enabled: true }),
      });
      expect(put.status).toBe(403);
    });

    it("owner puede configurar (PUT), leer (GET) y borrar (DELETE)", async () => {
      const put = await app.request(`/hoteles/${hotelId}/integraciones/pms-outbound`, {
        method: "PUT",
        headers: authOf(ownerToken),
        body: JSON.stringify({
          webhookUrl: "https://sistema-del-hotel.example/tareas",
          taskTypes: ["maintenance_ticket"],
          enabled: true,
        }),
      });
      expect(put.status).toBe(200);
      const putBody = (await put.json()) as { configurado: boolean; webhookSecret: string; taskTypes: string[] };
      expect(putBody.configurado).toBe(true);
      expect(putBody.taskTypes).toEqual(["maintenance_ticket"]);
      expect(putBody.webhookSecret).toHaveLength(64); // randomBytes(32).toString("hex")

      const get = await app.request(`/hoteles/${hotelId}/integraciones/pms-outbound`, { headers: authOf(ownerToken) });
      expect((await get.json() as { webhookSecret: string }).webhookSecret).toBe(putBody.webhookSecret);

      const del = await app.request(`/hoteles/${hotelId}/integraciones/pms-outbound`, {
        method: "DELETE",
        headers: authOf(ownerToken),
      });
      expect(del.status).toBe(200);
      const after = await app.request(`/hoteles/${hotelId}/integraciones/pms-outbound`, { headers: authOf(ownerToken) });
      expect(await after.json()).toEqual({ configurado: false });
    });

    it("un PUT posterior sin rotateSecret conserva el mismo secreto", async () => {
      const first = await app.request(`/hoteles/${hotelId}/integraciones/pms-outbound`, {
        method: "PUT",
        headers: authOf(ownerToken),
        body: JSON.stringify({ webhookUrl: "https://a.example/x" }),
      });
      const { webhookSecret: secret1 } = (await first.json()) as { webhookSecret: string };

      const second = await app.request(`/hoteles/${hotelId}/integraciones/pms-outbound`, {
        method: "PUT",
        headers: authOf(ownerToken),
        body: JSON.stringify({ webhookUrl: "https://b.example/y" }),
      });
      const { webhookSecret: secret2 } = (await second.json()) as { webhookSecret: string };
      expect(secret2).toBe(secret1);
    });
  });

  describe("enganche a la creación de tareas -- sin configuración (el caso común)", () => {
    it("crear tarea de housekeeping sin conector configurado: éxito normal, sin data.outboundSync", async () => {
      const res = await app.request(`/hoteles/${hotelId}/housekeeping/tareas`, {
        method: "POST",
        headers: authOf(ownerToken),
        body: JSON.stringify({ roomCode }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.outboundSync).toBeUndefined();
      expect(outboundPort.pushed).toHaveLength(0);
    });
  });

  describe("enganche a la creación de tareas -- con conector habilitado", () => {
    beforeEach(async () => {
      await app.request(`/hoteles/${hotelId}/integraciones/pms-outbound`, {
        method: "PUT",
        headers: authOf(ownerToken),
        body: JSON.stringify({
          webhookUrl: "https://sistema-del-hotel.example/tareas",
          taskTypes: ["housekeeping_task", "maintenance_ticket", "guest_ticket"],
          enabled: true,
        }),
      });
    });

    it("crear_tarea_housekeeping empuja al conector con taskType correcto", async () => {
      const res = await app.request(`/hoteles/${hotelId}/housekeeping/tareas`, {
        method: "POST",
        headers: authOf(ownerToken),
        body: JSON.stringify({ roomCode, priority: "alta" }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { outboundSync?: { delivered: boolean } };
      expect(body.outboundSync?.delivered).toBe(true);

      expect(outboundPort.pushed).toHaveLength(1);
      expect(outboundPort.pushed[0]!.task.taskType).toBe("housekeeping_task");
      expect(outboundPort.pushed[0]!.task.hotelId).toBe(hotelId);
      expect(outboundPort.pushed[0]!.task.priority).toBe("alta");
      expect(outboundPort.pushed[0]!.destination).toEqual({
        url: "https://sistema-del-hotel.example/tareas",
        secret: expect.any(String),
      });
    });

    it("crear_ticket_mantenimiento empuja al conector con taskType correcto", async () => {
      const res = await app.request(`/hoteles/${hotelId}/mantenimiento`, {
        method: "POST",
        headers: authOf(ownerToken),
        body: JSON.stringify({ roomCode, title: "Aire acondicionado no enfría", description: "No enfría desde ayer" }),
      });
      expect(res.status).toBe(201);
      expect(outboundPort.pushed).toHaveLength(1);
      expect(outboundPort.pushed[0]!.task.taskType).toBe("maintenance_ticket");
      expect(outboundPort.pushed[0]!.task.title).toBe("Aire acondicionado no enfría");
    });

    it("crear_ticket_huesped empuja al conector con taskType correcto", async () => {
      const res = await app.request(`/hoteles/${hotelId}/tickets`, {
        method: "POST",
        headers: authOf(ownerToken),
        body: JSON.stringify({ guestMessage: "El aire acondicionado hace mucho ruido", roomCode }),
      });
      expect(res.status).toBe(201);
      expect(outboundPort.pushed).toHaveLength(1);
      expect(outboundPort.pushed[0]!.task.taskType).toBe("guest_ticket");
      expect(outboundPort.pushed[0]!.task.roomCode).toBe(roomCode);
    });

    it("el tipo de tarea SIGUE creándose localmente aunque el conector falle -- best-effort real", async () => {
      const failingPort = {
        status: outboundPort.status.bind(outboundPort),
        pushTask: async () => {
          throw new Error("sistema del hotel caído");
        },
      };
      const localApp = createApp({ ...fixture.deps, outboundTaskSync: failingPort });

      const res = await localApp.request(`/hoteles/${hotelId}/housekeeping/tareas`, {
        method: "POST",
        headers: authOf(ownerToken),
        body: JSON.stringify({ roomCode }),
      });
      expect(res.status).toBe(201); // la tarea local SÍ se creó
      const body = (await res.json()) as { outboundSync?: { delivered: boolean; reason?: string } };
      expect(body.outboundSync?.delivered).toBe(false);
      expect(body.outboundSync?.reason).toContain("sistema del hotel caído");

      const { rows } = await fixture.engine.admin.query<{ count: string }>(
        "select count(*)::text as count from public.housekeeping_task where hotel_id = $1;",
        [hotelId],
      );
      expect(Number(rows[0]!.count)).toBe(1);
    });
  });

  describe("enganche a la creación de tareas -- habilitado pero solo para OTRO tipo de tarea", () => {
    beforeEach(async () => {
      await app.request(`/hoteles/${hotelId}/integraciones/pms-outbound`, {
        method: "PUT",
        headers: authOf(ownerToken),
        body: JSON.stringify({
          webhookUrl: "https://sistema-del-hotel.example/tareas",
          taskTypes: ["maintenance_ticket"],
          enabled: true,
        }),
      });
    });

    it("crear_tarea_housekeeping NO empuja nada (housekeeping_task no está en task_types)", async () => {
      const res = await app.request(`/hoteles/${hotelId}/housekeeping/tareas`, {
        method: "POST",
        headers: authOf(ownerToken),
        body: JSON.stringify({ roomCode }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.outboundSync).toBeUndefined();
      expect(outboundPort.pushed).toHaveLength(0);
    });
  });
});
