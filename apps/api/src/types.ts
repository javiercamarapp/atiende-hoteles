import type { DbClient, EmbeddedPostgresEngine } from "@atiende-hoteles/db";
import type { PaymentProviderPort } from "@atiende-hoteles/mcp-payments";
import type { CfdiPort } from "@atiende-hoteles/mcp-cfdi";
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
  /** H5 · REQ-INT-002/H15-007: `PaymentProviderPort` real (pendiente de credenciales
   *  del PSP, ver README) -- si se omite, `createApp` instancia un adaptador
   *  simulado ÚNICO (compartido entre requests, para que su idempotencia interna
   *  funcione) etiquetado `simulated: true`, nunca datos fabricados como si fueran
   *  un cobro real. */
  payments?: PaymentProviderPort;
  /** H5 · REQ-INT-005/H16-007: `CfdiPort` real (pendiente de PAC contratado + CSD del
   *  hotel) -- si se omite, `createApp` instancia dos PAC simulados detrás de
   *  `DualPacCfdiPort` (mismo mecanismo de conmutación que un PAC real tendría). */
  cfdi?: CfdiPort;
}

/** Vista de `AppDeps` con `payments`/`cfdi` ya resueltos -- lo que reciben los route
 *  factories que los usan (folios/night-audit/cfdi), para no repetir el `??` de
 *  default en cada uno. `createApp` (app.ts) es el único lugar que construye esto. */
export interface ResolvedAppDeps extends AppDeps {
  payments: PaymentProviderPort;
  cfdi: CfdiPort;
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
