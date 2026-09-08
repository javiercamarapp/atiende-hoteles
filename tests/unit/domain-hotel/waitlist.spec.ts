// REQ-RES-006/H01-010,H02-011: lógica pura de FIFO/expiración de la lista de espera.
// Ver tests/integration/reservas/lista-espera.spec.ts para el flujo completo
// (cancelación real dispara la oferta) contra embedded-postgres.
import { describe, expect, it } from "vitest";
import {
  computeOfferExpiresAt,
  isOfferExpired,
  matchesWaitlistRequest,
  selectNextWaitlistCandidate,
  WAITLIST_OFFER_WINDOW_HOURS,
  type WaitlistCandidate,
} from "@atiende-hoteles/domain-hotel";

const CRITERIA = { roomTypeId: "rt-1", checkInDate: "2026-10-01", checkOutDate: "2026-10-03" };

function candidate(overrides: Partial<WaitlistCandidate> & { id: string; createdAt: string }): WaitlistCandidate {
  return {
    roomTypeId: CRITERIA.roomTypeId,
    checkInDate: CRITERIA.checkInDate,
    checkOutDate: CRITERIA.checkOutDate,
    status: "esperando",
    ...overrides,
  };
}

describe("matchesWaitlistRequest", () => {
  it("solo empareja un candidato 'esperando' con EXACTAMENTE el mismo room_type y rango de fechas", () => {
    const c = candidate({ id: "a", createdAt: "2026-09-01T00:00:00Z" });
    expect(matchesWaitlistRequest(c, CRITERIA)).toBe(true);
    expect(matchesWaitlistRequest({ ...c, status: "ofertada" }, CRITERIA)).toBe(false);
    expect(matchesWaitlistRequest({ ...c, roomTypeId: "rt-2" }, CRITERIA)).toBe(false);
    expect(matchesWaitlistRequest({ ...c, checkInDate: "2026-10-02" }, CRITERIA)).toBe(false);
    expect(matchesWaitlistRequest({ ...c, checkOutDate: "2026-10-04" }, CRITERIA)).toBe(false);
  });
});

describe("selectNextWaitlistCandidate (FIFO)", () => {
  it("elige al contacto con created_at MÁS ANTIGUO, sin importar el orden de llegada del arreglo", () => {
    const segundo = candidate({ id: "segundo", createdAt: "2026-09-02T00:00:00Z" });
    const primero = candidate({ id: "primero", createdAt: "2026-09-01T00:00:00Z" });
    const tercero = candidate({ id: "tercero", createdAt: "2026-09-03T00:00:00Z" });

    // Deliberadamente desordenado: la garantía FIFO vive en la función, no en que quien
    // llama ya haya ordenado.
    const winner = selectNextWaitlistCandidate([tercero, segundo, primero], CRITERIA);
    expect(winner?.id).toBe("primero");
  });

  it("ignora candidatos que no coinciden con room_type/fechas o que ya no están 'esperando'", () => {
    const otroRoomType = candidate({ id: "otro-rt", createdAt: "2026-09-01T00:00:00Z", roomTypeId: "rt-2" });
    const yaOfertado = candidate({ id: "ya-ofertado", createdAt: "2026-09-01T00:00:00Z", status: "ofertada" });
    const elegible = candidate({ id: "elegible", createdAt: "2026-09-02T00:00:00Z" });

    const winner = selectNextWaitlistCandidate([otroRoomType, yaOfertado, elegible], CRITERIA);
    expect(winner?.id).toBe("elegible");
  });

  it("devuelve null cuando ningún candidato es elegible (cola vacía para ese room_type/fechas)", () => {
    const otro = candidate({ id: "otro", createdAt: "2026-09-01T00:00:00Z", checkInDate: "2026-11-01", checkOutDate: "2026-11-03" });
    expect(selectNextWaitlistCandidate([otro], CRITERIA)).toBeNull();
    expect(selectNextWaitlistCandidate([], CRITERIA)).toBeNull();
  });

  it("desempata por `id` cuando dos candidatos comparten EXACTAMENTE el mismo created_at (determinista)", () => {
    const mismoInstante = "2026-09-01T00:00:00.000Z";
    const b = candidate({ id: "b", createdAt: mismoInstante });
    const a = candidate({ id: "a", createdAt: mismoInstante });
    // El resultado no depende del orden de entrada: siempre gana el `id` menor.
    expect(selectNextWaitlistCandidate([b, a], CRITERIA)?.id).toBe("a");
    expect(selectNextWaitlistCandidate([a, b], CRITERIA)?.id).toBe("a");
  });
});

describe("ventana de expiración de la oferta", () => {
  it("computeOfferExpiresAt suma la ventana configurada (default WAITLIST_OFFER_WINDOW_HOURS) a `now`", () => {
    const now = "2026-09-01T00:00:00.000Z";
    expect(computeOfferExpiresAt(now)).toBe(
      new Date(new Date(now).getTime() + WAITLIST_OFFER_WINDOW_HOURS * 60 * 60 * 1000).toISOString(),
    );
    expect(computeOfferExpiresAt(now, 2)).toBe("2026-09-01T02:00:00.000Z");
  });

  it("isOfferExpired es false justo antes del límite y true en/después del límite (frontera exacta)", () => {
    const now = "2026-09-01T00:00:00.000Z";
    const expiresAt = computeOfferExpiresAt(now, 1);
    const unMsAntes = new Date(new Date(expiresAt).getTime() - 1).toISOString();
    expect(isOfferExpired(expiresAt, unMsAntes)).toBe(false);
    expect(isOfferExpired(expiresAt, expiresAt)).toBe(true);
  });
});
