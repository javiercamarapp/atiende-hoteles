// H2/H8 · Configuración de entorno (ADR-004/REQ-SEG-013): variables leídas
// explícitamente, sin valores por defecto silenciosos para secretos reales.
// `JWT_SECRET` tiene un default SOLO cuando `NODE_ENV !== "production"`, documentado
// como inseguro (nunca se usa contra datos reales) — en producción su ausencia hace
// fallar el arranque. `CORS_ALLOWED_ORIGINS` sigue el mismo patrón
// (auditoria-1/seguridad.md [MEDIO]): en producción es obligatoria y explícita, sin
// comodín `*`; fuera de producción cae a un default de los puertos de Vite dev/preview.

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
  /** Lista blanca de orígenes exactos permitidos por CORS (nunca `*`). Fuera de
   *  producción, si no se define, cae a los puertos locales de Vite (5173 dev, 4173
   *  preview) — nunca a "cualquier origen". */
  corsAllowedOrigins: string[];
}

const DEV_ONLY_JWT_SECRET = "atiende-hoteles-dev-only-jwt-secret-nunca-usar-en-produccion";
const DEV_ONLY_CORS_ORIGINS = ["http://localhost:5173", "http://localhost:4173"];

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

  const corsRaw = source.CORS_ALLOWED_ORIGINS?.trim();
  const corsAllowedOrigins = corsRaw
    ? corsRaw.split(",").map((o) => o.trim()).filter(Boolean)
    : isProd
      ? undefined
      : DEV_ONLY_CORS_ORIGINS;
  if (!corsAllowedOrigins || corsAllowedOrigins.length === 0) {
    throw new Error(
      "CORS_ALLOWED_ORIGINS no está configurado. En producción es obligatorio " +
        "(auditoria-1/seguridad.md [MEDIO]): lista explícita separada por comas, " +
        "nunca un comodín '*'.",
    );
  }
  if (corsAllowedOrigins.includes("*")) {
    throw new Error("CORS_ALLOWED_ORIGINS no admite '*': declara los orígenes exactos permitidos.");
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
    corsAllowedOrigins,
  };
}
