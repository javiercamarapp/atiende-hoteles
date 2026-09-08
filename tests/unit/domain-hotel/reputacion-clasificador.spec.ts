// REQ-CRM-002 (P1/F): clasificador de reseñas/encuestas por tema + sentimiento, y
// decisión de la acción reglada correspondiente. Verifica: (1) cada tema del criterio
// de aceptación (limpieza, personal, ubicación, wifi, ruido, AC, desayuno, check-in,
// precio, sargazo), (2) un tema LOCAL NO ENTRENADO PREVIAMENTE (ninguna palabra clave
// del diccionario base) sigue clasificándose, (3) sentimiento con negación e
// intensificadores, (4) las 3 acciones regladas (ticket, mensaje proactivo,
// compensación) se disparan o no según corresponda.
import { describe, expect, it } from "vitest";
import {
  analizarSentimiento,
  clasificarResena,
  decidirAcciones,
  detectarTemas,
  COMPENSATION_CATALOG,
  TICKET_TOPICS,
  type TopicMatch,
} from "@atiende-hoteles/domain-hotel";

describe("detectarTemas — diccionario base (REQ-CRM-002)", () => {
  const casos: [string, string][] = [
    ["El baño estaba muy sucio y con moho en la regadera.", "limpieza"],
    ["El recepcionista fue muy grosero con nosotros.", "personal"],
    ["El hotel está muy alejado del centro, la ubicación es mala.", "ubicacion"],
    ["El wifi no funcionó en toda la estancia.", "wifi"],
    ["Hubo mucho ruido de los vecinos toda la noche, no dejaban dormir.", "ruido"],
    ["El aire acondicionado del cuarto no enfriaba nada.", "aire_acondicionado"],
    ["El desayuno buffet estaba frío y repetido todos los días.", "desayuno"],
    ["El check-in tardó más de una hora.", "check_in"],
    ["El precio es muy caro para lo que ofrece.", "precio"],
    ["Había demasiado sargazo en la playa, no se podía nadar.", "sargazo"],
  ];

  it.each(casos)("detecta el tema esperado en: %s", (texto, temaEsperado) => {
    const temas = detectarTemas(texto);
    const encontrado = temas.find((t) => t.topic === temaEsperado);
    expect(encontrado).toBeDefined();
    expect(encontrado?.esConocido).toBe(true);
    expect(encontrado?.menciones).toBeGreaterThan(0);
  });

  it("detecta varios temas a la vez en una reseña mixta", () => {
    const temas = detectarTemas("El wifi no sirvió y el desayuno estaba frío, pero el personal fue amable.");
    const ids = temas.map((t) => t.topic);
    expect(ids).toContain("wifi");
    expect(ids).toContain("desayuno");
    expect(ids).toContain("personal");
  });

  it("no detecta ningún tema conocido en un texto genérico sin palabras clave ni carga de sentimiento", () => {
    const temas = detectarTemas("Llegamos por la tarde y salimos temprano al día siguiente.");
    expect(temas.filter((t) => t.esConocido)).toHaveLength(0);
  });
});

describe("detectarTemas — tema LOCAL no entrenado previamente (criterio explícito de REQ-CRM-002)", () => {
  it("descubre un tema completamente nuevo (ninguna keyword del diccionario base) junto a una palabra de sentimiento negativo", () => {
    // "iguanas" no aparece en NINGÚN diccionario de TOPIC_KEYWORDS -- el criterio exige
    // clasificar igual "temas locales no entrenados previamente".
    const temas = detectarTemas("Había iguanas sueltas cerca de la alberca y eso nos dio mucho miedo.");
    const local = temas.find((t) => t.topic === "local:iguanas");
    expect(local).toBeDefined();
    expect(local?.esConocido).toBe(false);
    // "alberca" sigue detectándose como tema conocido en la misma reseña.
    expect(temas.some((t) => t.topic === "alberca")).toBe(true);
  });

  it("descubre un tema local distinto con una palabra de sentimiento positivo", () => {
    // "jacarandas" tampoco existe en ningún diccionario.
    const temas = detectarTemas("Las jacarandas del jardín son hermosas, un detalle que no esperábamos.");
    const local = temas.find((t) => t.topic === "local:jacarandas");
    expect(local).toBeDefined();
    expect(local?.esConocido).toBe(false);
  });

  it("un tema ya configurado como local del hotel se reporta como esConocido: true", () => {
    const temas = detectarTemas("Los mosquitos en el jardín fueron un problema toda la noche.", {
      mosquitos: ["mosquito", "mosquitos"],
    });
    const encontrado = temas.find((t) => t.topic === "local:mosquitos");
    expect(encontrado).toBeDefined();
    expect(encontrado?.esConocido).toBe(true);
  });

  it("no genera temas locales fantasma en un texto neutro sin ninguna palabra de sentimiento", () => {
    const temas = detectarTemas("El vuelo salió a las 8am y llegamos al mediodía al aeropuerto de Cancún.");
    expect(temas.filter((t) => !t.esConocido)).toHaveLength(0);
  });
});

describe("analizarSentimiento — léxico con negación e intensificadores", () => {
  it("clasifica una reseña claramente positiva", () => {
    const r = analizarSentimiento("El servicio fue excelente y el personal muy amable, todo perfecto.");
    expect(r.etiqueta).toBe("muy_positivo");
    expect(r.puntaje).toBeGreaterThan(0);
  });

  it("clasifica una reseña claramente negativa", () => {
    const r = analizarSentimiento("Todo fue terrible, el cuarto estaba sucio y el trato fue pésimo.");
    expect(r.etiqueta).toBe("muy_negativo");
    expect(r.puntaje).toBeLessThan(0);
  });

  it("un intensificador ('muy') aumenta la magnitud negativa frente a la misma palabra sin intensificar", () => {
    const sinIntensificar = analizarSentimiento("El cuarto estaba sucio.");
    const intensificado = analizarSentimiento("El cuarto estaba muy sucio.");
    expect(intensificado.puntaje).toBeLessThan(sinIntensificar.puntaje);
  });

  it("la negación invierte el signo: 'no fue bueno' es negativo, no positivo", () => {
    const r = analizarSentimiento("El servicio no fue bueno.");
    expect(r.puntaje).toBeLessThan(0);
  });

  it("'nunca' como negación invierte una palabra positiva a distancia", () => {
    const r = analizarSentimiento("Nunca me sentí satisfecho con el servicio.");
    expect(r.puntaje).toBeLessThan(0);
  });

  it("texto neutro sin calificación se clasifica como neutral", () => {
    const r = analizarSentimiento("Llegamos el martes y nos fuimos el viernes.");
    expect(r.etiqueta).toBe("neutral");
    expect(r.puntaje).toBe(0);
  });

  it("una calificación baja (1 estrella) sin texto de carga vuelve negativa la clasificación", () => {
    const r = analizarSentimiento("Llegamos el martes y nos fuimos el viernes.", 1);
    expect(["negativo", "muy_negativo"]).toContain(r.etiqueta);
  });

  it("una calificación alta (5 estrellas) combinada con texto negativo modera el puntaje final", () => {
    const soloTexto = analizarSentimiento("El cuarto estaba sucio.");
    const conCalificacionAlta = analizarSentimiento("El cuarto estaba sucio.", 5);
    expect(conCalificacionAlta.puntaje).toBeGreaterThan(soloTexto.puntaje);
  });
});

describe("decidirAcciones — ticket de mantenimiento", () => {
  const temaWifi: TopicMatch = { topic: "wifi", esConocido: true, menciones: 2, palabrasClave: ["wifi"] };
  const temaPrecio: TopicMatch = { topic: "precio", esConocido: true, menciones: 1, palabrasClave: ["caro"] };

  it("dispara ticket_mantenimiento para un tema reparable (wifi) con sentimiento negativo", () => {
    const acciones = decidirAcciones({
      texto: "El wifi no funcionó.",
      temas: [temaWifi],
      sentimiento: { etiqueta: "negativo", puntaje: -0.4 },
      estanciaEstado: "desconocido",
      huespedId: null,
    });
    const ticket = acciones.find((a) => a.tipo === "ticket_mantenimiento");
    expect(ticket).toBeDefined();
    expect(ticket && ticket.tipo === "ticket_mantenimiento" && ticket.tema).toBe("wifi");
    expect(ticket && ticket.tipo === "ticket_mantenimiento" && ticket.severidad).toBe("media");
  });

  it("severidad 'alta' cuando el sentimiento es muy_negativo", () => {
    const acciones = decidirAcciones({
      texto: "El wifi nunca funcionó, pésimo.",
      temas: [temaWifi],
      sentimiento: { etiqueta: "muy_negativo", puntaje: -0.9 },
      estanciaEstado: "desconocido",
      huespedId: null,
    });
    const ticket = acciones.find((a) => a.tipo === "ticket_mantenimiento");
    expect(ticket && ticket.tipo === "ticket_mantenimiento" && ticket.severidad).toBe("alta");
  });

  it("NO dispara ticket_mantenimiento para un tema no reparable (precio), aunque sea negativo", () => {
    const acciones = decidirAcciones({
      texto: "Es muy caro.",
      temas: [temaPrecio],
      sentimiento: { etiqueta: "negativo", puntaje: -0.4 },
      estanciaEstado: "desconocido",
      huespedId: null,
    });
    expect(acciones.some((a) => a.tipo === "ticket_mantenimiento")).toBe(false);
  });

  it("NO dispara ningún ticket cuando el sentimiento es positivo, aunque el tema sea reparable", () => {
    const acciones = decidirAcciones({
      texto: "El wifi funcionó de maravilla.",
      temas: [temaWifi],
      sentimiento: { etiqueta: "positivo", puntaje: 0.5 },
      estanciaEstado: "desconocido",
      huespedId: null,
    });
    expect(acciones).toHaveLength(0);
  });

  it("todo topic en TICKET_TOPICS tiene sentido como defecto físico/operativo reparable", () => {
    expect([...TICKET_TOPICS]).toEqual(
      expect.arrayContaining(["limpieza", "wifi", "ruido", "aire_acondicionado", "alberca"]),
    );
    expect(TICKET_TOPICS.has("precio")).toBe(false);
    expect(TICKET_TOPICS.has("personal")).toBe(false);
  });
});

describe("decidirAcciones — mensaje proactivo", () => {
  const temaRuido: TopicMatch = { topic: "ruido", esConocido: true, menciones: 1, palabrasClave: ["ruido"] };

  it("dispara mensaje_proactivo cuando el huésped está EN ESTANCIA, identificado, y el sentimiento es negativo", () => {
    const acciones = decidirAcciones({
      texto: "Hay mucho ruido, no puedo dormir.",
      temas: [temaRuido],
      sentimiento: { etiqueta: "negativo", puntaje: -0.4 },
      estanciaEstado: "en_estancia",
      huespedId: "guest-1",
    });
    expect(acciones.some((a) => a.tipo === "mensaje_proactivo")).toBe(true);
  });

  it("NO dispara mensaje_proactivo si el huésped ya se fue (post_estancia)", () => {
    const acciones = decidirAcciones({
      texto: "Hubo mucho ruido durante mi estancia.",
      temas: [temaRuido],
      sentimiento: { etiqueta: "negativo", puntaje: -0.4 },
      estanciaEstado: "post_estancia",
      huespedId: "guest-1",
    });
    expect(acciones.some((a) => a.tipo === "mensaje_proactivo")).toBe(false);
  });

  it("NO dispara mensaje_proactivo sin huésped identificado (reseña pública anónima)", () => {
    const acciones = decidirAcciones({
      texto: "Hubo mucho ruido.",
      temas: [temaRuido],
      sentimiento: { etiqueta: "negativo", puntaje: -0.4 },
      estanciaEstado: "en_estancia",
      huespedId: null,
    });
    expect(acciones.some((a) => a.tipo === "mensaje_proactivo")).toBe(false);
  });

  it("NO dispara mensaje_proactivo cuando el sentimiento no es negativo", () => {
    const acciones = decidirAcciones({
      texto: "Todo tranquilo por aquí.",
      temas: [],
      sentimiento: { etiqueta: "neutral", puntaje: 0 },
      estanciaEstado: "en_estancia",
      huespedId: "guest-1",
    });
    expect(acciones.some((a) => a.tipo === "mensaje_proactivo")).toBe(false);
  });
});

describe("decidirAcciones — compensación reglada", () => {
  const temaSargazo: TopicMatch = { topic: "sargazo", esConocido: true, menciones: 2, palabrasClave: ["sargazo"] };
  const temaPersonal: TopicMatch = { topic: "personal", esConocido: true, menciones: 1, palabrasClave: ["grosero"] };

  it("dispara compensacion_reglada para un tema del catálogo con sentimiento muy_negativo y huésped identificado", () => {
    const acciones = decidirAcciones({
      texto: "Demasiado sargazo, no se podía ni entrar al mar, pésima experiencia.",
      temas: [temaSargazo],
      sentimiento: { etiqueta: "muy_negativo", puntaje: -0.9 },
      estanciaEstado: "post_estancia",
      huespedId: "guest-1",
    });
    const comp = acciones.find((a) => a.tipo === "compensacion_reglada");
    expect(comp).toBeDefined();
    expect(comp && comp.tipo === "compensacion_reglada" && comp.compensacion).toEqual(COMPENSATION_CATALOG.sargazo);
  });

  it("NO dispara compensación sin huésped identificado, aunque el tema esté en el catálogo y sea muy_negativo", () => {
    const acciones = decidirAcciones({
      texto: "Demasiado sargazo.",
      temas: [temaSargazo],
      sentimiento: { etiqueta: "muy_negativo", puntaje: -0.9 },
      estanciaEstado: "desconocido",
      huespedId: null,
    });
    expect(acciones.some((a) => a.tipo === "compensacion_reglada")).toBe(false);
  });

  it("NO dispara compensación para un tema fuera del catálogo (personal), aunque sea muy_negativo", () => {
    const acciones = decidirAcciones({
      texto: "El personal fue grosero y pésimo.",
      temas: [temaPersonal],
      sentimiento: { etiqueta: "muy_negativo", puntaje: -0.9 },
      estanciaEstado: "post_estancia",
      huespedId: "guest-1",
    });
    expect(acciones.some((a) => a.tipo === "compensacion_reglada")).toBe(false);
  });

  it("NO dispara compensación cuando el sentimiento es solo 'negativo' (no 'muy_negativo')", () => {
    const acciones = decidirAcciones({
      texto: "Había algo de sargazo.",
      temas: [temaSargazo],
      sentimiento: { etiqueta: "negativo", puntaje: -0.3 },
      estanciaEstado: "post_estancia",
      huespedId: "guest-1",
    });
    expect(acciones.some((a) => a.tipo === "compensacion_reglada")).toBe(false);
  });

  it("nunca dispara compensación para un tema LOCAL descubierto (no está en ningún catálogo reglado)", () => {
    const temaLocal: TopicMatch = { topic: "local:iguanas", esConocido: false, menciones: 1, palabrasClave: ["iguanas"] };
    const acciones = decidirAcciones({
      texto: "Las iguanas nos dieron terror, pésima experiencia.",
      temas: [temaLocal],
      sentimiento: { etiqueta: "muy_negativo", puntaje: -0.9 },
      estanciaEstado: "post_estancia",
      huespedId: "guest-1",
    });
    expect(acciones.some((a) => a.tipo === "compensacion_reglada")).toBe(false);
  });
});

describe("clasificarResena — punto de entrada combinado (caso de aceptación completo)", () => {
  it("un tema local nuevo con sentimiento muy negativo, huésped en estancia: clasifica y dispara acción (criterio de ACEPTACION.md)", () => {
    // "cucarachas" no está en ningún diccionario -- el criterio de aceptación pide
    // verificar exactamente esto: "un tema local nuevo → clasificado y acción disparada".
    const resultado = clasificarResena({
      texto: "Vimos cucarachas en el baño, es terrible y asqueroso, nunca había pasado esto.",
      estanciaEstado: "en_estancia",
      huespedId: "guest-42",
    });

    const temaLocal = resultado.temas.find((t) => t.topic === "local:cucarachas");
    expect(temaLocal).toBeDefined();
    expect(temaLocal?.esConocido).toBe(false);
    expect(resultado.sentimiento.etiqueta).toBe("muy_negativo");
    // Sin tema conocido reparable ni en catálogo de compensación: la acción disparada
    // es el mensaje proactivo (huésped identificado, en estancia, sentimiento negativo).
    expect(resultado.acciones.some((a) => a.tipo === "mensaje_proactivo")).toBe(true);
  });

  it("una reseña positiva no dispara ninguna acción", () => {
    const resultado = clasificarResena({
      texto: "Todo excelente, el personal fue increíble y el desayuno delicioso.",
      calificacion: 5,
      estanciaEstado: "post_estancia",
      huespedId: "guest-1",
    });
    expect(["positivo", "muy_positivo"]).toContain(resultado.sentimiento.etiqueta);
    expect(resultado.acciones).toHaveLength(0);
  });

  it("AC roto durante la estancia de un huésped identificado dispara TICKET + mensaje proactivo a la vez", () => {
    const resultado = clasificarResena({
      texto: "El aire acondicionado está descompuesto, hace muchísimo calor, es horrible.",
      estanciaEstado: "en_estancia",
      huespedId: "guest-7",
    });
    expect(resultado.temas.some((t) => t.topic === "aire_acondicionado")).toBe(true);
    expect(resultado.sentimiento.etiqueta).toBe("muy_negativo");
    expect(resultado.acciones.some((a) => a.tipo === "ticket_mantenimiento")).toBe(true);
    expect(resultado.acciones.some((a) => a.tipo === "mensaje_proactivo")).toBe(true);
    expect(resultado.acciones.some((a) => a.tipo === "compensacion_reglada")).toBe(true);
  });

  it("sin huésped identificado (reseña pública de una OTA), solo se dispara el ticket -- no mensaje ni compensación", () => {
    const resultado = clasificarResena({
      texto: "El aire acondicionado está descompuesto, hace muchísimo calor, es horrible.",
      estanciaEstado: "desconocido",
      huespedId: null,
    });
    expect(resultado.acciones.some((a) => a.tipo === "ticket_mantenimiento")).toBe(true);
    expect(resultado.acciones.some((a) => a.tipo === "mensaje_proactivo")).toBe(false);
    expect(resultado.acciones.some((a) => a.tipo === "compensacion_reglada")).toBe(false);
  });
});
