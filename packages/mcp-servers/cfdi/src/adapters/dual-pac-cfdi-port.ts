/**
 * `DualPacCfdiPort` -- envuelve dos `CfdiPort` (primario/secundario) e implementa la
 * mitigación de riesgo que H15 documenta explícitamente: "CFDI de hospedaje mal
 * timbrado: validador fiscal previo + dos PAC intercambiables". Si el PAC primario
 * falla al timbrar, conmuta al secundario SIN duplicar el timbrado (idempotencia por
 * `folio` a nivel de este wrapper, independiente de cada PAC individual).
 *
 * No es un `CfdiPort` "real" por sí mismo -- compone dos adaptadores (reales o
 * simulados) ya construidos.
 */
import { InMemoryIdempotencyStore, type AdapterStatus } from "@atiende-hoteles/mcp-shared";
import type {
  CfdiPort,
  TimbrarInput,
  CfdiTimbrado,
  CancelarInput,
  CfdiCancelacion,
  DomainCfdiStatus,
  CfdiWebhookEvent,
} from "../port.ts";

export class DualPacCfdiPort implements CfdiPort {
  private readonly stampedByFolio = new InMemoryIdempotencyStore<{ timbrado: CfdiTimbrado; usedSecondary: boolean }>();

  constructor(
    private readonly primary: CfdiPort,
    private readonly secondary: CfdiPort,
  ) {}

  status(): AdapterStatus {
    const primaryStatus = this.primary.status();
    if (primaryStatus.available) return primaryStatus;
    const secondaryStatus = this.secondary.status();
    return {
      ...secondaryStatus,
      reason: secondaryStatus.available
        ? `PAC primario no disponible (${primaryStatus.reason ?? "sin razón"}); usando secundario`
        : secondaryStatus.reason,
    };
  }

  async timbrar(input: TimbrarInput): Promise<CfdiTimbrado> {
    const cached = this.stampedByFolio.get(input.folio);
    if (cached) return cached.timbrado;
    try {
      const timbrado = await this.primary.timbrar(input);
      this.stampedByFolio.set(input.folio, { timbrado, usedSecondary: false });
      return timbrado;
    } catch (primaryError) {
      try {
        const timbrado = await this.secondary.timbrar(input);
        this.stampedByFolio.set(input.folio, { timbrado, usedSecondary: true });
        return timbrado;
      } catch (secondaryError) {
        throw new AggregateError(
          [primaryError, secondaryError],
          `no se pudo timbrar el folio ${input.folio} ni con el PAC primario ni con el secundario`,
        );
      }
    }
  }

  /** Solo para pruebas: si el último timbrado exitoso de este folio usó el PAC secundario. */
  usedSecondaryFor(folio: string): boolean | undefined {
    return this.stampedByFolio.get(folio)?.usedSecondary;
  }

  async cancelar(input: CancelarInput): Promise<CfdiCancelacion> {
    // La cancelación se dirige siempre al PAC que timbró originalmente el UUID; en este
    // wrapper simplificado se intenta primero el primario (mismo criterio de fallback).
    try {
      return await this.primary.cancelar(input);
    } catch {
      return this.secondary.cancelar(input);
    }
  }

  async consultarEstado(uuid: string): Promise<DomainCfdiStatus> {
    try {
      return await this.primary.consultarEstado(uuid);
    } catch {
      return this.secondary.consultarEstado(uuid);
    }
  }

  async verifyAndNormalizeWebhook(
    rawBody: string,
    signatureHeader: string | undefined,
  ): Promise<CfdiWebhookEvent> {
    try {
      return await this.primary.verifyAndNormalizeWebhook(rawBody, signatureHeader);
    } catch {
      return this.secondary.verifyAndNormalizeWebhook(rawBody, signatureHeader);
    }
  }
}
