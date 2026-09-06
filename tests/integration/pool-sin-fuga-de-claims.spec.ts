// auditoria-1/backend [MEDIO] "cada request abre una conexión Postgres nueva, sin pool
// ni timeout" (docs/auditoria-1/backend.md). `withAppSession` (packages/db/src/engines.ts)
// ahora usa un `pg.Pool` de proceso en vez de un `pg.Client` nuevo por llamada -- la
// preocupación de seguridad al reciclar conexiones físicas entre requests de distintos
// hoteles/usuarios es que un GUC de sesión (`request.jwt.claim.sub`, el rol
// `authenticated`) se filtre de una transacción a la siguiente sobre la MISMA conexión
// reciclada.
//
// Esta prueba fuerza `poolMax: 1` (un único slot, por lo tanto la MISMA conexión física
// de sistema operativo se reutiliza de manera determinista entre dos `withAppSession`
// consecutivos) y confirma que "request B" (staff del Hotel Demo Playa) nunca ve ni
// hereda el `auth.uid()`/membresías de "request A" (staff del Hotel Demo Centro), pese a
// correr sobre la conexión que A acababa de soltar.
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, openEmbeddedPostgres, seedDev, type EmbeddedPostgresEngine } from "@atiende-hoteles/db";

describe("pool de conexiones: set_config por transacción no filtra claims entre requests reciclados (auditoria-1/backend MEDIO)", () => {
  let engine: EmbeddedPostgresEngine | undefined;

  afterEach(async () => {
    if (engine) await engine.stop();
    engine = undefined;
  });

  it("con poolMax=1 (misma conexión física forzada), el claim de la sesión A nunca es visible en la sesión B", async () => {
    engine = await openEmbeddedPostgres({ poolMax: 1 });
    await applyMigrations(engine.admin);
    const seed = await seedDev(engine.admin);
    const hotelA = seed.hotels[0]!;
    const hotelB = seed.hotels[1]!;
    const gmA = hotelA.staff.find((s) => s.role === "gm")!;
    const gmB = hotelB.staff.find((s) => s.role === "gm")!;

    // "request A": abre sesión como gm del Hotel Demo Centro, confirma su propio
    // contexto, y termina (la conexión vuelve al pool de tamaño 1).
    const vistoPorA = await engine.withAppSession({ userId: gmA.id }, async (session) => {
      const { rows: actorRows } = await session.query<{ actor: string | null }>(
        "select auth.uid()::text as actor;",
      );
      const { rows: hotelRows } = await session.query<{ id: string }>(
        "select unnest(current_hotel_ids()) as id;",
      );
      return { actor: actorRows[0]!.actor, hotelIds: hotelRows.map((r) => r.id) };
    });
    expect(vistoPorA.actor).toBe(gmA.id);
    expect(vistoPorA.hotelIds).toEqual([hotelA.id]);

    // "request B": abre sesión como gm de OTRO hotel. Con poolMax=1, esta es
    // GARANTIZADO la misma conexión física de sistema operativo que acaba de usar A
    // (no hay ninguna otra conexión disponible en el pool).
    const vistoPorB = await engine.withAppSession({ userId: gmB.id }, async (session) => {
      const { rows: actorRows } = await session.query<{ actor: string | null }>(
        "select auth.uid()::text as actor;",
      );
      const { rows: hotelRows } = await session.query<{ id: string }>(
        "select unnest(current_hotel_ids()) as id;",
      );
      // Confirma también que B no puede LEER el hotel de A por RLS (no solo que
      // current_hotel_ids() esté "limpio") -- la fuga real que importa es de datos.
      const { rows: hotelAVisibleParaB } = await session.query<{ id: string }>(
        "select id from public.hotel where id = $1;",
        [hotelA.id],
      );
      return {
        actor: actorRows[0]!.actor,
        hotelIds: hotelRows.map((r) => r.id),
        hotelAVisibleParaB: hotelAVisibleParaB.length > 0,
      };
    });

    expect(vistoPorB.actor).toBe(gmB.id);
    expect(vistoPorB.actor).not.toBe(gmA.id);
    expect(vistoPorB.hotelIds).toEqual([hotelB.id]);
    expect(vistoPorB.hotelIds).not.toContain(hotelA.id);
    expect(vistoPorB.hotelAVisibleParaB).toBe(false);
  });

  it("una sesión sin userId (claim vacío) tras una sesión CON userId, en la misma conexión reciclada, queda anónima (auth.uid() null) — nunca hereda al actor anterior", async () => {
    engine = await openEmbeddedPostgres({ poolMax: 1 });
    await applyMigrations(engine.admin);
    const seed = await seedDev(engine.admin);
    const owner = seed.hotels[0]!.staff.find((s) => s.role === "owner")!;

    await engine.withAppSession({ userId: owner.id }, async (session) => {
      const { rows } = await session.query<{ actor: string | null }>("select auth.uid()::text as actor;");
      expect(rows[0]!.actor).toBe(owner.id);
    });

    await engine.withAppSession({ userId: null }, async (session) => {
      const { rows } = await session.query<{ actor: string | null }>("select auth.uid()::text as actor;");
      expect(rows[0]!.actor).toBeNull();
    });
  });
});
