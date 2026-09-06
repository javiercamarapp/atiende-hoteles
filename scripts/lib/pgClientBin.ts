// H8 · Localiza los binarios cliente de Postgres (`pg_dump`/`psql`/`pg_restore`) que
// el paquete npm `embedded-postgres` NO incluye (solo trae `postgres`/`pg_ctl`/
// `initdb` -- verificado el 2026-09-06 en `node_modules/@embedded-postgres/<plataforma>
// /native/bin/`, mismo hueco que documenta docs/BLOQUEOS.md B-002 "sin ... psql").
// En esta máquina se resolvió instalando `libpq` vía Homebrew (`brew install libpq`,
// keg-only: no se symlinkea a /opt/homebrew/bin porque choca con un `postgresql`
// completo) -- 100% local y gratuito, sin servicio externo de pago. Un entorno de CI
// (ubuntu-latest) trae `pg_dump`/`psql`/`pg_restore` de fábrica vía `postgresql-client`
// o puede instalarlo con `apt-get install -y postgresql-client`, así que este helper
// primero busca en PATH antes de asumir la ruta de Homebrew.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// auditoria-2/operabilidad [ALTO]: este default ERA la cadena relativa
// "packages/db/.pgdata", resuelta por `embedded-postgres` contra `process.cwd()` en vez
// del archivo. `backup.sh`/`restore.sh` fijan el cwd a la raíz del repo (`cd
// "$(dirname "$0")/.."`) así que funcionaban por accidente al invocarse como wrapper,
// pero cualquier otra forma de invocar `scripts/backup.ts`/`scripts/restore.ts`
// (directamente, desde otro cwd, o desde un job de CI con distinto directorio de
// trabajo) resolvía una carpeta DISTINTA a la que usa el Postgres embebido real de
// `apps/api`/`packages/db/src/cli.ts` -- backup silencioso de un cluster vacío. Se
// ancla al archivo fuente (mismo patrón que `packages/db/src/cli.ts`), nunca a
// `process.cwd()`, para que las tres ubicaciones (aquí, `apps/api/src/env.ts`,
// `packages/db/src/cli.ts`) sean siempre la MISMA carpeta física sin importar desde
// dónde se invoque el proceso.
const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DB_DATA_DIR = join(here, "..", "..", "packages", "db", ".pgdata");
export const DEFAULT_DB_PORT = Number(process.env.DB_PORT ?? 54329);
export const DB_USER = "postgres";
export const DB_PASSWORD = "postgres_dev_only_local";
export const DB_NAME = "postgres";

const HOMEBREW_LIBPQ_BIN = "/opt/homebrew/opt/libpq/bin";

function which(bin: string): string | null {
  try {
    return execFileSync("which", [bin], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

export function findClientBinary(bin: "pg_dump" | "psql" | "pg_restore"): string {
  const envVar = process.env[`PG_${bin.toUpperCase()}_BIN`] ?? process.env.PG_BIN_DIR ? `${process.env.PG_BIN_DIR}/${bin}` : undefined;
  if (envVar && existsSync(envVar)) return envVar;

  const onPath = which(bin);
  if (onPath) return onPath;

  const homebrewPath = `${HOMEBREW_LIBPQ_BIN}/${bin}`;
  if (existsSync(homebrewPath)) return homebrewPath;

  throw new Error(
    `No se encontró el binario "${bin}" (embedded-postgres no lo incluye). ` +
      `Instálalo con "brew install libpq" (macOS, gratis) o "apt-get install -y postgresql-client" (Linux/CI), ` +
      `o define PG_${bin.toUpperCase()}_BIN=/ruta/al/binario.`,
  );
}

export async function isServerReachable(port: number, host = "127.0.0.1", timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}
