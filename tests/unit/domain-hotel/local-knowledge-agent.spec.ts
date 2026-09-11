// REQ-HUE-026 (docs/ACEPTACION.md): "el cambio queda reflejado ... en las respuestas del
// agente conversacional". Unit puro (sin BD) de `packages/domain-hotel/src/localKnowledgeAgent.ts`
// -- verifica: (1) detección de categoría por texto libre del huésped para cada categoría
// del criterio, (2) el caso negativo crítico: "clima" a secas o "el clima no funciona"
// (aire acondicionado) NUNCA debe detectarse como pregunta de conocimiento local -- esa
// frase ya está reservada a `classifyGuestMessage` (maintenance, REQ-HUE-014); una
// colisión aquí regresionaría un reporte real de AC descompuesto a una respuesta de
// pronóstico del tiempo, (3) mensajes sin ninguna categoría reconocida devuelven `null`,
// (4) composición de la respuesta a partir de entradas ya leídas (más reciente primero),
// y (5) el estado vacío honesto: sin entradas, `null`, nunca contenido inventado. El
// escenario end-to-end contra el webhook real + Postgres vive en
// `tests/integration/conocimiento-local/agente-conversacional.spec.ts`.
import { describe, expect, it } from "vitest";
import {
  LOCAL_KNOWLEDGE_QUERY_CATEGORIES,
  WHATSAPP_TEXT_MESSAGE_MAX_LENGTH,
  buildLocalKnowledgeReply,
  detectLocalKnowledgeCategory,
  type LocalKnowledgeEntryForAgent,
  type LocalKnowledgeQueryCategory,
} from "@atiende-hoteles/domain-hotel";

describe("detectLocalKnowledgeCategory — clasificación de preguntas de conocimiento local (REQ-HUE-026)", () => {
  const casos: [string, LocalKnowledgeQueryCategory][] = [
    ["¿Hay sargazo en la playa hoy?", "sargazo"],
    ["¿Cómo está el clima de hoy?", "clima"],
    ["¿Va a llover mañana?", "clima"],
    ["¿Está cerrada la playa por bandera roja?", "playa"],
    ["¿A qué hora sale el ferry a la isla?", "ferry"],
    ["¿Qué eventos hay esta semana en el hotel?", "eventos"],
  ];

  it.each(casos)("detecta %s como categoría %s", (mensaje, categoriaEsperada) => {
    expect(detectLocalKnowledgeCategory(mensaje)).toBe(categoriaEsperada);
  });

  it("un mensaje sin ninguna categoría reconocida devuelve null (cae al enrutamiento normal, nunca bloquea nada)", () => {
    expect(detectLocalKnowledgeCategory("¿A qué hora es el checkout?")).toBeNull();
  });

  it("mensaje vacío o indefinido devuelve null", () => {
    expect(detectLocalKnowledgeCategory("")).toBeNull();
    expect(detectLocalKnowledgeCategory("   ")).toBeNull();
    expect(detectLocalKnowledgeCategory(undefined)).toBeNull();
  });

  // Caso negativo crítico (ver comentario de archivo): "clima" en el vocabulario de un
  // huésped de hotel casi siempre es el aire acondicionado, no el pronóstico.
  it("NUNCA detecta 'clima' a secas ni la frase de mantenimiento como pregunta de conocimiento local", () => {
    expect(detectLocalKnowledgeCategory("El clima de mi habitación no funciona")).toBeNull();
    expect(detectLocalKnowledgeCategory("El clima no enfría, hace mucho calor en el cuarto")).toBeNull();
    expect(detectLocalKnowledgeCategory("¿Cuál es el clima de la habitación, calefacción o aire?")).toBeNull();
  });

  it("todas las categorías declaradas tienen al menos un caso de prueba cubierto arriba", () => {
    const cubiertas = new Set(casos.map(([, categoria]) => categoria));
    for (const categoria of LOCAL_KNOWLEDGE_QUERY_CATEGORIES) {
      expect(cubiertas.has(categoria)).toBe(true);
    }
  });
});

describe("buildLocalKnowledgeReply — composición de la respuesta a partir de entradas VIGENTES (REQ-HUE-026)", () => {
  it("sin ninguna entrada, devuelve null (estado vacío honesto, nunca contenido inventado)", () => {
    expect(buildLocalKnowledgeReply("sargazo", [])).toBeNull();
  });

  it("compone la respuesta con el contenido REAL de la entrada más reciente primero", () => {
    const entradas: LocalKnowledgeEntryForAgent[] = [
      { title: "Alerta de sargazo", content: "Sargazo moderado en playa norte.", updatedAt: "2026-09-01T10:00:00.000Z" },
      { title: "Actualización de sargazo", content: "Sargazo alto, se recomienda evitar la playa norte hoy.", updatedAt: "2026-09-05T10:00:00.000Z" },
    ];

    const respuesta = buildLocalKnowledgeReply("sargazo", entradas);

    expect(respuesta).not.toBeNull();
    // La entrada MÁS RECIENTE (la actualización del gerente) aparece primero -- es
    // exactamente el criterio de "reflejado en <30 s": la última escritura manda.
    const posicionActualizacion = respuesta!.indexOf("se recomienda evitar la playa norte hoy");
    const posicionOriginal = respuesta!.indexOf("Sargazo moderado en playa norte");
    expect(posicionActualizacion).toBeGreaterThanOrEqual(0);
    expect(posicionOriginal).toBeGreaterThan(posicionActualizacion);
  });

  it("nunca excede el límite real de un mensaje de texto de WhatsApp Cloud API", () => {
    const contenidoLargo = "x".repeat(4000);
    const entradas: LocalKnowledgeEntryForAgent[] = [
      { title: "Evento 1", content: contenidoLargo, updatedAt: "2026-09-01T10:00:00.000Z" },
      { title: "Evento 2", content: contenidoLargo, updatedAt: "2026-09-02T10:00:00.000Z" },
    ];

    const respuesta = buildLocalKnowledgeReply("eventos", entradas);

    expect(respuesta).not.toBeNull();
    expect(respuesta!.length).toBeLessThanOrEqual(WHATSAPP_TEXT_MESSAGE_MAX_LENGTH);
  });
});
