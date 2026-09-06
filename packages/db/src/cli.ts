#!/usr/bin/env node
// CLI de packages/db: `db:migrate`, `db:reset`, `db:seed` (ver package.json raiz).
// Usa siempre embedded-postgres (Postgres real, ADR-003) con un data dir persistente en
// disco (por defecto packages/db/.pgdata, configurable con DB_DATA_DIR) para que
// `db:migrate` deje un servidor de desarrollo local reutilizable entre corridas, a
// diferencia de las pruebas (que usan un data dir efimero por corrida).

import { access, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import { applyMigrations, dropAllMigratedObjects } from "./runner.ts";
import { seedDev } from "./seed.ts";
import type { DbClient } from "./types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = join(here, "..", ".pgdata");
const DEFAULT_PORT = 54329;

function wrapPgClient(client: import("pg").Client): DbClient {
  return {
    async query(sql, params) {
      const res = await client.query(sql, params as unknown[] | undefined);
      return { rows: res.rows as never };
    },
    async exec(sql) {
      await client.query(sql);
    },
  };
}

async function withDevServer<T>(fn: (db: DbClient) => Promise<T>): Promise<T> {
  const databaseDir = process.env.DB_DATA_DIR ?? DEFAULT_DATA_DIR;
  const port = Number(process.env.DB_PORT ?? DEFAULT_PORT);
  await mkdir(dirname(databaseDir), { recursive: true });

  const server = new EmbeddedPostgres({
    databaseDir,
    port,
    user: "postgres",
    password: "postgres_dev_only_local",
    persistent: true,
    onLog: (message) => console.log(`[embedded-postgres] ${message}`),
    onError: (message) => console.error(`[embedded-postgres] ${String(message)}`),
  });

  // `initialise()` corre `initdb`, que falla si el data dir ya existe y tiene contenido:
  // solo se llama la primera vez (marcador estandar de Postgres: archivo PG_VERSION).
  const alreadyInitialised = await access(join(databaseDir, "PG_VERSION"))
    .then(() => true)
    .catch(() => false);
  if (!alreadyInitialised) {
    await server.initialise();
  }
  await server.start();
  const client = server.getPgClient();
  await client.connect();

  try {
    return await fn(wrapPgClient(client));
  } finally {
    await client.end();
    await server.stop();
  }
}

async function main() {
  const command = process.argv[2];

  switch (command) {
    case "migrate": {
      await withDevServer(async (db) => {
        const result = await applyMigrations(db);
        console.log(`Migraciones aplicadas: ${result.applied.length}`);
        for (const f of result.applied) console.log(`  + ${f}`);
        console.log(`Migraciones ya aplicadas (omitidas): ${result.skipped.length}`);
      });
      break;
    }
    case "reset": {
      await withDevServer(async (db) => {
        await dropAllMigratedObjects(db);
        const result = await applyMigrations(db);
        console.log(`Esquema reiniciado. Migraciones aplicadas: ${result.applied.length}`);
      });
      break;
    }
    case "seed": {
      await withDevServer(async (db) => {
        await applyMigrations(db);
        const result = await seedDev(db);
        console.log(`Seed aplicado: org=${result.orgId}, hoteles=${result.hotels.length}`);
      });
      break;
    }
    default: {
      console.error("Uso: cli.ts <migrate|reset|seed>");
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
