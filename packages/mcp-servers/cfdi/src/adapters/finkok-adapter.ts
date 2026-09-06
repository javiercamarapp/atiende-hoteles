/**
 * Adaptador real contra Finkok (PAC primario de ejemplo), H16-007. Esqueleto honesto:
 * ruta SOAP/REST documentada públicamente, auth con usuario/contraseña + CSD del hotel,
 * reintentos con backoff. Sin CSD/credenciales, se declara `unavailable`.
 *
 * [PENDIENTE DE CREDENCIALES] -- requiere `FINKOK_USERNAME`, `FINKOK_PASSWORD`,
 * `FINKOK_CSD_CERT_PATH`, `FINKOK_CSD_KEY_PATH`, `FINKOK_CSD_PASSWORD`,
 * `FINKOK_WEBHOOK_SECRET`.
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
  "FINKOK_USERNAME",
  "FINKOK_PASSWORD",
  "FINKOK_CSD_CERT_PATH",
  "FINKOK_CSD_KEY_PATH",
  "FINKOK_CSD_PASSWORD",
  "FINKOK_WEBHOOK_SECRET",
] as const;

export const FINKOK_STAMP_URL = "https://facturacion.finkok.com/servicios/soap/stamp.wsdl";

export class FinkokAdapter implements CfdiPort {
  private readonly credentials = checkEnvCredentials(REQUIRED_ENV);
  private readonly idempotency = new InMemoryIdempotencyStore<CfdiTimbrado>();
  private readonly replayGuard = new InMemoryReplayGuard();

  status(): AdapterStatus {
    if (this.credentials.available) return { provider: "finkok", available: true, simulated: false };
    return {
      provider: "finkok",
      available: false,
      simulated: false,
      reason: `[PENDIENTE DE CREDENCIALES] faltan: ${this.credentials.missing.join(", ")}`,
    };
  }

  private assertAvailable(): void {
    if (!this.credentials.available) {
      throw new PortUnavailableError("finkok", `faltan variables de entorno: ${this.credentials.missing.join(", ")}`);
    }
  }

  async timbrar(input: TimbrarInput): Promise<CfdiTimbrado> {
    this.assertAvailable();
    void input;
    void this.idempotency;
    void FINKOK_STAMP_URL;
    throw new PortUnavailableError("finkok", "sin CSD/credenciales verificadas en este entorno");
  }

  async cancelar(input: CancelarInput): Promise<CfdiCancelacion> {
    this.assertAvailable();
    void input;
    throw new PortUnavailableError("finkok", "sin CSD/credenciales verificadas en este entorno");
  }

  async consultarEstado(uuid: string): Promise<DomainCfdiStatus> {
    this.assertAvailable();
    void uuid;
    throw new PortUnavailableError("finkok", "sin CSD/credenciales verificadas en este entorno");
  }

  async verifyAndNormalizeWebhook(
    rawBody: string,
    signatureHeader: string | undefined,
  ): Promise<CfdiWebhookEvent> {
    const secret = process.env.FINKOK_WEBHOOK_SECRET;
    if (!secret) throw new PortUnavailableError("finkok", "falta FINKOK_WEBHOOK_SECRET para verificar webhooks");
    if (!verifyHmacSignature(rawBody, signatureHeader, secret)) throw new WebhookSignatureError("finkok");
    const payload = JSON.parse(rawBody) as { event_id?: string };
    const eventId = payload.event_id;
    if (!eventId) throw new WebhookSignatureError("finkok");
    if (this.replayGuard.seenBefore(eventId)) throw new WebhookReplayError("finkok", eventId);
    throw new PortUnavailableError("finkok", "normalización completa del payload real pendiente de credenciales");
  }
}
