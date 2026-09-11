// REQ-CRM-010: "El sistema debe capturar contenido generado por el huésped (UGC) vía
// WhatsApp post-estancia con registro explícito de consentimiento de uso, y generar un
// calendario mensual de contenido/publicaciones." (H05-005, H05-018).
//
// La captura en sí (fila `guest_ugc_submission`, migración 0149) y el registro de
// consentimiento que la acompaña (tabla `consent` ya existente desde REQ-HUE-024/
// REQ-SEG-002, `consent_kind` ampliado con 'ugc' en la migración 0148) viven en
// `apps/api/src/domain/ugc.ts` + `apps/api/src/routes/ugc.ts` (I/O). Este módulo es la
// parte PURA: decide qué UGC puede usarse y arma el calendario mensual, sin tocar la
// base de datos -- mismo principio de separación que `consentLedger.ts`/
// `clubSegundoViaje.ts`.
//
// El criterio de aceptación exacto (docs/ACEPTACION.md, fila REQ-CRM-010) exige
// verificar "UGC sin consentimiento → 0 uso permitido": un huésped puede mandar una
// foto/video y, en la MISMA interacción, negar el consentimiento de USO (`granted =
// false` en el consentimiento ligado a esa captura) -- ese envío se captura igual (el
// dato nunca se descarta, queda en el registro para trazabilidad) pero jamás debe poder
// aparecer en ningún calendario de publicaciones generado. La regla se aplica en DOS
// capas (defensa en profundidad, mismo criterio que `isMarketingSendBlocked` se revisa
// en más de un punto): `filterUsableUgc()` es la única función que decide "usable", y
// `generateMonthlyContentCalendar()` la vuelve a aplicar internamente sobre lo que
// recibe -- así ninguna llamada futura que olvide pre-filtrar puede colar contenido no
// consentido en un calendario.
import { z } from "zod";

export const ugcMediaTypeSchema = z.enum(["foto", "video", "texto"]);
export type UgcMediaType = z.infer<typeof ugcMediaTypeSchema>;

export interface GuestUgcSubmission {
  id: string;
  guestId: string;
  reservationId: string;
  mediaType: UgcMediaType;
  mediaReference: string;
  caption: string | null;
  /** Consentimiento de USO registrado en la MISMA captura (ver `capture_guest_ugc()`,
   *  migración 0149) -- `false` significa "el huésped mandó el contenido pero negó
   *  autorización para publicarlo", nunca "todavía no se le preguntó". */
  consentGranted: boolean;
  capturedAt: string;
}

/**
 * Único punto que decide si una pieza de UGC puede USARSE (publicarse): exige
 * `consentGranted === true`. La captura (la fila en BD) nunca depende de esto -- se
 * guarda siempre, con o sin consentimiento; esta función solo filtra qué puede pasar a
 * un calendario de publicaciones.
 */
export function filterUsableUgc(submissions: readonly GuestUgcSubmission[]): GuestUgcSubmission[] {
  return submissions.filter((s) => s.consentGranted === true);
}

export interface ContentCalendarEntry {
  /** yyyy-mm-dd dentro del mes pedido. */
  date: string;
  submissionId: string;
  guestId: string;
  mediaType: UgcMediaType;
  mediaReference: string;
  caption: string | null;
}

export interface MonthlyContentCalendar {
  month: string;
  entries: ContentCalendarEntry[];
  /** Piezas usables (con consentimiento) que no alcanzaron un cupo este mes -- honesto
   *  en vez de fabricar más publicaciones de las que hay contenido real para llenar. */
  leftoverUsableCount: number;
  /** Piezas capturadas pero NUNCA elegibles por falta de consentimiento -- expuesto
   *  para que quien arma el calendario vea, sin adivinar, cuánto contenido quedó fuera
   *  por esta causa exacta (distinto de "no alcanzó cupo"). */
  excludedByConsentCount: number;
}

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

function daysInMonth(month: string): number {
  const [year, monthNum] = month.split("-").map(Number) as [number, number];
  // Día 0 del mes siguiente = último día del mes pedido (UTC, sin dependencia de zona
  // horaria del proceso que corre el código).
  return new Date(Date.UTC(year, monthNum, 0)).getUTCDate();
}

/** Reparte `totalSlots` cupos lo más uniformemente posible a lo largo del mes -- cada
 *  cupo cae en el punto medio de su fracción del mes, así que con pocos cupos quedan
 *  espaciados en vez de amontonados al inicio. */
function buildSlotDates(month: string, totalSlots: number): string[] {
  const total = daysInMonth(month);
  const dates: string[] = [];
  for (let i = 0; i < totalSlots; i++) {
    const day = Math.min(total, Math.max(1, Math.round(((i + 0.5) * total) / totalSlots)));
    dates.push(`${month}-${String(day).padStart(2, "0")}`);
  }
  return dates;
}

/**
 * Genera el calendario mensual de publicaciones (lo que REQ-CRM-010 pide poder
 * "generar"): reparte el UGC USABLE (con consentimiento vigente) en `postsPerWeek`
 * cupos por semana calendario dentro del mes pedido, en orden de captura (FIFO -- lo
 * más antiguo primero, para no dejar contenido envejeciendo sin publicarse). Nunca
 * repite la misma pieza dos veces en el mismo calendario y nunca inventa una
 * publicación de la nada: si no hay suficiente contenido usable, el calendario sale
 * más corto y lo reporta en `leftoverUsableCount`/`excludedByConsentCount` en vez de
 * fabricar cupos vacíos con contenido inexistente.
 */
export function generateMonthlyContentCalendar(
  submissions: readonly GuestUgcSubmission[],
  params: { month: string; postsPerWeek: number },
): MonthlyContentCalendar {
  if (!MONTH_PATTERN.test(params.month)) {
    throw new Error(`mes_invalido: se esperaba formato yyyy-mm, se recibió "${params.month}".`);
  }
  const postsPerWeek = Math.max(0, Math.floor(params.postsPerWeek));
  const excludedByConsentCount = submissions.length - filterUsableUgc(submissions).length;

  // Defensa en profundidad: se vuelve a filtrar aquí aunque quien llama ya debería
  // haber pasado solo contenido usable -- ver cabecera del archivo.
  const usable = [...filterUsableUgc(submissions)].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));

  if (postsPerWeek === 0 || usable.length === 0) {
    return { month: params.month, entries: [], leftoverUsableCount: usable.length, excludedByConsentCount };
  }

  const weeksInMonth = Math.ceil(daysInMonth(params.month) / 7);
  const totalSlots = weeksInMonth * postsPerWeek;
  const slotDates = buildSlotDates(params.month, totalSlots);

  const entries: ContentCalendarEntry[] = [];
  const assignedCount = Math.min(usable.length, slotDates.length);
  for (let i = 0; i < assignedCount; i++) {
    const submission = usable[i]!;
    entries.push({
      date: slotDates[i]!,
      submissionId: submission.id,
      guestId: submission.guestId,
      mediaType: submission.mediaType,
      mediaReference: submission.mediaReference,
      caption: submission.caption,
    });
  }

  return {
    month: params.month,
    entries,
    leftoverUsableCount: usable.length - assignedCount,
    excludedByConsentCount,
  };
}
