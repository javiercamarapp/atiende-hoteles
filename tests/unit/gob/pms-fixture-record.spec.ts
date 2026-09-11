// REQ-AGT-021 (BP-138): skill hotelera `pms-fixture-record`. Prueba `validateFixtureShape`
// contra los 7 fixtures REALES ya committeados en `packages/mcp-servers/pms/fixtures/`
// (grabados de verdad contra `CloudbedsSimulator` -- ver el comentario del propio script)
// y ejercita `record`/`validate`/`list` de punta a punta contra un `CloudbedsSimulator`
// real en un directorio temporal, sin ningún mock -- mismo patrón de "real
// embedded/local server, no fake" que el resto de la suite del conector PMS
// (tests/unit/mcp-servers/pms/*.spec.ts).
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  DEFAULT_FIXTURES_DIR,
  listFixtures,
  validateFixtureShape,
  validateFixtures,
  type PmsFixture,
} from "../../../scripts/skills/pms-fixture-record.ts";

let dir: string | null = null;

function crearDirTemporal(): string {
  dir = mkdtempSync(join(tmpdir(), "pms-fixture-record-"));
  return dir;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("pms-fixture-record: fixtures reales committeados", () => {
  it("los 7 fixtures grabados contra CloudbedsSimulator existen y tienen forma válida", () => {
    const found = listFixtures(DEFAULT_FIXTURES_DIR);
    expect(found.length).toBeGreaterThanOrEqual(7);
    expect(validateFixtures(DEFAULT_FIXTURES_DIR)).toEqual([]);
  });

  it("cada fixture real registra un intercambio exitoso (status 200) contra el simulador", () => {
    for (const file of listFixtures(DEFAULT_FIXTURES_DIR)) {
      const data = JSON.parse(readFileSync(join(DEFAULT_FIXTURES_DIR, file), "utf8")) as PmsFixture;
      expect(data.source).toBe("cloudbeds-simulator");
      expect(data.response.status).toBe(200);
    }
  });
});

describe("validateFixtureShape: casos negativos", () => {
  it("rechaza un fixture al que le falta 'response'", () => {
    const problems = validateFixtureShape("roto.json", {
      source: "cloudbeds-simulator",
      recordedAt: "2026-01-01T00:00:00Z",
      endpoint: "getReservation",
      request: { method: "GET", path: "/getReservation" },
    });
    expect(problems.some((p) => p.includes('falta el campo "response"'))).toBe(true);
  });

  it("rechaza un fixture con 'source' distinto de cloudbeds-simulator", () => {
    const problems = validateFixtureShape("roto.json", {
      source: "otra-cosa",
      recordedAt: "2026-01-01T00:00:00Z",
      endpoint: "getReservation",
      request: { method: "GET", path: "/x" },
      response: { status: 200, body: {} },
    });
    expect(problems.some((p) => p.includes('"source" debe ser'))).toBe(true);
  });

  it("rechaza un valor que no es un objeto", () => {
    expect(validateFixtureShape("roto.json", "no soy un objeto")).toEqual(["roto.json: no es un objeto JSON."]);
  });
});

describe("pms-fixture-record CLI: record -> validate -> list de punta a punta (real, sin mocks)", () => {
  it("record levanta CloudbedsSimulator real, graba fixtures válidos, y validate/list los leen correctamente", () => {
    const outDir = crearDirTemporal();
    const scriptPath = join(import.meta.dirname, "../../../scripts/skills/pms-fixture-record.ts");

    execFileSync("node", ["--experimental-strip-types", scriptPath, "record", "--out", outDir], {
      cwd: join(import.meta.dirname, "../../.."),
      encoding: "utf8",
    });

    expect(existsSync(join(outDir, "access_token.json"))).toBe(true);
    expect(validateFixtures(outDir)).toEqual([]);
    expect(readdirSync(outDir).filter((f) => f.endsWith(".json")).length).toBeGreaterThanOrEqual(7);

    const validateOutput = execFileSync("node", ["--experimental-strip-types", scriptPath, "validate", "--out", outDir], {
      cwd: join(import.meta.dirname, "../../.."),
      encoding: "utf8",
    });
    expect(validateOutput).toContain("OK");

    const listOutput = execFileSync("node", ["--experimental-strip-types", scriptPath, "list", "--out", outDir], {
      cwd: join(import.meta.dirname, "../../.."),
      encoding: "utf8",
    });
    expect(listOutput).toContain("endpoint=access_token");
  }, 20_000);

  it("validate falla (exit != 0) contra un directorio sin fixtures", () => {
    const outDir = crearDirTemporal();
    const scriptPath = join(import.meta.dirname, "../../../scripts/skills/pms-fixture-record.ts");
    expect(() =>
      execFileSync("node", ["--experimental-strip-types", scriptPath, "validate", "--out", outDir], {
        cwd: join(import.meta.dirname, "../../.."),
        encoding: "utf8",
      }),
    ).toThrow();
  });
});
