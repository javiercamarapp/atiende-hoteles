// REQ-AGT-022 / GOB-025: aislamiento de contexto entre tenants. buildContext() rechaza
// cualquier fragmento de OTRO hotel/tenant que no este marcado como publico.
import { describe, expect, it } from "vitest";
import {
  CrossTenantContextError,
  buildContext,
  buildToolContext,
  createRunBudget,
  type ContextFragment,
} from "@atiende-hoteles/agent-core";

describe("buildContext", () => {
  it("incluye fragmentos del hotel en curso", () => {
    const fragments: ContextFragment[] = [
      { tenantId: "hotel-1", scope: "hotel", label: "politica-cancelacion", content: "cancela hasta 24h antes" },
    ];
    expect(buildContext("hotel-1", fragments)).toEqual(["cancela hasta 24h antes"]);
  });

  it("incluye hechos publicos sin importar su tenantId declarado", () => {
    const fragments: ContextFragment[] = [
      { tenantId: "cualquiera", scope: "public", label: "catalogo-precios", content: "catalogo publico" },
    ];
    expect(buildContext("hotel-1", fragments)).toEqual(["catalogo publico"]);
  });

  it("RECHAZA un fragmento de OTRO tenant marcado como scope=hotel (fuga entre hoteles)", () => {
    const fragments: ContextFragment[] = [
      { tenantId: "hotel-1", scope: "hotel", label: "propio", content: "dato propio" },
      { tenantId: "hotel-2", scope: "hotel", label: "ajeno", content: "dato de otro hotel" },
    ];
    expect(() => buildContext("hotel-1", fragments)).toThrow(CrossTenantContextError);
  });

  it("el error de aislamiento identifica el tenant ajeno y el hotel en curso", () => {
    const fragments: ContextFragment[] = [
      { tenantId: "hotel-999", scope: "hotel", label: "few-shot-ajeno", content: "ejemplo de otro hotel" },
    ];
    try {
      buildContext("hotel-1", fragments);
      throw new Error("no debio llegar aqui");
    } catch (err) {
      expect(err).toBeInstanceOf(CrossTenantContextError);
      const crossTenantErr = err as CrossTenantContextError;
      expect(crossTenantErr.fragmentTenantId).toBe("hotel-999");
      expect(crossTenantErr.currentHotelId).toBe("hotel-1");
    }
  });
});

describe("buildToolContext", () => {
  it("construye un ToolContext a partir de una ServerSession completa", () => {
    const budget = createRunBudget({});
    const ctx = buildToolContext(
      { orgId: "org-1", hotelId: "hotel-1", actor: { type: "staff", id: "s-1" }, requestId: "req-1" },
      budget,
    );
    expect(ctx.orgId).toBe("org-1");
    expect(ctx.hotelId).toBe("hotel-1");
    expect(ctx.budget).toBe(budget);
  });

  it("rechaza una ServerSession incompleta (sin hotelId)", () => {
    const budget = createRunBudget({});
    expect(() =>
      buildToolContext(
        { orgId: "org-1", hotelId: "", actor: { type: "staff", id: "s-1" }, requestId: "req-1" },
        budget,
      ),
    ).toThrow();
  });
});
