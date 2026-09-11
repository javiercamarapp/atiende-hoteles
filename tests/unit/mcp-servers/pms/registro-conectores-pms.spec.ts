// REQ-REV-015 (BP-141, GOB-059): "Un subagente/proceso de auditoría de solo lectura
// debe verificar que cada capability declarada de un conector PMS tenga contract test y
// que no exista `if pms === X` fuera del registro central de conectores." Corre contra
// directorios/registros temporales sintéticos -- mismo patrón que
// tests/unit/mcp-servers/pms/registro-unico-conectores.spec.ts -- para no depender de
// ni poder romper el estado real del repo. La corrida real del check contra el repo
// real está documentada en docs/logs/REQ-REV-015/ (evidencia con comando + salida,
// incluyendo la corrida con una capability sin contract test deliberada), tal como
// exige el principio 1 de docs/ACEPTACION.md.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkCapabilityContractTests,
  collectDeclaredCapabilityTests,
} from "../../../../scripts/checks/registro-conectores-pms.ts";
import { PMS_CONNECTOR_REGISTRY, type PmsConnectorRegistryEntry } from "@atiende-hoteles/mcp-pms";

let dir: string | null = null;

function crearDirTemporal(): string {
  dir = mkdtempSync(join(tmpdir(), "registro-conectores-pms-"));
  return dir;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

const registryConCloudbedsImplementado: readonly PmsConnectorRegistryEntry[] = [
  {
    provider: "cloudbeds",
    priority: 1,
    label: "Cloudbeds",
    status: "implementado",
    capabilities: ["getReservation", "createCharge"],
    notes: "fixture de prueba",
  },
  {
    provider: "mews",
    priority: 2,
    label: "Mews",
    status: "pendiente",
    capabilities: [],
    notes: "fixture de prueba -- sin adaptador, no debe auditarse",
  },
];

describe("collectDeclaredCapabilityTests", () => {
  it("encuentra el marcador 'contrato-capacidad-pms: provider:capability' en un .spec.ts", () => {
    const root = crearDirTemporal();
    writeFileSync(
      join(root, "algo.spec.ts"),
      "describe('x', () => {\n" +
        "  // contrato-capacidad-pms: cloudbeds:getReservation\n" +
        "  it('cubre getReservation', () => {});\n" +
        "});\n",
    );
    const found = collectDeclaredCapabilityTests([root]);
    expect(found.has("cloudbeds:getReservation")).toBe(true);
  });

  it("ignora archivos que no terminan en .spec.ts/.spec.tsx", () => {
    const root = crearDirTemporal();
    writeFileSync(join(root, "notas.ts"), "// contrato-capacidad-pms: cloudbeds:getReservation\n");
    const found = collectDeclaredCapabilityTests([root]);
    expect(found.size).toBe(0);
  });

  it("ignora node_modules/dist anidados", () => {
    const root = crearDirTemporal();
    const nm = join(root, "node_modules", "algo");
    mkdirSync(nm, { recursive: true });
    writeFileSync(join(nm, "x.spec.ts"), "// contrato-capacidad-pms: cloudbeds:getReservation\n");
    const found = collectDeclaredCapabilityTests([root]);
    expect(found.size).toBe(0);
  });

  it("tolera espacios alrededor de los ':' entre provider y capability", () => {
    const root = crearDirTemporal();
    writeFileSync(join(root, "algo.spec.ts"), "// contrato-capacidad-pms:  cloudbeds  :  createCharge\n");
    const found = collectDeclaredCapabilityTests([root]);
    expect(found.has("cloudbeds:createCharge")).toBe(true);
  });
});

describe("checkCapabilityContractTests", () => {
  it("caso negativo real: una capability declarada SIN el marcador se reporta como hallazgo", () => {
    const root = crearDirTemporal();
    writeFileSync(
      join(root, "algo.spec.ts"),
      "// contrato-capacidad-pms: cloudbeds:getReservation\n" + "it('solo cubre getReservation', () => {});\n",
      // createCharge queda SIN marcador -- debe ser detectado.
    );
    const violations = checkCapabilityContractTests(registryConCloudbedsImplementado, [root]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ provider: "cloudbeds", capability: "createCharge" });
  });

  it("caso positivo: ambas capabilities con marcador -> 0 hallazgos", () => {
    const root = crearDirTemporal();
    writeFileSync(
      join(root, "algo.spec.ts"),
      "// contrato-capacidad-pms: cloudbeds:getReservation\n" +
        "it('a', () => {});\n" +
        "// contrato-capacidad-pms: cloudbeds:createCharge\n" +
        "it('b', () => {});\n",
    );
    const violations = checkCapabilityContractTests(registryConCloudbedsImplementado, [root]);
    expect(violations).toHaveLength(0);
  });

  it("un conector 'pendiente' con capabilities:[] nunca produce hallazgos, aunque no haya ningún test", () => {
    const root = crearDirTemporal();
    writeFileSync(join(root, "vacio.spec.ts"), "it('nada', () => {});\n");
    const violations = checkCapabilityContractTests(registryConCloudbedsImplementado, [root]);
    // Ambas violaciones son de cloudbeds (el único 'implementado'); mews no aporta ninguna
    // aunque no tenga ni un solo test -- confirma que "pendiente" no se audita.
    expect(violations.every((v) => v.provider === "cloudbeds")).toBe(true);
    expect(violations.map((v) => v.capability).sort()).toEqual(["createCharge", "getReservation"]);
  });

  it("verificado contra el repo real: 0 hallazgos hoy (evidencia repetible sin depender de docs/logs/)", () => {
    // Corre con los defaults reales (sin overrides) -- exactamente lo que ejecuta
    // `node scripts/checks/registro-conectores-pms.ts` en CI/local. Si esta prueba
    // falla, CI falla: mecanismo real del "hallazgo reportado" que exige
    // docs/ACEPTACION.md, no solo un script que hay que acordarse de correr aparte.
    const violations = checkCapabilityContractTests(PMS_CONNECTOR_REGISTRY);
    expect(violations).toEqual([]);
  });
});
