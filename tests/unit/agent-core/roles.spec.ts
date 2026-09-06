// DECISIONLLM (docs/referencia/01-blueprint-y-decision-llm.md §3): runtime por rol
// configurable por env, y gates shadow/propone/autopilot por (hotel, agente).
import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_BY_ROLE, ROLE_PARAMS, StaticGateResolver, resolveModelForRole } from "@atiende-hoteles/agent-core";

describe("resolveModelForRole", () => {
  it("usa Sonnet 5 por defecto para el canal", () => {
    expect(resolveModelForRole("canal", {})).toBe("claude-sonnet-5");
    expect(DEFAULT_MODEL_BY_ROLE.canal).toBe("claude-sonnet-5");
  });

  it("usa Haiku 4.5 por defecto para el enrutador", () => {
    expect(resolveModelForRole("enrutador", {})).toBe("claude-haiku-4-5");
  });

  it("usa Opus 5 por defecto para el batch nocturno", () => {
    expect(resolveModelForRole("batch_nocturno", {})).toBe("claude-opus-5");
  });

  it("permite override por variable de entorno sin tocar codigo", () => {
    const env = { AGENT_MODEL_CANAL: "claude-sonnet-4-6" };
    expect(resolveModelForRole("canal", env)).toBe("claude-sonnet-4-6");
  });

  it("ignora un override vacio y cae al default", () => {
    const env = { AGENT_MODEL_CANAL: "" };
    expect(resolveModelForRole("canal", env)).toBe("claude-sonnet-5");
  });
});

describe("ROLE_PARAMS", () => {
  it("fija temperature:0 en los tres roles (GOB-032/LLM-020: nunca dinero por generacion libre)", () => {
    expect(ROLE_PARAMS.canal.temperature).toBe(0);
    expect(ROLE_PARAMS.enrutador.temperature).toBe(0);
    expect(ROLE_PARAMS.batch_nocturno.temperature).toBe(0);
  });
});

describe("StaticGateResolver", () => {
  it("por defecto resuelve 'shadow' para un (hotel, agente) sin configurar", () => {
    const resolver = new StaticGateResolver();
    expect(resolver.resolve({ hotelId: "hotel-1", agent: "revenue" })).toBe("shadow");
  });

  it("respeta el gate configurado explicitamente por (hotel, agente)", () => {
    const resolver = new StaticGateResolver([[{ hotelId: "hotel-1", agent: "revenue" }, "propone"]]);
    expect(resolver.resolve({ hotelId: "hotel-1", agent: "revenue" })).toBe("propone");
    expect(resolver.resolve({ hotelId: "hotel-2", agent: "revenue" })).toBe("shadow");
  });

  it("set() actualiza el gate de un (hotel, agente) en caliente", () => {
    const resolver = new StaticGateResolver();
    resolver.set({ hotelId: "hotel-1", agent: "revenue" }, "autopilot");
    expect(resolver.resolve({ hotelId: "hotel-1", agent: "revenue" })).toBe("autopilot");
  });
});
