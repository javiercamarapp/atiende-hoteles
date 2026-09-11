// REQ-CRM-010: reglas puras de `filterUsableUgc()`/`generateMonthlyContentCalendar()`
// -- el criterio de aceptación exacto (docs/ACEPTACION.md) es "UGC sin consentimiento →
// 0 uso permitido", verificado aquí sin tocar base de datos (la versión de punta a punta
// contra la API real y embedded-postgres vive en tests/adversarial/ugc-consentimiento.spec.ts).
import { describe, expect, it } from "vitest";
import {
  filterUsableUgc,
  generateMonthlyContentCalendar,
  type GuestUgcSubmission,
} from "@atiende-hoteles/domain-hotel";

function submission(overrides: Partial<GuestUgcSubmission> & { id: string }): GuestUgcSubmission {
  return {
    guestId: "guest-1",
    reservationId: "res-1",
    mediaType: "foto",
    mediaReference: `wamid.${overrides.id}`,
    caption: null,
    consentGranted: true,
    capturedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("filterUsableUgc (REQ-CRM-010)", () => {
  it("descarta toda pieza sin consentimiento otorgado", () => {
    const items = [
      submission({ id: "a", consentGranted: true }),
      submission({ id: "b", consentGranted: false }),
      submission({ id: "c", consentGranted: true }),
    ];
    const usable = filterUsableUgc(items);
    expect(usable.map((s) => s.id)).toEqual(["a", "c"]);
  });

  it("un conjunto donde NADIE otorgó consentimiento -> 0 uso permitido", () => {
    const items = [submission({ id: "a", consentGranted: false }), submission({ id: "b", consentGranted: false })];
    expect(filterUsableUgc(items)).toHaveLength(0);
  });
});

describe("generateMonthlyContentCalendar (REQ-CRM-010)", () => {
  it("UGC sin consentimiento -> 0 uso permitido: nunca aparece en el calendario aunque se pase sin pre-filtrar", () => {
    const items = [
      submission({ id: "sin-consentimiento-1", consentGranted: false, capturedAt: "2026-02-01T00:00:00.000Z" }),
      submission({ id: "sin-consentimiento-2", consentGranted: false, capturedAt: "2026-02-02T00:00:00.000Z" }),
    ];
    const calendar = generateMonthlyContentCalendar(items, { month: "2026-02", postsPerWeek: 3 });
    expect(calendar.entries).toHaveLength(0);
    expect(calendar.entries.some((e) => e.submissionId.startsWith("sin-consentimiento"))).toBe(false);
    expect(calendar.excludedByConsentCount).toBe(2);
  });

  it("una mezcla de consentido/no consentido: solo lo consentido entra al calendario", () => {
    const items = [
      submission({ id: "si-1", consentGranted: true, capturedAt: "2026-03-01T00:00:00.000Z" }),
      submission({ id: "no-1", consentGranted: false, capturedAt: "2026-03-02T00:00:00.000Z" }),
      submission({ id: "si-2", consentGranted: true, capturedAt: "2026-03-03T00:00:00.000Z" }),
    ];
    const calendar = generateMonthlyContentCalendar(items, { month: "2026-03", postsPerWeek: 1 });
    const ids = calendar.entries.map((e) => e.submissionId);
    expect(ids).toContain("si-1");
    expect(ids).toContain("si-2");
    expect(ids).not.toContain("no-1");
    expect(calendar.excludedByConsentCount).toBe(1);
  });

  it("reparte el contenido usable en orden de captura (FIFO) sin repetir ninguna pieza", () => {
    const items = Array.from({ length: 4 }, (_, i) =>
      submission({ id: `p${i}`, consentGranted: true, capturedAt: `2026-04-0${i + 1}T00:00:00.000Z` }),
    );
    const calendar = generateMonthlyContentCalendar(items, { month: "2026-04", postsPerWeek: 5 });
    const ids = calendar.entries.map((e) => e.submissionId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["p0", "p1", "p2", "p3"]);
    expect(calendar.leftoverUsableCount).toBe(0);
  });

  it("sin contenido usable suficiente, el calendario sale más corto en vez de inventar publicaciones", () => {
    const items = [submission({ id: "unico", consentGranted: true })];
    const calendar = generateMonthlyContentCalendar(items, { month: "2026-05", postsPerWeek: 7 });
    expect(calendar.entries).toHaveLength(1);
    expect(calendar.leftoverUsableCount).toBe(0);
  });

  it("rechaza un mes con formato inválido", () => {
    expect(() => generateMonthlyContentCalendar([], { month: "2026/05", postsPerWeek: 1 })).toThrow(/mes_invalido/);
  });

  it("todas las fechas generadas caen dentro del mes pedido", () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      submission({ id: `q${i}`, consentGranted: true, capturedAt: `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00.000Z` }),
    );
    const calendar = generateMonthlyContentCalendar(items, { month: "2026-06", postsPerWeek: 4 });
    expect(calendar.entries.length).toBeGreaterThan(0);
    expect(calendar.entries.every((e) => e.date.startsWith("2026-06-"))).toBe(true);
  });
});
