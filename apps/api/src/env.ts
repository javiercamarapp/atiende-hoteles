// H2 · Configuración de entorno (ADR-004/REQ-SEG-013): variables leídas explícitamente,
// sin valores por defecto silenciosos para secretos reales. `JWT_SECRET` tiene un
// default SOLO cuando `NODE_ENV !== "production"`, documentado como inseguro (nunca se
// usa contra datos reales) — en producción su ausencia hace fallar el arranque.

export interface AppEnv {
  nodeEnv: string;
  port: number;
  jwtSecret: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  dbDataDir: string;
  dbPort: number;
  rateLimitPerIpPerMinute: number;
  rateLimitPerUserPerMinute: number;
}

const DEV_ONLY_JWT_SECRET = "atiende-hoteles-dev-only-jwt-secret-nunca-usar-en-produccion";

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const nodeEnv = source.NODE_ENV ?? "development";
  const isProd = nodeEnv === "production";

  const jwtSecret = source.JWT_SECRET ?? (isProd ? undefined : DEV_ONLY_JWT_SECRET);
  if (!jwtSecret) {
    throw new Error(
      "JWT_SECRET no está configurado. En producción es obligatorio (REQ-SEG-013): " +
        "no existe un valor por defecto silencioso.",
    );
  }

  return {
    nodeEnv,
    port: Number(source.PORT ?? 3001),
    jwtSecret,
    accessTokenTtlSeconds: Number(source.ACCESS_TOKEN_TTL_SECONDS ?? 15 * 60),
    refreshTokenTtlSeconds: Number(source.REFRESH_TOKEN_TTL_SECONDS ?? 30 * 24 * 60 * 60),
    dbDataDir: source.DB_DATA_DIR ?? "packages/db/.pgdata",
    dbPort: Number(source.DB_PORT ?? 54329),
    rateLimitPerIpPerMinute: Number(source.RATE_LIMIT_PER_IP_PER_MINUTE ?? 300),
    rateLimitPerUserPerMinute: Number(source.RATE_LIMIT_PER_USER_PER_MINUTE ?? 600),
  };
}
