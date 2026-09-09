// REQ-HUE-014 (docs/ACEPTACION.md): "Cada mensaje/petición del huésped se convierte en
// ticket con departamento/habitación/prioridad/SLA". Unit puro (sin BD, sin reloj real)
// de `packages/domain-hotel/src/tickets/slaPolicy.ts` -- verifica: (1) la clasificación
// heurística departamento+prioridad para cada categoría del criterio, (2) el default
// "frontdesk"/"media" cuando el mensaje no matchea ningún departamento conocido, (3) la
// resolución de SLA (política configurada > default por prioridad), (4) el cómputo de
// vencimiento y (5) la detección de vencimiento con un reloj INYECTADO (nunca
// `Date.now()`), incluyendo el caso límite exacto (ni antes ni después del vencimiento).
// El escenario de integración real contra PGlite/embedded-postgres (creación de ticket +
// escalación automática end-to-end) vive en
// `tests/integration/tickets/sla-escalado.spec.ts`.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SLA_MINUTES_BY_PRIORITY,
  GUEST_TICKET_DEPARTMENTS,
  GUEST_TICKET_PRIORITIES,
  classifyGuestMessage,
  computeSlaDueAt,
  isSlaOverdue,
  resolveSlaMinutes,
} from "@atiende-hoteles/domain-hotel";
import { DEFAULT_SLA_MINUTES_BY_PRIORITY as AGENT_CORE_DEFAULT_SLA_MINUTES_BY_PRIORITY } from "@atiende-hoteles/agent-core";

describe("classifyGuestMessage — heurística departamento+prioridad (REQ-HUE-014)", () => {
  const casos: [string, (typeof GUEST_TICKET_DEPARTMENTS)[number]][] = [
    ["El aire acondicionado de mi habitación no funciona.", "maintenance"],
    ["Se está inundando el baño, hay una fuga de agua.", "maintenance"],
    ["¿Podrían mandarme más toallas y jabón a la habitación?", "housekeeping"],
    ["Mi habitación está muy sucia, necesita limpieza urgente.", "housekeeping"],
    ["Quisiera pedir servicio a la habitación, el room service.", "fnb"],
    ["Necesito una copia de mi factura de la reserva.", "reservations"],
    ["¿A qué hora abre la alberca?", "frontdesk"],
  ];

  it.each(casos)("clasifica %s como departamento %s", (mensaje, departamentoEsperado) => {
    expect(classifyGuestMessage(mensaje).department).toBe(departamentoEsperado);
  });

  it("un mensaje ambiguo, sin ninguna palabra clave conocida, cae en frontdesk/media (nunca bloquea la creación del ticket)", () => {
    const resultado = classifyGuestMessage("Buenos días, quería comentarles algo sobre mi estancia.");
    expect(resultado.department).toBe("frontdesk");
    expect(resultado.priority).toBe("media");
  });

  it("detecta prioridad alta con lenguaje de emergencia/urgencia", () => {
    expect(classifyGuestMessage("¡Emergencia! No hay luz en todo el pasillo.").priority).toBe("alta");
    expect(classifyGuestMessage("Se está inundando el baño ahora mismo.").priority).toBe("alta");
  });

  it("detecta prioridad baja cuando el huésped indica que no hay prisa", () => {
    expect(classifyGuestMessage("Cuando puedan, me gustaría más shampoo, sin prisa.").priority).toBe("baja");
  });

  it("prioridad por defecto es media cuando no hay señal de urgencia ni de calma", () => {
    expect(classifyGuestMessage("El wifi va lento en mi habitación.").priority).toBe("media");
  });

  it("es determinístico: el mismo texto siempre produce la misma clasificación", () => {
    const texto = "El aire acondicionado no prende, es urgente.";
    expect(classifyGuestMessage(texto)).toEqual(classifyGuestMessage(texto));
  });

  it("ignora acentos/mayúsculas al clasificar (mismo criterio de normalización que reputacion/clasificador.ts)", () => {
    expect(classifyGuestMessage("EL AIRE ACONDICIONADO NO FUNCIONA").department).toBe("maintenance");
    expect(classifyGuestMessage("el áire acondicionádo no fúnciona").department).toBe("maintenance");
  });
});

describe("resolveSlaMinutes / computeSlaDueAt / isSlaOverdue (REQ-HUE-014, reloj inyectado)", () => {
  it("usa el default por prioridad cuando el hotel no configuró una política propia", () => {
    for (const priority of GUEST_TICKET_PRIORITIES) {
      expect(resolveSlaMinutes(undefined, priority)).toBe(DEFAULT_SLA_MINUTES_BY_PRIORITY[priority]);
      expect(resolveSlaMinutes(null, priority)).toBe(DEFAULT_SLA_MINUTES_BY_PRIORITY[priority]);
    }
  });

  it("usa la política configurada del hotel cuando existe, en vez del default", () => {
    expect(resolveSlaMinutes(15, "alta")).toBe(15);
    expect(resolveSlaMinutes(15, "alta")).not.toBe(DEFAULT_SLA_MINUTES_BY_PRIORITY.alta);
  });

  it("ignora una política configurada inválida (<= 0) y cae al default", () => {
    expect(resolveSlaMinutes(0, "media")).toBe(DEFAULT_SLA_MINUTES_BY_PRIORITY.media);
    expect(resolveSlaMinutes(-5, "media")).toBe(DEFAULT_SLA_MINUTES_BY_PRIORITY.media);
  });

  it("computeSlaDueAt suma exactamente los minutos de SLA a la fecha de creación", () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    expect(computeSlaDueAt(createdAt, 30).toISOString()).toBe("2026-01-01T00:30:00.000Z");
    expect(computeSlaDueAt(createdAt, 480).toISOString()).toBe("2026-01-01T08:00:00.000Z");
  });

  it("isSlaOverdue: reloj simulado exactamente en el vencimiento NO está vencido; un instante después SÍ", () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const slaDueAt = computeSlaDueAt(createdAt, 30);

    expect(isSlaOverdue(slaDueAt, slaDueAt)).toBe(false);
    expect(isSlaOverdue(new Date(slaDueAt.getTime() - 1), slaDueAt)).toBe(false);
    expect(isSlaOverdue(new Date(slaDueAt.getTime() + 1), slaDueAt)).toBe(true);
  });

  it("isSlaOverdue: reloj simulado muy por delante del SLA (caso del criterio de aceptación) reporta vencido", () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const slaDueAt = computeSlaDueAt(createdAt, DEFAULT_SLA_MINUTES_BY_PRIORITY.alta);
    const relojSimuladoUnaHoraDespues = new Date(createdAt.getTime() + 60 * 60_000);
    expect(isSlaOverdue(relojSimuladoUnaHoraDespues, slaDueAt)).toBe(true);
  });
});

// `packages/agent-core/src/tools/ticketTools.ts` mantiene su PROPIA copia de
// `DEFAULT_SLA_MINUTES_BY_PRIORITY` (H6a: agent-core es núcleo puro sin dependencia a
// domain-hotel, mismo criterio que `StaffRole` en context.ts) -- esta prueba, desde este
// paquete (domain-hotel, que sí puede importar agent-core como devDependency de test),
// falla si las dos copias alguna vez divergen en silencio.
describe("paridad entre domain-hotel y agent-core (evita que las dos copias del default diverjan)", () => {
  it("DEFAULT_SLA_MINUTES_BY_PRIORITY es idéntico en domain-hotel y en agent-core", () => {
    expect(AGENT_CORE_DEFAULT_SLA_MINUTES_BY_PRIORITY).toEqual(DEFAULT_SLA_MINUTES_BY_PRIORITY);
  });
});
