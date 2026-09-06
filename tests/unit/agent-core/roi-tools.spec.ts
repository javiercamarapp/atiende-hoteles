// H7 · Unidad: validación de `registrar_evento_roi` sin tocar una base de datos real
// (el cálculo de la columna derivada `estimado` -- que SÍ depende de Postgres -- se
// prueba en tests/integration/agent-core/roi-event.spec.ts).
import { describe, expect, it } from "vitest";
import { buildToolContext, createRegistrarEventoRoiTool, createRunBudget, REGISTRAR_EVENTO_ROI_TOOL_NAME } from "@atiende-hoteles/agent-core";
import type { SqlClient } from "@atiende-hoteles/agent-core";

function ctx() {
  return buildToolContext(
    { orgId: "org-1", hotelId: "hotel-1", actor: { type: "staff", id: "staff-1" }, requestId: "req-1" },
    createRunBudget({}),
  );
}

describe("registrar_evento_roi", () => {
  it("declara su nombre y no exige aprobación humana (effect=write, es solo un registro de observabilidad)", () => {
    const db: SqlClient = { query: async <T,>() => ({ rows: [{ id: "x", estimado: true }] as T[] }) };
    const tool = createRegistrarEventoRoiTool({ db, agentName: "recepcion_virtual" });
    expect(tool.name).toBe(REGISTRAR_EVENTO_ROI_TOOL_NAME);
    expect(tool.needsApproval).toBe(false);
    expect(tool.effect).toBe("write");
  });

  it("rechaza registrar un evento sin monto estimado NI verificado, sin llegar a tocar la base de datos", async () => {
    let queried = false;
    const db: SqlClient = {
      query: async () => {
        queried = true;
        return { rows: [] };
      },
    };
    const tool = createRegistrarEventoRoiTool({ db, agentName: "recepcion_virtual" });
    const result = await tool.run(ctx(), {
      tipoEvento: "checkin_asistido",
      metodoContrafactual: "minutos de staff ahorrados",
      confianza: 0.5,
      supuestoVersion: "H17-v1",
      referenciaTipo: "ninguna",
    });
    expect(result.ok).toBe(false);
    expect(queried).toBe(false);
  });

  it("registra el evento con monto estimado y devuelve el id/estimado que la BD reporta", async () => {
    const calls: unknown[][] = [];
    const db: SqlClient = {
      query: async <T,>(_sql: string, params?: unknown[]) => {
        calls.push(params ?? []);
        return { rows: [{ id: "roi-1", estimado: true }] as T[] };
      },
    };
    const tool = createRegistrarEventoRoiTool({ db, agentName: "auditor_nocturno" });
    const result = await tool.run(ctx(), {
      tipoEvento: "revenue_ajuste_nocturno_detectado",
      montoEstimado: 42,
      metodoContrafactual: "diferencia contra tarifa objetivo del pickup del día",
      confianza: 0.5,
      supuestoVersion: "H17-v1",
      referenciaTipo: "ninguna",
    });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ roiEventId: "roi-1", estimado: true });
    // agentName viene de las deps (closure), NUNCA del input del modelo.
    expect(calls[0]?.[2]).toBe("auditor_nocturno");
  });
});
