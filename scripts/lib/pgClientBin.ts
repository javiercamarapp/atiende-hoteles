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

export const DEFAULT_DB_DATA_DIR = "packages/db/.pgdata";
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
