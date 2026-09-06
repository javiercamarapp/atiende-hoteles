// Apertura de los dos motores de persistencia local (ADR-003):
//   - PGlite: unit tests rapidos, RLS/logica, sin concurrencia real.
//   - embedded-postgres: integracion/concurrencia real (advisory locks, idempotencia
//     bajo contencion real entre dos conexiones de sistema operativo distintas).
//
// Ambos exponen el mismo `DbClient` (ver types.ts) para que el runner de migraciones y
// las pruebas se escriban de forma agnostica al motor.

import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import type { DbClient } from "./types.ts";

export interface PgliteEngine {
  kind: "pglite";
  /** Cliente con privilegios plenos (PGlite no impone superusuario real, pero todas
   *  las sentencias de bootstrap/migracion corren sin restriccion RLS porque PGlite
   *  no aplica RLS a la conexion por defecto salvo que se haga `set role`). */
  admin: DbClient;
  /** Abre un cliente que primero hace `set local role authenticated` + los claims de
   *  sesion indicados, dentro de una transaccion que el llamador debe cerrar. */
  withSession<T>(
    claims: { userId?: string | null },
    fn: (session: DbClient) => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
}

function wrapPglite(pglite: PGlite): DbClient {
  return {
    async query<T>(sql: string, params?: unknown[]) {
      const res = await pglite.query<T>(sql, params as unknown[] | undefined);
      return { rows: res.rows };
    },
    async exec(sql: string) {
      await pglite.exec(sql);
    },
  };
}

export async function openPglite(): Promise<PgliteEngine> {
  const pglite = new PGlite();
  const admin = wrapPglite(pglite);

  return {
    kind: "pglite",
    admin,
    async withSession(claims, fn) {
      return pglite.transaction(async (tx) => {
        await tx.exec("set local role authenticated;");
        await tx.query("select set_config('request.jwt.claim.sub', $1, true);", [
          claims.userId ?? "",
        ]);
        const session: DbClient = {
          query: async (sql, params) => {
            const res = await tx.query(sql, params as unknown[] | undefined);
            return { rows: res.rows as never };
          },
          exec: async (sql) => {
            await tx.exec(sql);
          },
        };
        return fn(session);
      });
    },
    async close() {
      await pglite.close();
    },
  };
}

function wrapPgClient(client: pg.Client | pg.PoolClient): DbClient {
  return {
    async query<T>(sql: string, params?: unknown[]) {
      const res = await client.query(sql, params as unknown[] | undefined);
      return { rows: res.rows as T[] };
    },
    async exec(sql: string) {
      await client.query(sql);
    },
  };
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("no se pudo obtener un puerto libre")));
      }
    });
  });
}

export interface EmbeddedPostgresEngine {
  kind: "pg";
  /** Cliente `postgres` (superusuario del cluster embebido): usado por el runner de
   *  migraciones y los seeds, nunca por el codigo de aplicacion en runtime. */
  admin: DbClient;
  /** Abre una conexion NUEVA de sistema operativo autenticada como `atiende_app`
   *  (rol de aplicacion sin BYPASSRLS, ADR-004) y ejecuta `fn` dentro de una
   *  transaccion con los claims de sesion ya aplicados. Cada llamada usa un cliente
   *  `pg` propio para que dos llamadas concurrentes representen conexiones reales
   *  distintas (necesario para probar contencion real, ADR-003). */
  withAppSession<T>(
    claims: { userId?: string | null },
    fn: (session: DbClient) => Promise<T>,
  ): Promise<T>;
  connectionInfo: { host: string; port: number; database: string };
  stop(): Promise<void>;
}

export async function openEmbeddedPostgres(): Promise<EmbeddedPostgresEngine> {
  const port = await getFreePort();
  const databaseDir = await mkdtemp(join(tmpdir(), "atiende-hoteles-pg-"));

  const pgServer = new EmbeddedPostgres({
    databaseDir,
    port,
    user: "postgres",
    password: "postgres_dev_only_local",
    persistent: false,
    onLog: () => {
      /* silenciado: el runner/CLI decide que loguear */
    },
    onError: () => {
      /* silenciado, ver arriba */
    },
  });

  await pgServer.initialise();
  await pgServer.start();

  const adminClient = pgServer.getPgClient();
  await adminClient.connect();
  const admin = wrapPgClient(adminClient);

  const connectionInfo = { host: "127.0.0.1", port, database: "postgres" };

  return {
    kind: "pg",
    admin,
    connectionInfo,
    async withAppSession(claims, fn) {
      const client = new pg.Client({
        host: connectionInfo.host,
        port: connectionInfo.port,
        database: connectionInfo.database,
        user: "atiende_app",
        password: "atiende_app_dev_only_local",
      });
      await client.connect();
      try {
        await client.query("begin;");
        await client.query("set local role authenticated;");
        await client.query("select set_config('request.jwt.claim.sub', $1, true);", [
          claims.userId ?? "",
        ]);
        const session = wrapPgClient(client);
        const result = await fn(session);
        await client.query("commit;");
        return result;
      } catch (err) {
        await client.query("rollback;").catch(() => undefined);
        throw err;
      } finally {
        await client.end();
      }
    },
    async stop() {
      await adminClient.end();
      await pgServer.stop();
      await rm(databaseDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
