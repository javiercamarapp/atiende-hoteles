// REQ-QA-010 (BP-141): "Cada capability declarada de un conector (PMS, pago, CFDI)
// debe tener su contract test correspondiente, verificado por un subagente/proceso de
// auditoría de solo lectura antes de cada release." Prueba adversarial + del camino
// feliz de `scripts/checks/registro-conectores-contract-tests.ts` (renombrado al
// fusionar closure/todos-los-req-hoteles-lote1 -- colisión real de archivo con la
// implementación independiente de REQ-REV-015 en `registro-conectores-pms.ts`, ver
// comentario de cabecera de ese script) contra un puerto/conjunto de
// contract tests SINTÉTICOS en un directorio temporal (mismo patrón que
// tests/unit/gob/gate-por-tarea.spec.ts) -- nunca contra el repo real para el caso
// negativo, para no depender de qué capability esté o no cubierta hoy. El último
// bloque SÍ corre contra el repo real para confirmar que hoy cierra en verde (0
// hallazgos), incluyendo `consultarEstado` de `CfdiPort` (capability que este mismo
// cierre de REQ-QA-010 encontró sin contract test y corrigió, ver
// docs/logs/REQ-QA-010/).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  auditAllConnectors,
  auditConnector,
  DEFAULT_CONNECTOR_SPECS,
  extractCapabilities,
  type ConnectorAuditSpec,
} from "../../../scripts/checks/registro-conectores-contract-tests.ts";

let dir: string | null = null;

function crearDirTemporal(): string {
  dir = mkdtempSync(join(tmpdir(), "registro-conectores-pms-"));
  return dir;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/** Puerto sintético con 3 capabilities (`status`, `hacerAlgo`, `hacerOtraCosa`) --
 *  suficiente para probar extracción y cobertura sin depender de la forma real de
 *  ningún `port.ts`. */
const PUERTO_SINTETICO = `
/** Puerto de prueba, no real. */
export interface FakeConnectorPort {
  /** Comentario de una línea -- no debe confundirse con una capability. */
  status(): AdapterStatus;

  /**
   * JSDoc de varias líneas antes de la firma -- tampoco debe colarse como capability.
   */
  hacerAlgo(input: string): Promise<void>;

  hacerOtraCosa(input: number): Promise<number>;
}
`;

function escribirPuertoSintetico(root: string): string {
  const relPath = "src/port.ts";
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, relPath), PUERTO_SINTETICO);
  return relPath;
}

describe("extractCapabilities", () => {
  it("extrae los 3 métodos de la interfaz, ignorando comentarios/JSDoc", () => {
    const capabilities = extractCapabilities(PUERTO_SINTETICO, "FakeConnectorPort");
    expect(capabilities).toEqual(["status", "hacerAlgo", "hacerOtraCosa"]);
  });

  it("lanza si la interfaz nombrada no existe en el archivo", () => {
    expect(() => extractCapabilities(PUERTO_SINTETICO, "NoExiste")).toThrow(/no se encontró/);
  });
});

describe("auditConnector -- caso negativo: capability sin contract test → hallazgo bloqueante", () => {
  it("una capability sin ninguna referencia `.nombre` en los archivos de evidencia se reporta como hallazgo bloqueante", () => {
    const root = crearDirTemporal();
    const portFile = escribirPuertoSintetico(root);
    // El archivo de "contract test" solo ejercita `status` y `hacerAlgo` --
    // `hacerOtraCosa` queda deliberadamente sin cubrir.
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(
      join(root, "tests/contract.spec.ts"),
      `
      it("status", () => { adapter.status(); });
      it("hacerAlgo", async () => { await adapter.hacerAlgo("x"); });
      `,
    );

    const spec: ConnectorAuditSpec = {
      id: "fake",
      label: "conector de prueba (FakeConnectorPort)",
      portFile,
      interfaceName: "FakeConnectorPort",
      contractTestFiles: ["tests/contract.spec.ts"],
    };

    const findings = auditConnector(spec, root);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.blocking).toBe(true);
    expect(findings[0]!.capability).toBe("hacerOtraCosa");
    expect(findings[0]!.message).toMatch(/no tiene contract test correspondiente/);
  });

  it("una capability cubierta en CUALQUIERA de los archivos declarados (no todos) no genera hallazgo", () => {
    const root = crearDirTemporal();
    const portFile = escribirPuertoSintetico(root);
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "tests/a.spec.ts"), `it("status", () => { adapter.status(); });`);
    writeFileSync(
      join(root, "tests/b.spec.ts"),
      `it("resto", async () => { await adapter.hacerAlgo("x"); await adapter.hacerOtraCosa(1); });`,
    );

    const spec: ConnectorAuditSpec = {
      id: "fake",
      label: "conector de prueba (FakeConnectorPort)",
      portFile,
      interfaceName: "FakeConnectorPort",
      contractTestFiles: ["tests/a.spec.ts", "tests/b.spec.ts"],
    };

    expect(auditConnector(spec, root)).toEqual([]);
  });

  it("un archivo de contract test declarado que no existe en disco es también hallazgo bloqueante (evidencia desactualizada)", () => {
    const root = crearDirTemporal();
    const portFile = escribirPuertoSintetico(root);

    const spec: ConnectorAuditSpec = {
      id: "fake",
      label: "conector de prueba (FakeConnectorPort)",
      portFile,
      interfaceName: "FakeConnectorPort",
      contractTestFiles: ["tests/no-existe.spec.ts"],
    };

    const findings = auditConnector(spec, root);
    // 1 hallazgo por el archivo ausente + 1 por cada una de las 3 capabilities (ninguna
    // cubierta, ya que su único archivo de evidencia no existe).
    expect(findings).toHaveLength(4);
    expect(findings.some((f) => f.message.includes("no existe"))).toBe(true);
  });
});

describe("auditConnector -- puerto ausente o renombrado", () => {
  it("si `portFile` no existe, reporta un hallazgo bloqueante en vez de lanzar sin contexto", () => {
    const root = crearDirTemporal();
    const spec: ConnectorAuditSpec = {
      id: "fake",
      label: "conector de prueba",
      portFile: "src/no-existe.ts",
      interfaceName: "FakeConnectorPort",
      contractTestFiles: [],
    };
    const findings = auditConnector(spec, root);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toMatch(/no existe/);
  });
});

describe("registro-conectores-pms.ts contra el repo real", () => {
  it("los 3 conectores reales (PMS/pago/CFDI) declarados en DEFAULT_CONNECTOR_SPECS cierran hoy en verde: 0 hallazgos", () => {
    const findings = auditAllConnectors();
    expect(findings).toEqual([]);
  });

  it("DEFAULT_CONNECTOR_SPECS cubre los 3 tipos de conector que el requisito nombra explícitamente: PMS, pago, CFDI", () => {
    expect(DEFAULT_CONNECTOR_SPECS.map((s) => s.id).sort()).toEqual(["cfdi", "pago", "pms"]);
  });
});
