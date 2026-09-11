// REQ-HK-003 (docs/REQUISITOS.md/docs/ACEPTACION.md): "Inspección asistida por visión
// con set estándar de fotos genera aprobación/corrección en <30 s medido; muestreo de
// supervisión física entre 20-30% de las inspecciones (verificado por conteo); decisión
// final siempre humana (0 cierres automáticos sin registro de supervisor)." Contra la
// app real (apps/api) y Postgres real (embedded-postgres, ADR-003) -- las 3 cláusulas
// del criterio de aceptación, una por una, más el caso negativo/adversarial explícito
// que pide el encargo (intentar cerrar sin pasar por un supervisor humano). El unit
// puro del módulo de dominio vive en
// `tests/unit/domain-hotel/inspeccion-vision.spec.ts`.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STANDARD_INSPECTION_PHOTO_TYPES } from "@atiende-hoteles/domain-hotel";
import { RateLimiter } from "@atiende-hoteles/api";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

describe("apps/api: inspección de housekeeping asistida por visión (REQ-HK-003)", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let housekeepingToken: string;
  let housekeepingStaffId: string;
  let hotelId: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotel = fixture.seed.hotels[0]!;
    hotelId = hotel.id;
    gmToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "gm")!.email);
    housekeepingToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "housekeeping")!.email);
    housekeepingStaffId = hotel.staff.find((s) => s.role === "housekeeping")!.id;
    // El muestreo estadístico de abajo (20-30% verificado por conteo) manda muchos más
    // requests/min de lo que un IP/usuario real haría (REQ-SEG rate limit, ADR-008) --
    // se sube el techo SOLO para este fixture de test, nunca el default de producción
    // (`createApiFixture` sigue arrancando con el límite real de 1000/min).
    fixture.deps.ipLimiter = new RateLimiter({ limit: 100_000, windowMs: 60_000 });
    fixture.deps.userLimiter = new RateLimiter({ limit: 100_000, windowMs: 60_000 });
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  const authOf = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

  /** Crea+asigna+inicia+termina una tarea de housekeeping real sobre una habitación
   *  cualquiera del hotel de prueba, devolviendo su id -- precondición común a los
   *  escenarios de abajo (el set de fotos solo se puede enviar sobre una tarea
   *  "completada"). */
  async function crearTareaCompletada(checklist: string[] = []): Promise<string> {
    const { rows } = await fixture.engine.admin.query<{ code: string }>(
      "select code from public.room where hotel_id = $1 order by random() limit 1;",
      [hotelId],
    );
    const roomCode = rows[0]!.code;

    const crear = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/tareas`, {
      method: "POST",
      headers: authOf(gmToken),
      body: JSON.stringify({ roomCode, checklist }),
    });
    expect(crear.status).toBe(201);
    const { taskId } = (await crear.json()) as { taskId: string };

    await fixture.app.request(`/hoteles/${hotelId}/housekeeping/tareas/${taskId}/asignar`, {
      method: "PATCH",
      headers: authOf(gmToken),
      body: JSON.stringify({ assignedTo: housekeepingStaffId }),
    });
    const iniciar = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/tareas/${taskId}/iniciar`, {
      method: "POST",
      headers: authOf(housekeepingToken),
    });
    expect(iniciar.status).toBe(200);
    const terminar = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/tareas/${taskId}/terminar`, {
      method: "POST",
      headers: authOf(housekeepingToken),
    });
    expect(terminar.status).toBe(200);

    return taskId;
  }

  /** Inserta directamente (sin recorrer los 4 endpoints de ciclo de vida) una tarea ya
   *  "completada" y asignada a housekeeping -- misma precondición que
   *  `crearTareaCompletada`, pero barata de repetir cientos de veces: lo que el
   *  muestreo de supervisión física necesita variar es el `id` real de la tarea (el
   *  argumento de `requiresPhysicalSupervision`), no repetir el ciclo crear→asignar→
   *  iniciar→terminar que YA prueban los tests de arriba y `housekeeping-mantenimiento.spec.ts`. */
  async function insertarTareaCompletadaDirecta(): Promise<string> {
    const { rows: rooms } = await fixture.engine.admin.query<{ id: string }>(
      "select id from public.room where hotel_id = $1 order by random() limit 1;",
      [hotelId],
    );
    const { rows } = await fixture.engine.admin.query<{ id: string }>(
      `insert into public.housekeeping_task
         (tenant_id, hotel_id, room_id, status, assigned_to, started_at, finished_at, created_by)
       values ($1, $2, $3, 'completada', $4, now() - interval '2 hours', now() - interval '1 hour', $4)
       returning id;`,
      [fixture.seed.orgId, hotelId, rooms[0]!.id, housekeepingStaffId],
    );
    return rows[0]!.id;
  }

  function setEstandarDeFotos(tomadaEn: string = new Date().toISOString()) {
    return STANDARD_INSPECTION_PHOTO_TYPES.map((tipo) => ({
      tipo,
      url: `https://evidencia.local/${tipo}-${randomUUID()}.jpg`,
      tomadaEn,
    }));
  }

  it('set estándar completo y checklist cubierto -> "aprobada" generado en <30 s medido', async () => {
    const taskId = await crearTareaCompletada(["reponer amenities"]);

    const inicio = Date.now();
    const res = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/tareas/${taskId}/fotos-inspeccion`, {
      method: "POST",
      headers: authOf(housekeepingToken),
      body: JSON.stringify({ fotos: setEstandarDeFotos(), checklistCubierto: ["reponer amenities"] }),
    });
    const latenciaMedidaAqui = Date.now() - inicio;
    expect(res.status).toBe(201);

    const body = (await res.json()) as { veredicto: string; items: unknown[]; elapsedMs: number; requierePhysicalSupervision: boolean };
    expect(body.veredicto).toBe("aprobada");
    expect(body.items).toEqual([]);
    // Las dos mediciones de latencia (la del servidor y la de este test, que además
    // incluye ida y vuelta HTTP) deben caer bajo el SLA de 30 s del criterio de
    // aceptación -- "medido", no solo declarado.
    expect(body.elapsedMs).toBeLessThan(30_000);
    expect(latenciaMedidaAqui).toBeLessThan(30_000);
  });

  it("falta una foto del set estándar -> corrección específica nombrando qué falta (nunca aprobación silenciosa)", async () => {
    const taskId = await crearTareaCompletada();
    const fotosIncompletas = setEstandarDeFotos().filter((f) => f.tipo !== "bano");

    const res = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/tareas/${taskId}/fotos-inspeccion`, {
      method: "POST",
      headers: authOf(housekeepingToken),
      body: JSON.stringify({ fotos: fotosIncompletas }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { veredicto: string; items: Array<{ tipo: string; motivo: string }> };
    expect(body.veredicto).toBe("correccion");
    expect(body.items.some((it) => it.tipo === "bano" && it.motivo.includes("falta"))).toBe(true);
  });

  it("checklist del hotel sin cubrir -> corrección específica (checklist pendiente nombrado)", async () => {
    const taskId = await crearTareaCompletada(["revisar minibar"]);

    const res = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/tareas/${taskId}/fotos-inspeccion`, {
      method: "POST",
      headers: authOf(housekeepingToken),
      body: JSON.stringify({ fotos: setEstandarDeFotos(), checklistCubierto: [] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { veredicto: string; checklistPendiente: string[] };
    expect(body.veredicto).toBe("correccion");
    expect(body.checklistPendiente).toEqual(["revisar minibar"]);
  });

  it("foto fechada antes de iniciar la limpieza -> corrección (evidencia reciclada de otra limpieza)", async () => {
    const taskId = await crearTareaCompletada();
    const fotos = setEstandarDeFotos();
    fotos[0] = { ...fotos[0]!, tomadaEn: "2020-01-01T00:00:00.000Z" };

    const res = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/tareas/${taskId}/fotos-inspeccion`, {
      method: "POST",
      headers: authOf(housekeepingToken),
      body: JSON.stringify({ fotos }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { veredicto: string; items: Array<{ motivo: string }> };
    expect(body.veredicto).toBe("correccion");
    expect(body.items.some((it) => it.motivo.includes("anterior al inicio"))).toBe(true);
  });

  it("no se puede enviar el set de fotos antes de terminar la limpieza (tarea aún pendiente/en progreso)", async () => {
    const { rows } = await fixture.engine.admin.query<{ code: string }>(
      "select code from public.room where hotel_id = $1 order by random() limit 1;",
      [hotelId],
    );
    const crear = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/tareas`, {
      method: "POST",
      headers: authOf(gmToken),
      body: JSON.stringify({ roomCode: rows[0]!.code }),
    });
    const { taskId } = (await crear.json()) as { taskId: string };

    const res = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/tareas/${taskId}/fotos-inspeccion`, {
      method: "POST",
      headers: authOf(gmToken),
      body: JSON.stringify({ fotos: setEstandarDeFotos() }),
    });
    expect(res.status).toBe(400);
  });

  it("reenviar el set de una inspección ya evaluada es idempotente (no vuelve a sortear/juzgar)", async () => {
    const taskId = await crearTareaCompletada();
    const fotos = setEstandarDeFotos();

    const primera = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/tareas/${taskId}/fotos-inspeccion`, {
      method: "POST",
      headers: authOf(housekeepingToken),
      body: JSON.stringify({ fotos }),
    });
    const cuerpoPrimera = (await primera.json()) as { evaluadoEn: string; veredicto: string };

    const segunda = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/tareas/${taskId}/fotos-inspeccion`, {
      method: "POST",
      headers: authOf(housekeepingToken),
      body: JSON.stringify({ fotos: setEstandarDeFotos() }), // fotos distintas -- deben ignorarse
    });
    expect(segunda.status).toBe(200);
    const cuerpoSegunda = (await segunda.json()) as { evaluadoEn: string; veredicto: string; yaEvaluada: boolean };
    expect(cuerpoSegunda.yaEvaluada).toBe(true);
    expect(cuerpoSegunda.evaluadoEn).toBe(cuerpoPrimera.evaluadoEn);
  });

  it("el muestreo de supervisión física cae en 20-30% de las inspecciones, verificado por conteo real contra la BD", async () => {
    // N grande a propósito: el criterio de aceptación exige que la PROPORCIÓN agregada
    // caiga en 20-30% "verificado por conteo" -- con N chico la varianza del muestreo
    // (~25% esperado) puede empujar el conteo real fuera de esa banda sin que el
    // algoritmo esté mal (falso rojo). Con N=2000, la desviación estándar binomial es
    // ~1%, así que el rango 20-30% (±5 puntos, 5 sigma) prácticamente nunca falla por
    // azar -- ver el mismo criterio ya probado exhaustivamente (N=20000) en
    // `tests/unit/domain-hotel/inspeccion-vision.spec.ts`; aquí se verifica ADEMÁS que
    // el endpoint HTTP real persiste en la BD real exactamente lo que decide el módulo
    // de dominio, no solo que el algoritmo puro converge.
    const N = 2000;
    const ids: string[] = [];
    for (let i = 0; i < N; i++) {
      const taskId = await insertarTareaCompletadaDirecta();
      const res = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/tareas/${taskId}/fotos-inspeccion`, {
        method: "POST",
        headers: authOf(housekeepingToken),
        body: JSON.stringify({ fotos: setEstandarDeFotos() }),
      });
      expect(res.status).toBe(201);
      ids.push(taskId);
    }

    const { rows } = await fixture.engine.admin.query<{ n: string }>(
      `select count(*)::text as n from public.housekeeping_task
       where id = any($1::uuid[]) and requires_physical_supervision = true;`,
      [ids],
    );
    const seleccionadas = Number(rows[0]!.n);
    const proporcion = seleccionadas / N;
    expect(proporcion).toBeGreaterThanOrEqual(0.2);
    expect(proporcion).toBeLessThanOrEqual(0.3);
  }, 90_000);

  it("ADVERSARIAL: una tarea muestreada para supervisión física no puede cerrarse sin nota -- 0 cierres automáticos sin registro de supervisor", async () => {
    // Genera tareas hasta encontrar una que el muestreo determinístico SÍ seleccione
    // (con ~25% de tasa, unas pocas tareas bastan) -- se prueba contra una selección
    // REAL del sistema, no una inyectada a mano.
    let taskId: string | null = null;
    let requierePhysicalSupervision = false;
    for (let i = 0; i < 60 && !requierePhysicalSupervision; i++) {
      const candidato = await insertarTareaCompletadaDirecta();
      const res = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/tareas/${candidato}/fotos-inspeccion`, {
        method: "POST",
        headers: authOf(housekeepingToken),
        body: JSON.stringify({ fotos: setEstandarDeFotos() }),
      });
      const body = (await res.json()) as { requierePhysicalSupervision: boolean };
      if (body.requierePhysicalSupervision) {
        taskId = candidato;
        requierePhysicalSupervision = true;
      }
    }
    expect(requierePhysicalSupervision).toBe(true);

    // Intento de cierre SIN nota -- rechazado explícitamente, la tarea sigue sin
    // inspected_by/inspected_at (0 cierres automáticos).
    const sinNota = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/tareas/${taskId}/inspeccionar`, {
      method: "POST",
      headers: authOf(gmToken),
      body: JSON.stringify({ resultado: "aprobada" }),
    });
    expect(sinNota.status).toBe(400);

    const { rows: sinCerrar } = await fixture.engine.admin.query<{ inspected_by: string | null }>(
      "select inspected_by from public.housekeeping_task where id = $1;",
      [taskId],
    );
    expect(sinCerrar[0]!.inspected_by).toBeNull();

    // Con nota real de la revisión física -- sí se permite, y queda registrado el
    // supervisor humano que la hizo.
    const conNota = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/tareas/${taskId}/inspeccionar`, {
      method: "POST",
      headers: authOf(gmToken),
      body: JSON.stringify({ resultado: "aprobada", nota: "Revisé la habitación en persona, confirmo limpieza." }),
    });
    expect(conNota.status).toBe(200);

    const { rows: cerrada } = await fixture.engine.admin.query<{ inspected_by: string | null; inspected_at: string | null }>(
      "select inspected_by, inspected_at from public.housekeeping_task where id = $1;",
      [taskId],
    );
    expect(cerrada[0]!.inspected_by).not.toBeNull();
    expect(cerrada[0]!.inspected_at).not.toBeNull();
  }, 30_000);

  it("una tarea NO muestreada sí puede cerrarse sin nota (el criterio de nota obligatoria es solo para el 20-30% muestreado)", async () => {
    let taskId: string | null = null;
    for (let i = 0; i < 60 && !taskId; i++) {
      const candidato = await insertarTareaCompletadaDirecta();
      const res = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/tareas/${candidato}/fotos-inspeccion`, {
        method: "POST",
        headers: authOf(housekeepingToken),
        body: JSON.stringify({ fotos: setEstandarDeFotos() }),
      });
      const body = (await res.json()) as { requierePhysicalSupervision: boolean };
      if (!body.requierePhysicalSupervision) taskId = candidato;
    }
    expect(taskId).not.toBeNull();

    const inspeccionar = await fixture.app.request(`/hoteles/${hotelId}/housekeeping/tareas/${taskId}/inspeccionar`, {
      method: "POST",
      headers: authOf(gmToken),
      body: JSON.stringify({ resultado: "aprobada" }),
    });
    expect(inspeccionar.status).toBe(200);
  }, 30_000);
});
