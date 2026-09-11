#!/usr/bin/env node
// REQ-AGT-021 (BP-136, BP-138): "Deben existir skills hoteleras: `pms-fixture-record`,
// `edge-lab`, `revenue-backtest` ... Cada skill ejecutable y documentada en
// `.claude/skills/`." Este es el CLI real detrás de la skill `edge-lab`
// (`.claude/skills/edge-lab/SKILL.md`).
//
// Qué es: un laboratorio de casos EXTREMOS/frontera contra los módulos de dominio
// PUROS ya existentes (folioEngine, fnbAllergyGuard, revenueEngineGate) -- nunca
// contra un mock inventado para esta skill. Cada escenario aquí reproduce una decisión
// de negocio real documentada en el módulo (fail-closed en identidad, tolerancia de
// redondeo exacta, discrepancia nunca overridable, etc.) y afirma el resultado
// ESPERADO -- si un cambio futuro en el dominio rompe una de estas fronteras, este
// laboratorio lo detecta antes de que llegue a producción, complementando (no
// sustituyendo) la suite de `tests/unit/domain-hotel/*.spec.ts`: aquella prueba
// cobertura amplia con Vitest; esta skill es la herramienta rápida que un operador
// corre a mano para "¿sigue aguantando esta frontera de negocio?" sin levantar todo
// Vitest.
//
// Uso: `node --experimental-strip-types scripts/skills/edge-lab.ts` -- sale con código
// 1 e imprime cada escenario que falló si alguno no produce el resultado esperado.
import {
  assertRoomChargeIdentityVerified,
  computeChargeAmounts,
  evaluateDiscountAuthorization,
  evaluateFolioClose,
} from "../../packages/domain-hotel/src/folioEngine.ts";
import { canAssureDishIsSafe, resolveAllergyDeclared } from "../../packages/domain-hotel/src/fnbAllergyGuard.ts";
import {
  evaluateGateTransition,
  isPriceChangeWithinProponeLimit,
} from "../../packages/domain-hotel/src/revenue/revenueEngineGate.ts";

export interface EdgeScenarioResult {
  readonly id: string;
  readonly module: string;
  readonly description: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface EdgeScenario {
  readonly id: string;
  readonly module: string;
  readonly description: string;
  readonly run: () => Omit<EdgeScenarioResult, "id" | "module" | "description">;
}

function assertEqual(actual: unknown, expected: unknown, label: string): { ok: boolean; detail: string } {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  return {
    ok,
    detail: ok
      ? `OK: ${label} = ${JSON.stringify(actual)}`
      : `FALLA: ${label} esperado ${JSON.stringify(expected)}, obtenido ${JSON.stringify(actual)}`,
  };
}

function assertThrows(fn: () => unknown, label: string): { ok: boolean; detail: string } {
  try {
    fn();
    return { ok: false, detail: `FALLA: ${label} debía lanzar y no lanzó.` };
  } catch (err) {
    return { ok: true, detail: `OK: ${label} lanzó "${(err as Error).message}"` };
  }
}

const TAX_CONFIG = { ivaRate: 0.16, ishRate: 0.03 };

export const SCENARIOS: EdgeScenario[] = [
  // --- folioEngine: frontera de redondeo de cierre de folio ------------------------
  {
    id: "folio-cierre-frontera-redondeo-dentro",
    module: "folioEngine",
    description: 'evaluateFolioClose con balance exactamente en la tolerancia (0.01) debe permitir "saldo_cero".',
    run: () =>
      assertEqual(
        evaluateFolioClose({ balance: 0.01, reason: "saldo_cero", actorHasAdminRole: false }).allowed,
        true,
        "allowed",
      ),
  },
  {
    id: "folio-cierre-frontera-redondeo-fuera",
    module: "folioEngine",
    description: 'evaluateFolioClose con balance justo FUERA de la tolerancia (0.011) debe rechazar "saldo_cero".',
    run: () =>
      assertEqual(
        evaluateFolioClose({ balance: 0.011, reason: "saldo_cero", actorHasAdminRole: false }).allowed,
        false,
        "allowed",
      ),
  },
  {
    id: "folio-cargo-negativo-rechazado",
    module: "folioEngine",
    description: "computeChargeAmounts con netAmount negativo debe lanzar (nunca aceptar un cargo negativo real).",
    run: () => assertThrows(() => computeChargeAmounts({ concept: "hospedaje", netAmount: -100, taxConfig: TAX_CONFIG }), "computeChargeAmounts(-100)"),
  },
  {
    id: "folio-propina-nunca-lleva-impuesto",
    module: "folioEngine",
    description: "computeChargeAmounts para concepto propina jamás debe generar taxAmount, incluso con tasas altas.",
    run: () =>
      assertEqual(
        computeChargeAmounts({ concept: "propina", netAmount: 500, taxConfig: { ivaRate: 0.5, ishRate: 0.5 } }).taxAmount,
        0,
        "taxAmount",
      ),
  },
  {
    id: "folio-descuento-frontera-umbral-exacto",
    module: "folioEngine",
    description: "evaluateDiscountAuthorization con amount == thresholdAmount exacto debe permitirse sin rol admin.",
    run: () =>
      assertEqual(
        evaluateDiscountAuthorization({ amount: 1000, thresholdAmount: 1000, actorHasAdminRole: false }).allowed,
        true,
        "allowed",
      ),
  },
  {
    id: "folio-descuento-un-centavo-sobre-umbral-sin-autorizacion",
    module: "folioEngine",
    description: "evaluateDiscountAuthorization con amount 1 centavo sobre el umbral y sin admin/autorización debe rechazarse.",
    run: () =>
      assertEqual(
        evaluateDiscountAuthorization({ amount: 1000.01, thresholdAmount: 1000, actorHasAdminRole: false }).allowed,
        false,
        "allowed",
      ),
  },
  {
    id: "folio-identidad-discrepancia-nunca-overridable-por-admin",
    module: "folioEngine",
    description:
      "assertRoomChargeIdentityVerified con una DISCREPANCIA activa (apellido no coincide) debe rechazar incluso con actorHasAdminRole=true -- caso adversarial central del módulo (ver docstring de RoomChargeIdentityVerificationInput).",
    run: () =>
      assertEqual(
        assertRoomChargeIdentityVerified({
          concept: "extras",
          claim: { declaredLastName: "Impostor", declaredPhoneLast4: "0000" },
          guestLastName: "Reyes",
          guestPhoneLast4: "1234",
          actorHasAdminRole: true,
          authorizedByAdminUserId: "admin-1",
        }).allowed,
        false,
        "allowed",
      ),
  },
  {
    id: "folio-identidad-ausencia-de-reclamo-si-overridable-por-admin",
    module: "folioEngine",
    description:
      "assertRoomChargeIdentityVerified sin reclamo presentado (no discrepancia, solo ausencia) SÍ es overridable con rol admin -- distingue ausencia de discrepancia.",
    run: () =>
      assertEqual(
        assertRoomChargeIdentityVerified({
          concept: "extras",
          claim: null,
          guestLastName: "Reyes",
          guestPhoneLast4: "1234",
          actorHasAdminRole: true,
        }).allowed,
        true,
        "allowed",
      ),
  },
  // --- fnbAllergyGuard: red de seguridad de texto libre no reconocido --------------
  {
    id: "allergy-texto-libre-no-reconocido-se-trata-como-declarado",
    module: "fnbAllergyGuard",
    description:
      'resolveAllergyDeclared con una nota que NO calza el regex de alergia pero tampoco está vacía ("quedé hospitalizado por lo que comí") debe tratarse como declarada (mitigación interim documentada en el módulo).',
    run: () =>
      assertEqual(
        resolveAllergyDeclared({ structuredFlag: false, freeTextFields: ["quedé hospitalizado por lo que comí ahí"] }).allergyDeclared,
        true,
        "allergyDeclared",
      ),
  },
  {
    id: "allergy-nota-vacia-no-declara",
    module: "fnbAllergyGuard",
    description: "resolveAllergyDeclared con notas vacías/null y sin flag estructurado no debe declarar alergia (evita falsos positivos permanentes).",
    run: () =>
      assertEqual(
        resolveAllergyDeclared({ structuredFlag: false, freeTextFields: [null, "", "   "] }).allergyDeclared,
        false,
        "allergyDeclared",
      ),
  },
  {
    id: "allergy-sin-confirmacion-cocina-nunca-asegura",
    module: "fnbAllergyGuard",
    description: "canAssureDishIsSafe con alergia declarada y kitchenConfirmedBy=null jamás debe devolver true.",
    run: () => assertEqual(canAssureDishIsSafe({ allergyDeclared: true, kitchenConfirmedBy: null }), false, "canAssureDishIsSafe"),
  },
  // --- revenueEngineGate: fronteras de la máquina de estados -----------------------
  {
    id: "revenue-shadow-a-autopilot-directo-bloqueado",
    module: "revenueEngineGate",
    description: 'evaluateGateTransition("shadow" -> "autopilot") directo (saltando "propone") debe estar SIEMPRE bloqueado.',
    run: () => assertEqual(evaluateGateTransition("shadow", "autopilot").allowed, false, "allowed"),
  },
  {
    id: "revenue-variacion-frontera-exacta-15pct-permitida",
    module: "revenueEngineGate",
    description: "isPriceChangeWithinProponeLimit con variación exactamente en el límite superior (15%) debe permitirse (frontera inclusiva, con épsilon de punto flotante).",
    run: () => assertEqual(isPriceChangeWithinProponeLimit(1000, 1150, 15), true, "withinLimit"),
  },
  {
    id: "revenue-variacion-un-centesimo-sobre-15pct-rechazada",
    module: "revenueEngineGate",
    description: "isPriceChangeWithinProponeLimit con variación apenas sobre el 15% (15.1%) debe rechazarse.",
    run: () => assertEqual(isPriceChangeWithinProponeLimit(1000, 1151, 15), false, "withinLimit"),
  },
  {
    id: "revenue-demotion-siempre-permitida-sin-contexto",
    module: "revenueEngineGate",
    description: "evaluateGateTransition de una democión (autopilot -> shadow) debe permitirse SIEMPRE, incluso sin ningún contexto (freno de emergencia).",
    run: () => assertEqual(evaluateGateTransition("autopilot", "shadow", {}).allowed, true, "allowed"),
  },
];

export function runEdgeLab(scenarios: readonly EdgeScenario[] = SCENARIOS): EdgeScenarioResult[] {
  return scenarios.map((s) => ({ id: s.id, module: s.module, description: s.description, ...s.run() }));
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const results = runEdgeLab();
  const failed = results.filter((r) => !r.ok);

  for (const r of results) {
    console.log(`[${r.ok ? "PASS" : "FAIL"}] ${r.module}/${r.id}: ${r.detail}`);
  }

  if (failed.length > 0) {
    console.error(`\nedge-lab: ${failed.length}/${results.length} escenario(s) de frontera FALLARON.`);
    process.exit(1);
  }
  console.log(`\nedge-lab OK: ${results.length}/${results.length} escenario(s) de frontera pasaron.`);
  process.exit(0);
}
