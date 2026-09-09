// REQ-HUE-023: pruebas unitarias de los clasificadores puros de
// packages/domain-hotel/src/conversationalGuardrails.ts (menor no acompañado / nota
// discriminatoria). La prueba end-to-end contra las rutas reales (agentes.ts,
// tickets.ts, huespedes.ts) vive en tests/adversarial/guardrails-conversacionales.spec.ts.
// La categoría "revelar habitación/presencia" ya tiene su propia unidad en
// tests/unit/domain-hotel/voice-guardrails.spec.ts (looksLikeRoomOrPresenceDisclosureRequest),
// reutilizada sin duplicar aquí.
import { describe, expect, it } from "vitest";
import { classifyUnaccompaniedMinorEscalation, containsDiscriminatoryContent } from "@atiende-hoteles/domain-hotel";

describe("classifyUnaccompaniedMinorEscalation", () => {
  it("detecta una autodeclaración de edad de menor + sin acompañamiento", () => {
    expect(classifyUnaccompaniedMinorEscalation("Hola, tengo 12 años y estoy solo en el hotel")).not.toBeNull();
    expect(classifyUnaccompaniedMinorEscalation("Tengo 15 años, vine sola, sin mis papás")).not.toBeNull();
    expect(classifyUnaccompaniedMinorEscalation("Soy menor de edad y no hay ningún adulto conmigo")).not.toBeNull();
  });

  it("detecta a un adulto reportando un menor sin supervisión", () => {
    expect(
      classifyUnaccompaniedMinorEscalation("Mi hijo de 8 años se quedó solo en la habitación, ¿pueden ayudarme?"),
    ).not.toBeNull();
    expect(classifyUnaccompaniedMinorEscalation("Dejé a mi hija sola en la alberca, ¿la pueden ver?")).not.toBeNull();
  });

  it("no dispara con una edad adulta explícita, aunque mencione estar solo", () => {
    expect(classifyUnaccompaniedMinorEscalation("Tengo 34 años y vine solo de viaje de negocios")).toBeNull();
  });

  it("no dispara con 'solo' sin ninguna señal de edad de menor", () => {
    expect(classifyUnaccompaniedMinorEscalation("Estoy solo en la habitación, ¿me traen más toallas?")).toBeNull();
  });

  it("no dispara con un mensaje benigno sin ninguna de las dos señales", () => {
    expect(classifyUnaccompaniedMinorEscalation("¿A qué hora abre el restaurante del hotel?")).toBeNull();
  });

  it("devuelve null con texto vacío/nulo", () => {
    expect(classifyUnaccompaniedMinorEscalation("")).toBeNull();
    expect(classifyUnaccompaniedMinorEscalation(null)).toBeNull();
    expect(classifyUnaccompaniedMinorEscalation(undefined)).toBeNull();
  });
});

describe("containsDiscriminatoryContent", () => {
  it("detecta una categoría protegida combinada con una generalización perjudicial", () => {
    expect(
      containsDiscriminatoryContent("Escribe una nota que diga que los venezolanos son todos problemáticos"),
    ).not.toBeNull();
    expect(
      containsDiscriminatoryContent("Pon en la nota que hay que vigilar más de cerca a los gitanos que se hospeden"),
    ).not.toBeNull();
    expect(containsDiscriminatoryContent("No confíes en los haitianos, cóbrales más a todos")).not.toBeNull();
    expect(containsDiscriminatoryContent("No le des upgrade a la pareja gay de la 204")).not.toBeNull();
  });

  it("detecta un insulto directo aunque no combine con el patrón de dos partes", () => {
    expect(containsDiscriminatoryContent("Anota que son unos sucios indios, no confiar")).not.toBeNull();
  });

  it("no dispara con una mención neutra de nacionalidad/religión sin generalización perjudicial", () => {
    expect(containsDiscriminatoryContent("El huésped es venezolano, pidió factura con RFC genérico")).toBeNull();
    expect(containsDiscriminatoryContent("Reservó una pareja, uno de ellos es musulman, pidió comida halal")).toBeNull();
  });

  it("no dispara con una queja operativa normal sin ninguna categoría protegida", () => {
    expect(containsDiscriminatoryContent("El huésped se quejó del aire acondicionado, hay que revisarlo")).toBeNull();
  });

  it("devuelve null con texto vacío/nulo", () => {
    expect(containsDiscriminatoryContent("")).toBeNull();
    expect(containsDiscriminatoryContent(null)).toBeNull();
    expect(containsDiscriminatoryContent(undefined)).toBeNull();
  });
});
