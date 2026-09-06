// Chequeo honesto de credenciales -- base de "unavailable con razón explícita" (ADR-007/011).
import { describe, expect, it, afterEach } from "vitest";
import { checkEnvCredentials } from "@atiende-hoteles/mcp-shared";

const ENV_KEY_A = "MCP_TEST_CRED_A";
const ENV_KEY_B = "MCP_TEST_CRED_B";

afterEach(() => {
  delete process.env[ENV_KEY_A];
  delete process.env[ENV_KEY_B];
});

describe("checkEnvCredentials", () => {
  it("reporta available:false y lista lo que falta cuando ninguna variable está definida", () => {
    const result = checkEnvCredentials([ENV_KEY_A, ENV_KEY_B]);
    expect(result.available).toBe(false);
    expect(result.missing).toEqual([ENV_KEY_A, ENV_KEY_B]);
  });

  it("una variable vacía cuenta como faltante (no basta con que exista la llave)", () => {
    process.env[ENV_KEY_A] = "   ";
    process.env[ENV_KEY_B] = "valor-real";
    const result = checkEnvCredentials([ENV_KEY_A, ENV_KEY_B]);
    expect(result.available).toBe(false);
    expect(result.missing).toEqual([ENV_KEY_A]);
  });

  it("reporta available:true solo cuando TODAS las variables están presentes", () => {
    process.env[ENV_KEY_A] = "valor-a";
    process.env[ENV_KEY_B] = "valor-b";
    const result = checkEnvCredentials([ENV_KEY_A, ENV_KEY_B]);
    expect(result.available).toBe(true);
    expect(result.missing).toEqual([]);
  });
});
