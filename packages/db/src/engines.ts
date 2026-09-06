// Apertura de los dos motores de persistencia local (ADR-003):
//   - PGlite: unit tests rapidos, RLS/logica, sin concurrencia real.
//   - embedded-postgres: integracion/concurrencia real (advisory locks, idempotencia
//     bajo contencion real entre dos conexiones de sistema operativo distintas).
//
// Ambos exponen el mismo `DbClient` (ver types.ts) para que el runner de migraciones y
// las pruebas se escriban de forma agnostica al motor.

import { createServer } from "node:net";
import { access, mkdtemp, rm } from "node:fs/promises";
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
  /** Presta una conexion de un `pg.Pool` de proceso (auditoria-1/backend [MEDIO]: antes
   *  abria un `pg.Client` NUEVO por llamada, sin pool ni timeout -- ver comentario de
   *  `openEmbeddedPostgres` mas abajo) autenticada como `atiende_app` (sin BYPASSRLS,
   *  ADR-004) y ejecuta `fn` dentro de una transaccion con los claims de sesion ya
   *  aplicados via `set local` (alcance de transaccion, ADR-004): al hacer
   *  commit/rollback, Postgres descarta esos valores automaticamente ANTES de que la
   *  conexion vuelva al pool -- ninguna transaccion siguiente sobre la misma conexion
   *  fisica reciclada puede heredar `auth.uid()`/rol de la anterior (verificado en
   *  tests/integration/pool-sin-fuga-de-claims.spec.ts forzando `poolMax: 1`, la MISMA
   *  conexion fisica, entre dos sesiones consecutivas de hoteles distintos). */
  withAppSession<T>(
    claims: { userId?: string | null },
    fn: (session: DbClient) => Promise<T>,
  ): Promise<T>;
  connectionInfo: { host: string; port: number; database: string };
  stop(): Promise<void>;
}

export interface OpenEmbeddedPostgresOptions {
  /** Directorio de datos. Por defecto un directorio temporal efímero (pruebas). Pasar
   *  uno persistente (ej. `packages/db/.pgdata`) para un servidor de desarrollo real
   *  (ver `apps/api/src/db.ts`). */
  databaseDir?: string;
  /** Puerto TCP local. Por defecto uno libre elegido dinámicamente. */
  port?: number;
  /** `false` (default) borra el data dir al primer `initialise()`; `true` lo conserva
   *  entre reinicios (servidor de desarrollo). No aplica si el directorio ya existe. */
  persistent?: boolean;
  /** Tamaño máximo del `pg.Pool` de `atiende_app` compartido por el proceso (default
   *  20). Los tests de concurrencia real (advisory locks, contención) siguen viendo
   *  conexiones de sistema operativo genuinas y distintas mientras el número de
   *  sesiones simultáneas no exceda este máximo -- ver ADR-003. */
  poolMax?: number;
  /** Milisegundos que `pool.connect()` espera por una conexión libre/nueva antes de
   *  fallar explícito (auditoria-1/backend [MEDIO]: antes no existía ningún timeout,
   *  un request podía quedar colgado indefinidamente esperando `client.connect()`).
   *  Default 5000. */
  connectionTimeoutMs?: number;
  /** `statement_timeout` de Postgres (ms) aplicado a cada conexión del pool: una
   *  consulta que se cuelga del lado del servidor falla explícito en vez de bloquear
   *  la conexión (y el slot del pool) indefinidamente. Default 30000. */
  statementTimeoutMs?: number;
}

export async function openEmbeddedPostgres(
  options: OpenEmbeddedPostgresOptions = {},
): Promise<EmbeddedPostgresEngine> {
  const port = options.port ?? (await getFreePort());
  const databaseDir = options.databaseDir ?? (await mkdtemp(join(tmpdir(), "atiende-hoteles-pg-")));

  const pgServer = new EmbeddedPostgres({
    databaseDir,
    port,
    user: "postgres",
    password: "postgres_dev_only_local",
    persistent: options.persistent ?? false,
    onLog: () => {
      /* silenciado: el runner/CLI decide que loguear */
    },
    onError: () => {
      /* silenciado, ver arriba */
    },
  });

  // `initialise()` corre `initdb`, que falla si el data dir ya existe y tiene contenido
  // (caso del servidor de desarrollo persistente reiniciado, ver marcador PG_VERSION
  // estandar de Postgres) -- se omite solo en ese caso.
  const alreadyInitialised = await access(join(databaseDir, "PG_VERSION"))
    .then(() => true)
    .catch(() => false);
  if (!alreadyInitialised) {
    await pgServer.initialise();
  }
  await pgServer.start();

  const adminClient = pgServer.getPgClient();
  await adminClient.connect();
  const admin = wrapPgClient(adminClient);

  const connectionInfo = { host: "127.0.0.1", port, database: "postgres" };

  // auditoria-1/backend [MEDIO]: "cada request abre una conexion Postgres nueva, sin
  // pool ni timeout" -- `withAppSession` abria un `pg.Client` NUEVO (connect/end) en
  // CADA llamada, reusado sin cambios por `apps/api/src/middleware.ts` (dbSession) en
  // produccion/desarrollo, no solo en pruebas. Bajo trafico real, cada request compite
  // por una conexion de sistema operativo nueva sin limite ni timeout de espera.
  //
  // Arreglo: un `pg.Pool` de proceso (una vez por `EmbeddedPostgresEngine`, no por
  // llamada) con tamano/timeouts configurables. `withAppSession` sigue abriendo una
  // transaccion nueva y fijando los claims de sesion con `set local` (alcance de
  // TRANSACCION, no de conexion) -- Postgres los descarta automaticamente al hacer
  // commit/rollback, ANTES de que `client.release()` devuelva la conexion fisica al
  // pool, asi que ninguna sesion siguiente sobre la MISMA conexion reciclada puede ver
  // el `auth.uid()`/rol de la anterior (verificado con `poolMax: 1` forzando la reutilizacion
  // exacta de una sola conexion fisica entre dos sesiones consecutivas de hoteles
  // distintos, ver tests/integration/pool-sin-fuga-de-claims.spec.ts). Un error a mitad
  // de sesion libera la conexion con `client.release(err)` (en vez de sin argumento):
  // le indica al pool que la conexion puede haber quedado en un estado inconsistente
  // (ej. `rollback` que tambien fallo) y debe destruirla en vez de reciclarla.
  const pool = new pg.Pool({
    host: connectionInfo.host,
    port: connectionInfo.port,
    database: connectionInfo.database,
    user: "atiende_app",
    password: "atiende_app_dev_only_local",
    max: options.poolMax ?? 20,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 5000,
    statement_timeout: options.statementTimeoutMs ?? 30_000,
  });
  // Un error en una conexion ociosa del pool (ej. el servidor la cerro) no debe tumbar
  // el proceso -- node-pg lo emite como evento si nadie lo escucha.
  pool.on("error", () => {
    /* silenciado: la siguiente `pool.connect()` simplemente abre una conexion nueva */
  });

  return {
    kind: "pg",
    admin,
    connectionInfo,
    async withAppSession(claims, fn) {
      const client = await pool.connect();
      try {
        await client.query("begin;");
        await client.query("set local role authenticated;");
        await client.query("select set_config('request.jwt.claim.sub', $1, true);", [
          claims.userId ?? "",
        ]);
        const session = wrapPgClient(client);
        const result = await fn(session);
        await client.query("commit;");
        client.release();
        return result;
      } catch (err) {
        await client.query("rollback;").catch(() => undefined);
        client.release(err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    },
    async stop() {
      await pool.end();
      await adminClient.end();
      await pgServer.stop();
      // Un data dir persistente (servidor de desarrollo, `apps/api/src/db.ts`) se
      // conserva entre reinicios; solo se borra el efímero de pruebas (default).
      if (!options.persistent) {
        await rm(databaseDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}
