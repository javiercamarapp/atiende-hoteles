#!/usr/bin/env node
// H8 · ADR-008 "Backups": restaura un dump (`-Fc`, producido por `scripts/backup.ts`)
// en una BASE DE DATOS NUEVA del MISMO cluster embedded-postgres (nunca sobrescribe la
// original) y verifica que el conteo total de filas de `public.*` coincide EXACTO
// entre el origen y la base restaurada -- la "prueba real: dump + restore en BD nueva y
// conteo igual" que exige el encargo. No usa `n_live_tup`/`pg_stat_user_tables`
// (estimado, puede leer 0 justo después de un restore antes del primer autovacuum):
// cuenta filas reales con `count(*)` por tabla.
import { execFileSync } from "node:child_process";
import pg from "pg";
import { openEmbeddedPostgres, type EmbeddedPostgresEngine } from "@atiende-hoteles/db";
import { findClientBinary, isServerReachable, DEFAULT_DB_DATA_DIR, DEFAULT_DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } from "./lib/pgClientBin.ts";

export interface RestoreVerifyResult {
  newDbName: string;
  totalRowsOrigen: number;
  totalRowsRestaurado: number;
  porTabla: { tabla: string; origen: number; restaurado: number; coincide: boolean }[];
  ok: boolean;
  /** auditoria-2/operabilidad [ALTO]: motivo explícito cuando `ok` es false, para que
   *  "VERIFICACIÓN: DIVERGENCIA" nunca sea la única pista -- distingue "0 tablas en el
   *  origen" (backup vacío por un data dir equivocado) de una divergencia real fila a
   *  fila. `null` cuando `ok` es true. */
  motivoFalla: string | null;
}

/**
 * auditoria-2/operabilidad [ALTO]: lógica pura de decisión, separada de la I/O de red
 * (extraída para poder probarla con `tests/unit/scripts/restore-verify.spec.ts` sin
 * necesitar un `embedded-postgres`/`pg_dump` real). `porTabla.every(...)` sobre un
 * arreglo VACÍO es `true` por vacuidad -- si el origen tiene 0 tablas (ej. el data dir
 * de `embedded-postgres` resuelto contra un cwd equivocado, ver DEFAULT_DB_DATA_DIR en
 * pgClientBin.ts, apuntó a un cluster nuevo/nunca inicializado con datos reales), la
 * versión anterior de esta función declaraba "conteo igual" sobre una base vacía
 * comparada contra otra base vacía. Un backup real de este proyecto SIEMPRE tiene
 * `public.schema_migrations` con filas (las migraciones ya aplicadas) -- exigirlo
 * explícitamente distingue "no hay nada que respaldar todavía" (nunca debería pasar en
 * un entorno con `npm run dev` corrido al menos una vez) de "el backup está
 * corrupto/vacío por error".
 */
export function evaluarVerificacion(
  origenPorTabla: Map<string, number>,
  restauradoPorTabla: Map<string, number>,
): Pick<RestoreVerifyResult, "porTabla" | "totalRowsOrigen" | "totalRowsRestaurado" | "ok" | "motivoFalla"> {
  const porTabla = [...origenPorTabla.entries()].map(([tabla, origen]) => {
    const restaurado = restauradoPorTabla.get(tabla) ?? -1;
    return { tabla, origen, restaurado, coincide: origen === restaurado };
  });
  const totalRowsOrigen = porTabla.reduce((a, t) => a + t.origen, 0);
  const totalRowsRestaurado = porTabla.reduce((a, t) => a + Math.max(0, t.restaurado), 0);

  const migracionesOrigen = origenPorTabla.get("schema_migrations") ?? 0;
  let motivoFalla: string | null = null;
  if (origenPorTabla.size === 0) {
    motivoFalla =
      "El origen no tiene NINGUNA tabla en public -- esto no es un backup válido, es un cluster vacío/nunca migrado (revisa qué data dir usó `embedded-postgres`, ver DEFAULT_DB_DATA_DIR).";
  } else if (migracionesOrigen === 0) {
    motivoFalla =
      "public.schema_migrations no tiene filas en el origen -- el esquema nunca se migró en esta base; un backup real de este proyecto siempre tiene migraciones aplicadas.";
  } else if (origenPorTabla.size !== restauradoPorTabla.size) {
    motivoFalla = `El origen tiene ${origenPorTabla.size} tabla(s) y el restaurado ${restauradoPorTabla.size} -- número de tablas distinto.`;
  } else if (!porTabla.every((t) => t.coincide)) {
    motivoFalla = "Divergencia de conteo de filas en al menos una tabla (ver detalle arriba).";
  }
  const ok = motivoFalla === null;

  return { porTabla, totalRowsOrigen, totalRowsRestaurado, ok, motivoFalla };
}

async function contarFilasPorTabla(client: pg.Client): Promise<Map<string, number>> {
  const { rows: tablas } = await client.query<{ table_name: string }>(
    `select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name;`,
  );
  const out = new Map<string, number>();
  for (const { table_name } of tablas) {
    const { rows } = await client.query<{ count: string }>(`select count(*)::text as count from "public"."${table_name}";`);
    out.set(table_name, Number(rows[0]?.count ?? "0"));
  }
  return out;
}

export async function runRestoreAndVerify(dumpFile: string, newDbNameArg?: string): Promise<RestoreVerifyResult> {
  const psqlBin = findClientBinary("psql");
  const pgRestoreBin = findClientBinary("pg_restore");
  const port = DEFAULT_DB_PORT;

  const alreadyRunning = await isServerReachable(port);
  let engine: EmbeddedPostgresEngine | null = null;
  if (!alreadyRunning) {
    engine = await openEmbeddedPostgres({ databaseDir: DEFAULT_DB_DATA_DIR, port, persistent: true });
  }

  const newDbName = newDbNameArg ?? `restore_check_${Date.now()}`;

  try {
    execFileSync(psqlBin, ["-h", "127.0.0.1", "-p", String(port), "-U", DB_USER, "-d", "postgres", "-c", `create database "${newDbName}";`], {
      env: { ...process.env, PGPASSWORD: DB_PASSWORD },
      stdio: "inherit",
    });

    execFileSync(
      pgRestoreBin,
      ["-h", "127.0.0.1", "-p", String(port), "-U", DB_USER, "-d", newDbName, "--no-owner", "--no-privileges", dumpFile],
      { env: { ...process.env, PGPASSWORD: DB_PASSWORD }, stdio: "inherit" },
    );

    const origenClient = new pg.Client({ host: "127.0.0.1", port, user: DB_USER, password: DB_PASSWORD, database: DB_NAME });
    const restauradoClient = new pg.Client({ host: "127.0.0.1", port, user: DB_USER, password: DB_PASSWORD, database: newDbName });
    await origenClient.connect();
    await restauradoClient.connect();

    let origenPorTabla: Map<string, number>;
    let restauradoPorTabla: Map<string, number>;
    try {
      origenPorTabla = await contarFilasPorTabla(origenClient);
      restauradoPorTabla = await contarFilasPorTabla(restauradoClient);
    } finally {
      await origenClient.end();
      await restauradoClient.end();
    }

    const veredicto = evaluarVerificacion(origenPorTabla, restauradoPorTabla);
    return { newDbName, ...veredicto };
  } finally {
    if (engine) await engine.stop();
  }
}

async function main() {
  const dumpFile = process.argv[2];
  if (!dumpFile) {
    console.error("Uso: node --experimental-strip-types scripts/restore.ts <archivo .dump> [nombre_bd_nueva]");
    process.exitCode = 1;
    return;
  }
  const newDbName = process.argv[3];
  const result = await runRestoreAndVerify(dumpFile, newDbName);

  console.log(`Base restaurada: ${result.newDbName}`);
  console.log("Conteo de filas por tabla (origen vs. restaurado):");
  for (const t of result.porTabla) {
    console.log(`  ${t.coincide ? "OK  " : "DIFF"} ${t.tabla}: origen=${t.origen} restaurado=${t.restaurado}`);
  }
  console.log(`Total origen=${result.totalRowsOrigen} restaurado=${result.totalRowsRestaurado}`);
  if (result.ok) {
    console.log("VERIFICACIÓN: conteo igual en todas las tablas.");
  } else {
    console.log(`VERIFICACIÓN: FALLA -- ${result.motivoFalla}`);
  }
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].endsWith("restore.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
