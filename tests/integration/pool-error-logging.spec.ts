// auditoria-2/operabilidad [ALTO] · `pool.on("error", () => { /* silenciado */ })`
// (packages/db/src/engines.ts) no dejaba NINGÚN rastro cuando el servidor cerraba una
// conexión ociosa del pool -- el propio informe de auditoría admite no haber forzado
// esto en vivo ("no forcé un SIGKILL al proceso... para observarlo en vivo"). Esta
// prueba SÍ lo reproduce en vivo: deja una conexión de `atiende_app` ociosa en el pool,
// la mata desde el lado del servidor con `pg_terminate_backend` (mismo efecto real que
// un reinicio de Postgres/corte de red), y confirma que el evento queda contado
// (`getPoolErrorCount()`) y se lo entrega a `onPoolError` -- ya no desaparece en
// silencio.
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, openEmbeddedPostgres, type EmbeddedPostgresEngine } from "@atiende-hoteles/db";

async function esperarHasta(condicion: () => boolean, timeoutMs = 5000, pasoMs = 25): Promise<void> {
  const start = Date.now();
  while (!condicion()) {
    if (Date.now() - start > timeoutMs) throw new Error("tiempo de espera agotado");
    await new Promise((r) => setTimeout(r, pasoMs));
  }
}

describe("pool.on(\"error\") deja rastro (auditoria-2/operabilidad ALTO)", () => {
  let engine: EmbeddedPostgresEngine | undefined;

  afterEach(async () => {
    if (engine) await engine.stop();
    engine = undefined;
  });

  it("una conexión ociosa del pool terminada del lado del servidor: se cuenta y se notifica, no desaparece en silencio", async () => {
    const errores: unknown[] = [];
    engine = await openEmbeddedPostgres({ poolMax: 2, onPoolError: (err) => errores.push(err) });
    await applyMigrations(engine.admin);

    expect(engine.getPoolErrorCount()).toBe(0);

    // Deja una conexión de `atiende_app` ociosa en el pool (vuelve al pool al terminar
    // la sesión, no se cierra).
    await engine.withAppSession({ userId: null }, async (session) => {
      await session.query("select 1;");
    });

    // Termina esa conexión ociosa desde el servidor (superusuario) -- mismo efecto real
    // que un reinicio de Postgres o un `idle_in_transaction_session_timeout` del lado
    // del servidor: el socket del cliente recibe un error inesperado.
    await engine.admin.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where usename = 'atiende_app' and pid <> pg_backend_pid();",
    );

    await esperarHasta(() => engine!.getPoolErrorCount() > 0);

    expect(engine.getPoolErrorCount()).toBeGreaterThan(0);
    expect(errores.length).toBeGreaterThan(0);
  });
});
