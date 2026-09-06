import type { DbClient, EmbeddedPostgresEngine } from "@atiende-hoteles/db";
import type { AppEnv } from "./env.ts";
import type { Logger } from "./logger.ts";
import type { MetricsRegistry } from "./metrics.ts";
import type { RateLimiter } from "./lib/rateLimit.ts";

export interface AppDeps {
  engine: EmbeddedPostgresEngine;
  env: AppEnv;
  logger: Logger;
  ipLimiter: RateLimiter;
  userLimiter: RateLimiter;
  metrics: MetricsRegistry;
}

export type Variables = {
  requestId: string;
  userId: string;
  userEmail: string;
  orgId: string;
  hotelIds: string[];
  /** Rol del usuario en el hotel de la ruta actual, fijado por `requireHotelMembership`
   *  (middleware.ts). Capa de autorización a nivel de aplicación -- la capa final e
   *  irrenunciable sigue siendo la RLS de packages/db. */
  hotelRole: string;
  db: DbClient;
};

export interface HonoEnvBindings {
  Variables: Variables;
}
