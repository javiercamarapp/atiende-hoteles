/**
 * Adaptador real contra SW Sapien/"SW" (PAC secundario de ejemplo), H16-007 -- segundo
 * PAC intercambiable, mitigación de "CFDI de hospedaje mal timbrado" (H15 §5). Mismo
 * esqueleto honesto que `FinkokAdapter`.
 *
 * [PENDIENTE DE CREDENCIALES] -- requiere `SW_API_TOKEN`, `SW_CSD_CERT_PATH`,
 * `SW_CSD_KEY_PATH`, `SW_CSD_PASSWORD`, `SW_WEBHOOK_SECRET`.
 */
import {
  PortUnavailableError,
  WebhookSignatureError,
  WebhookReplayError,
  InMemoryIdempotencyStore,
  InMemoryReplayGuard,
  verifyHmacSignature,
  checkEnvCredentials,
  type AdapterStatus,
} from "@atiende-hoteles/mcp-shared";
import type {
  CfdiPort,
  TimbrarInput,
  CfdiTimbrado,
  CancelarInput,
  CfdiCancelacion,
  DomainCfdiStatus,
  CfdiWebhookEvent,
} from "../port.ts";

const REQUIRED_ENV = [
  "SW_API_TOKEN",
  "SW_CSD_CERT_PATH",
  "SW_CSD_KEY_PATH",
  "SW_CSD_PASSWORD",
  "SW_WEBHOOK_SECRET",
] as const;

export const SW_STAMP_URL = "https://services.sw.com.mx/cfdi40/stamp/v4";

export class SwSapienAdapter implements CfdiPort {
  private readonly credentials = checkEnvCredentials(REQUIRED_ENV);
  private readonly idempotency = new InMemoryIdempotencyStore<CfdiTimbrado>();
  private readonly replayGuard = new InMemoryReplayGuard();

  status(): AdapterStatus {
    if (this.credentials.available) return { provider: "sw-sapien", available: true, simulated: false };
    return {
      provider: "sw-sapien",
      available: false,
      simulated: false,
      reason: `[PENDIENTE DE CREDENCIALES] faltan: ${this.credentials.missing.join(", ")}`,
    };
  }

  private assertAvailable(): void {
    if (!this.credentials.available) {
      throw new PortUnavailableError("sw-sapien", `faltan variables de entorno: ${this.credentials.missing.join(", ")}`);
    }
  }

  async timbrar(input: TimbrarInput): Promise<CfdiTimbrado> {
    this.assertAvailable();
    void input;
    void this.idempotency;
    void SW_STAMP_URL;
    throw new PortUnavailableError("sw-sapien", "sin CSD/credenciales verificadas en este entorno");
  }

  async cancelar(input: CancelarInput): Promise<CfdiCancelacion> {
    this.assertAvailable();
    void input;
    throw new PortUnavailableError("sw-sapien", "sin CSD/credenciales verificadas en este entorno");
  }

  async consultarEstado(uuid: string): Promise<DomainCfdiStatus> {
    this.assertAvailable();
    void uuid;
    throw new PortUnavailableError("sw-sapien", "sin CSD/credenciales verificadas en este entorno");
  }

  async verifyAndNormalizeWebhook(
    rawBody: string,
    signatureHeader: string | undefined,
  ): Promise<CfdiWebhookEvent> {
    const secret = process.env.SW_WEBHOOK_SECRET;
    if (!secret) throw new PortUnavailableError("sw-sapien", "falta SW_WEBHOOK_SECRET para verificar webhooks");
    if (!verifyHmacSignature(rawBody, signatureHeader, secret)) throw new WebhookSignatureError("sw-sapien");
    const payload = JSON.parse(rawBody) as { event_id?: string };
    const eventId = payload.event_id;
    if (!eventId) throw new WebhookSignatureError("sw-sapien");
    if (this.replayGuard.seenBefore(eventId)) throw new WebhookReplayError("sw-sapien", eventId);
    throw new PortUnavailableError("sw-sapien", "normalización completa del payload real pendiente de credenciales");
  }
}
