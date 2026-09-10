import type { DbClient, EmbeddedPostgresEngine } from "@atiende-hoteles/db";
import type { PaymentProviderPort } from "@atiende-hoteles/mcp-payments";
import type { CfdiPort } from "@atiende-hoteles/mcp-cfdi";
import type { EmailPort } from "@atiende-hoteles/email";
import type { BillingProviderPort } from "@atiende-hoteles/mcp-billing";
import type { OutboundTaskSyncGateway, OutboundTaskSyncPort } from "@atiende-hoteles/mcp-outbound";
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
  /** H12a · `EmailPort` real (pendiente de credenciales de Resend/SMTP, ver
   *  packages/email/README.md) -- si se omite, `createApp` instancia un
   *  `FakeEmailAdapter` (respaldado por la tabla `email_outbox`, migración 0094) --
   *  mismo mecanismo de conmutación honesta que `payments`/`cfdi` arriba. */
  emailPort?: EmailPort;
  /** H12c · REQ-LAUNCH-047: `BillingProviderPort` real (pendiente de cuenta Stripe/
   *  Conekta, ver README de packages/mcp-servers/billing) -- si se omite, `createApp`
   *  instancia un `FakeBillingAdapter` único (mismo criterio que `payments`/`cfdi`). */
  billing?: BillingProviderPort;
  /** Conector outbound PMS-enterprise (packages/mcp-servers/outbound,
   *  docs/integraciones/conector-pms-enterprise.md): `OutboundTaskSyncPort` real
   *  (mecanismo de envío en sí, sin credencial global -- la credencial es por hotel, ver
   *  `hotel_pms_outbound_config`) -- si se omite, `createApp` instancia
   *  `FakeOutboundTaskSyncAdapter` (mismo mecanismo de conmutación honesta que
   *  `payments`/`cfdi`/`billing` arriba). */
  outboundTaskSync?: OutboundTaskSyncPort;
}

/** Vista de `AppDeps` con `payments`/`cfdi`/`emailPort`/`billing`/`outboundTaskSync` ya
 *  resueltos -- lo que reciben los route factories que los usan (folios/night-audit/
 *  cfdi/registro/correo/auth-google/suscripcion/housekeeping/mantenimiento/tickets/
 *  reputacion/voz/agentes), para no repetir el `??` de default en cada uno. `createApp`
 *  (app.ts) es el único lugar que construye esto. */
export interface ResolvedAppDeps extends AppDeps {
  payments: PaymentProviderPort;
  cfdi: CfdiPort;
  emailPort: EmailPort;
  billing: BillingProviderPort;
  outboundTaskSync: OutboundTaskSyncPort;
  /** `OutboundTaskSyncGateway` ya armado con `engine.admin` (sin RLS a propósito, ver
   *  ese paquete) + `outboundTaskSync` -- lo que las tools de agent-core reciben como
   *  `deps.outboundSync` (`OutboundTaskSyncLike`, forma estructural mínima). Un solo
   *  gateway por proceso, igual que el resto de adaptadores compartidos de arriba. */
  outboundTaskSyncGateway: OutboundTaskSyncGateway;
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
