// REQ-AGT-022 / GOB-025 · Adversarial: aislamiento de contexto de prompt entre tenants.
//
// Criterio exacto (docs/ACEPTACION.md): "dado un tenant A, ningún fragmento del contexto
// construido para su agente contiene tenant_id/datos de otro hotel salvo hechos marcados
// públicos; 0 ejemplos few-shot con datos de otro tenant; verificado que cualquier vector
// store/memoria del agente expira o se destruye al cerrar la conversación (no persiste
// entre tenants)".
//
// Tres bloques, uno por cláusula del criterio:
//
//   1) `buildContext()` (packages/agent-core/src/context.ts) ejercitado con DATOS FISCALES
//      REALES de dos hoteles sembrados en PGlite real (ADR-003) -- no strings sintéticos
//      inventados a mano: el ataque intenta colar el nombre y el RFC emisor REALES del
//      hotel B (leídos con SQL, exactamente como lo haría un fragmentador de prompt real)
//      en el contexto que se arma para el hotel A. Nota deliberada: los `room_type`/precios
//      sembrados por `seedDev` son IDÉNTICOS entre hoteles (mismo catálogo demo), así que NO
//      sirven para distinguir "dato de otro hotel" -- `hotel_tax_config.rfc_emisor` y
//      `location.name` sí son únicos por hotel y es exactamente el tipo de dato fiscal/
//      identificador que una fuga real filtraría.
//   2) Ejemplos few-shot: mismo mecanismo, con un fragmento explícitamente etiquetado
//      "few-shot" -- 0 deben colarse si traen datos de OTRO tenant; un few-shot del MISMO
//      tenant o genuinamente público sí se permite (la regla es aislamiento entre tenants,
//      no una prohibición general de few-shot).
//   3) Vector store / memoria persistente de agente: verificado por escaneo estático real
//      de `packages/**`+`apps/**` que HOY no existe ningún componente de ese tipo en el
//      repo -- se documenta el estado VACÍO HONESTO (mismo patrón que
//      `scripts/checks/pms-mirror-solo-lectura.ts` para REQ-GOB-013 y
//      `scripts/checks/ocr-aislado-sin-internet.ts` para REQ-AGT-013): la mitad "expira al
//      cerrar la conversación" del criterio no tiene nada que ejercitar hoy porque el
//      componente no existe, y este test deja la invariante congelada para fallar el día
//      que aparezca el primer vector store sin resolver su expiración. Complementa
//      confirmando que el propio `AgentRunner` (el único componente con estado de una
//      "corrida") no guarda nada a nivel de módulo que pudiera sobrevivir entre
//      conversaciones/tenants.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildContext, CrossTenantContextError, type ContextFragment } from "@atiende-hoteles/agent-core";
import { createPgliteFixture, destroyPgliteFixture, type PgliteFixture } from "../support/pglite-fixture.ts";

interface DatosFiscalesHotel {
  hotelId: string;
  nombre: string;
  rfcEmisor: string;
}

let fixture: PgliteFixture;
let hotelA: DatosFiscalesHotel;
let hotelB: DatosFiscalesHotel;

beforeAll(async () => {
  fixture = await createPgliteFixture();

  // Se relee de la BD real con SQL (no del objeto `SeedResult` en memoria que ya trae
  // `seedDev()`) para que el "dato de otro hotel" que se intenta colar sea EXACTAMENTE lo
  // que un fragmentador de prompt real leería con una consulta, nunca un valor inventado
  // a mano en el test.
  const { rows } = await fixture.engine.admin.query<{ hotel_id: string; nombre: string; rfc_emisor: string }>(
    `select l.id as hotel_id, l.name as nombre, tc.rfc_emisor
     from public.hotel h
     join public.location l on l.id = h.id
     join public.hotel_tax_config tc on tc.hotel_id = h.id
     order by l.name;`,
  );
  expect(rows).toHaveLength(2);
  hotelA = { hotelId: rows[0]!.hotel_id, nombre: rows[0]!.nombre, rfcEmisor: rows[0]!.rfc_emisor };
  hotelB = { hotelId: rows[1]!.hotel_id, nombre: rows[1]!.nombre, rfcEmisor: rows[1]!.rfc_emisor };

  // Verificación de la propia fixture: si esto alguna vez fallara (p.ej. `seedDev`
  // cambiara a compartir el mismo RFC entre hoteles demo), el resto de este archivo
  // estaría probando aislamiento con datos que no son realmente distintos.
  expect(hotelA.hotelId).not.toBe(hotelB.hotelId);
  expect(hotelA.rfcEmisor).not.toBe(hotelB.rfcEmisor);
  expect(hotelA.nombre).not.toBe(hotelB.nombre);
});

afterAll(async () => {
  await destroyPgliteFixture(fixture);
});

function fragmentoDeHotel(hotelId: string, label: string, content: string): ContextFragment {
  return { tenantId: hotelId, scope: "hotel", label, content };
}
function fragmentoPublico(label: string, content: string): ContextFragment {
  // tenantId es ignorado por buildContext() cuando scope === "public" (ver context.ts).
  return { tenantId: "n/a", scope: "public", label, content };
}

describe("1) construcción de prompt: solo datos del tenant en curso + hechos públicos", () => {
  it("el contexto construido para el hotel A con SUS PROPIOS fragmentos reales no lanza y no contiene ningún dato real del hotel B", () => {
    const fragments: ContextFragment[] = [
      fragmentoDeHotel(hotelA.hotelId, "identidad-fiscal", `${hotelA.nombre} — RFC emisor ${hotelA.rfcEmisor}`),
      fragmentoDeHotel(hotelA.hotelId, "politica-hotel", `Bienvenido a ${hotelA.nombre}, su check-in es a las 15:00.`),
      fragmentoPublico("politica-general", "El check-in en todos nuestros hoteles es a partir de las 15:00."),
    ];

    const contexto = buildContext(hotelA.hotelId, fragments);
    const contextoTexto = contexto.join("\n");

    expect(contextoTexto).toContain(hotelA.nombre);
    expect(contextoTexto).toContain(hotelA.rfcEmisor);
    // ningún dato REAL del hotel B (su id, su nombre, su RFC emisor real) aparece en el
    // contexto construido para A.
    expect(contextoTexto).not.toContain(hotelB.hotelId);
    expect(contextoTexto).not.toContain(hotelB.nombre);
    expect(contextoTexto).not.toContain(hotelB.rfcEmisor);
  });

  it("FAIL-CLOSED: intentar colar un fragmento con datos fiscales REALES del hotel B en el contexto del hotel A se rechaza con CrossTenantContextError, no se filtra en silencio", () => {
    const fragmentoContaminado = fragmentoDeHotel(
      hotelB.hotelId,
      "identidad-fiscal-ajena-colada",
      `${hotelB.nombre} — RFC emisor ${hotelB.rfcEmisor}`,
    );
    const fragments: ContextFragment[] = [
      fragmentoDeHotel(hotelA.hotelId, "identidad-fiscal", `${hotelA.nombre} — RFC emisor ${hotelA.rfcEmisor}`),
      fragmentoContaminado,
    ];

    expect(() => buildContext(hotelA.hotelId, fragments)).toThrow(CrossTenantContextError);
    try {
      buildContext(hotelA.hotelId, fragments);
      throw new Error("no debio llegar aqui: buildContext debio lanzar CrossTenantContextError");
    } catch (err) {
      expect(err).toBeInstanceOf(CrossTenantContextError);
      const crossTenantErr = err as CrossTenantContextError;
      expect(crossTenantErr.fragmentTenantId).toBe(hotelB.hotelId);
      expect(crossTenantErr.currentHotelId).toBe(hotelA.hotelId);
      expect(crossTenantErr.label).toBe("identidad-fiscal-ajena-colada");
    }
  });

  it("todo-o-nada: un fragmento ajeno al FINAL del arreglo nunca deja pasar (de vuelta al llamador) los fragmentos legítimos que iban antes -- ningún contexto parcial se filtra", () => {
    // Si buildContext() devolviera alguna vez el arreglo `allowed` parcialmente acumulado
    // en vez de lanzar antes de retornar, un llamador que por bug ignorara la excepción
    // (p.ej. un try/catch demasiado amplio en la capa que arma el prompt) todavía podría
    // terminar usando los fragmentos legítimos que sí se acumularon. Lo único que importa
    // de verdad es que NINGÚN llamador reciba jamás un array de vuelta cuando hay un
    // fragmento ajeno, sin importar en qué posición del arreglo venga.
    const fragments: ContextFragment[] = [
      fragmentoDeHotel(hotelA.hotelId, "propio-1", "dato legitimo del hotel A, fragmento 1"),
      fragmentoDeHotel(hotelA.hotelId, "propio-2", "dato legitimo del hotel A, fragmento 2"),
      fragmentoDeHotel(hotelB.hotelId, "ajeno-al-final", `${hotelB.nombre} — RFC emisor ${hotelB.rfcEmisor}`),
    ];

    let resultado: string[] | undefined;
    let errorCapturado: unknown;
    try {
      resultado = buildContext(hotelA.hotelId, fragments);
    } catch (err) {
      errorCapturado = err;
    }
    expect(resultado).toBeUndefined();
    expect(errorCapturado).toBeInstanceOf(CrossTenantContextError);
  });

  it("la comparación de tenant es por igualdad EXACTA de string, no por prefijo/substring (un id que difiere en un solo carácter se rechaza igual)", () => {
    const idCasiIgual = `${hotelA.hotelId}x`;
    expect(idCasiIgual).not.toBe(hotelA.hotelId);
    const fragments: ContextFragment[] = [fragmentoDeHotel(idCasiIgual, "id-parecido-no-identico", "dato de un tenant con id casi igual")];
    expect(() => buildContext(hotelA.hotelId, fragments)).toThrow(CrossTenantContextError);
  });
});

describe("2) 0 ejemplos few-shot con datos de OTRO tenant", () => {
  it("un ejemplo few-shot etiquetado como tal, con datos fiscales REALES de otro hotel, se rechaza igual que cualquier otro fragmento ajeno", () => {
    const fewShotAjeno = fragmentoDeHotel(
      hotelB.hotelId,
      "few-shot-conversacion-ejemplo",
      `Ejemplo de conversación en ${hotelB.nombre} (RFC ${hotelB.rfcEmisor}): huésped pidió su factura y se le confirmó el RFC emisor correcto.`,
    );
    expect(() => buildContext(hotelA.hotelId, [fewShotAjeno])).toThrow(CrossTenantContextError);
  });

  it("un ejemplo few-shot del MISMO tenant sí se permite -- la regla es aislamiento ENTRE tenants, no una prohibición general de few-shot", () => {
    const fewShotPropio = fragmentoDeHotel(
      hotelA.hotelId,
      "few-shot-conversacion-ejemplo",
      `Ejemplo de conversación en ${hotelA.nombre}: huésped pidió su factura y se le confirmó el RFC emisor ${hotelA.rfcEmisor}.`,
    );
    expect(buildContext(hotelA.hotelId, [fewShotPropio])).toEqual([fewShotPropio.content]);
  });

  it("un ejemplo few-shot genuinamente público (genérico, sin ningún dato identificable de un hotel real) se permite sin importar qué tenantId declarado traiga", () => {
    const fewShotGenerico = fragmentoPublico(
      "few-shot-generico",
      "Ejemplo genérico: huésped pregunta por el horario de checkout, se responde 12:00 del mediodía.",
    );
    expect(buildContext(hotelA.hotelId, [fewShotGenerico])).toEqual([fewShotGenerico.content]);
  });

  it("0 few-shot de otro tenant cuelan incluso mezclado entre varios fragmentos propios legítimos (no basta con probar el caso de un solo fragmento)", () => {
    const fragments: ContextFragment[] = [
      fragmentoDeHotel(hotelA.hotelId, "few-shot-1-propio", `Ejemplo propio de ${hotelA.nombre}.`),
      fragmentoPublico("few-shot-2-publico", "Ejemplo genérico sin datos de ningún hotel."),
      fragmentoDeHotel(hotelB.hotelId, "few-shot-3-ajeno-escondido-en-medio", `Ejemplo de ${hotelB.nombre}, RFC ${hotelB.rfcEmisor}.`),
      fragmentoDeHotel(hotelA.hotelId, "few-shot-4-propio", `Otro ejemplo propio de ${hotelA.nombre}.`),
    ];
    expect(() => buildContext(hotelA.hotelId, fragments)).toThrow(CrossTenantContextError);
  });
});

describe("3) vector store / memoria del agente: expira o se destruye al cerrar la conversación", () => {
  const SCAN_ROOT = join(import.meta.dirname, "..", "..");
  const SCAN_DIRS = [join(SCAN_ROOT, "apps"), join(SCAN_ROOT, "packages")];
  const EXCLUDE_DIR_NAMES = new Set(["node_modules", "dist", ".git"]);

  // Vocabulario real de vector store / RAG / memoria de conversación persistente entre
  // corridas. Si ALGUNO de estos apareciera en código fuente (no en docs, que sí discuten
  // el requisito en prosa), habría un componente de memoria que este test tendría que
  // verificar que expira por conversación/tenant -- cosa que hoy no puede hacer porque no
  // existe.
  const VECTOR_STORE_PATTERNS: RegExp[] = [
    /pgvector/i,
    /\bpinecone\b/i,
    /\bweaviate\b/i,
    /\bchromadb\b/i,
    /\bqdrant\b/i,
    /\bmilvus\b/i,
    /\bfaiss\b/i,
    /text-embedding/i,
    /createEmbedding/i,
    /\bVectorStore\b/,
    /\bRagMemory\b/,
    /\bAgentMemory\b/,
    /\bConversationMemory\b/,
    /\blangchain\b/i,
    /\bllamaindex\b/i,
  ];

  function walk(dir: string, files: string[] = []): string[] {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return files;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (EXCLUDE_DIR_NAMES.has(entry)) continue;
        walk(full, files);
      } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".spec.ts")) {
        files.push(full);
      }
    }
    return files;
  }

  it("HOY no existe ningún vector store/motor de RAG/memoria de agente en el código fuente real (packages/**, apps/**) -- verificado por escaneo real, no supuesto", () => {
    const coincidencias: { archivo: string; patron: string }[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of walk(dir)) {
        const content = readFileSync(file, "utf8");
        for (const pattern of VECTOR_STORE_PATTERNS) {
          if (pattern.test(content)) {
            coincidencias.push({ archivo: file.replace(`${SCAN_ROOT}/`, ""), patron: pattern.source });
          }
        }
      }
    }
    // Vacío honesto (mismo patrón que REQ-GOB-013/`pms_mirror` y REQ-AGT-013/OCR
    // aislado): el componente no existe todavía, así que la mitad "expira al cerrar la
    // conversación" del criterio no tiene nada que ejercitar HOY -- lo que se verifica
    // aquí es que sigue siendo cierto que no existe, dejando la invariante congelada
    // desde hoy para que este archivo se tenga que actualizar el día que aparezca el
    // primer vector store, en vez de descubrirse sin haberlo cubierto.
    expect(coincidencias).toEqual([]);
  });

  it("el runtime real de agentes (AgentRunner) no declara ningún estado mutable a nivel de MÓDULO (Map/Set fuera de una función) -- todo el estado de una corrida (messages/pendingApprovalIds/recentToolSignatures) vive en variables LOCALES de run(), consistente con que no hay memoria capaz de sobrevivir al cierre de una conversación y filtrarse a la siguiente/otro tenant", () => {
    const runnerSource = readFileSync(join(SCAN_ROOT, "packages", "agent-core", "src", "runner.ts"), "utf8");
    const declaracionModuloConEstadoMutable = /^(const|let)\s+\w+\s*=\s*new\s+(Map|Set|Array)\s*\(/m.test(runnerSource);
    expect(declaracionModuloConEstadoMutable).toBe(false);
  });

  it("confirma (control negativo) que el escaneo de vector store SÍ detecta una coincidencia real cuando existe -- si no fuera capaz de detectar nada, el resultado vacío de arriba no probaría nada", () => {
    const detecta = VECTOR_STORE_PATTERNS.some((p) => p.test("import { PineconeClient } from 'pinecone-client';"));
    expect(detecta).toBe(true);
  });
});
