/**
 * `FakeOutboundTaskSyncAdapter` -- adaptador simulado del conector outbound
 * PMS-enterprise (mismo criterio que `FakeStripeAdapter`/`FakeGenericPaymentAdapter`):
 * nunca hace red real, registra cada llamada en memoria (`pushed`) para que las pruebas
 * de contrato/integración verifiquen exactamente qué se hubiera enviado, incluida la
 * firma que `WebhookOutboundAdapter` habría calculado (`signFixture`, para que una
 * prueba pueda simular el LADO RECEPTOR del webhook sin depender del adaptador real).
 */
import { signHmac, type AdapterStatus } from "@atiende-hoteles/mcp-shared";
import type {
  OutboundTask,
  OutboundTaskDestination,
  OutboundTaskSyncPort,
  OutboundTaskSyncResult,
} from "../port.ts";

export interface FakeOutboundPushCall {
  readonly destination: OutboundTaskDestination;
  readonly task: OutboundTask;
}

export class FakeOutboundTaskSyncAdapter implements OutboundTaskSyncPort {
  readonly simulated = true as const;
  readonly pushed: FakeOutboundPushCall[] = [];
  private sequence = 0;

  status(): AdapterStatus {
    return { provider: "webhook-outbound-generico", available: true, simulated: true };
  }

  async pushTask(destination: OutboundTaskDestination, task: OutboundTask): Promise<OutboundTaskSyncResult> {
    this.pushed.push({ destination, task });
    this.sequence += 1;
    return { delivered: true, skipped: false, externalTaskId: `FAKE-OUTBOUND-${this.sequence}` };
  }

  /** Firma el mismo `rawBody` que `WebhookOutboundAdapter` firmaría de verdad -- para
   *  que una prueba que juega el rol del "sistema del hotel" pueda verificar la firma
   *  recibida sin depender del adaptador real. */
  signFixture(task: OutboundTask, secret: string): { rawBody: string; signature: string } {
    const rawBody = JSON.stringify(task);
    return { rawBody, signature: signHmac(rawBody, secret) };
  }
}
