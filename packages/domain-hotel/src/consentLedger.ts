// REQ-HUE-024: "El sistema debe registrar y consultar un consent ledger multi-país
// antes de cualquier comunicación outbound de marketing/upsell." (BP-155, H09-029).
//
// El registro de consentimiento en sí (tabla `consent`, función SECURITY DEFINER
// `record_consent()`) ya existe desde REQ-SEG-002/REQ-HUE-021/REQ-SEG-007
// (packages/db/migrations/0068_consentimiento_y_arco.sql) y el bloqueo de envío de
// plantillas de marketing sin consentimiento vigente ya existe
// (`isMarketingSendBlocked`, packages/agent-core/src/tools/messagingTools.ts) -- ese
// enforcement NO se toca aquí, sigue siendo la única puerta real de envío.
//
// El gap real que este módulo cierra (docs/REQUISITOS.md fila REQ-HUE-024, dependencia
// externa "ninguna"): un `grep` de `record_consent(` en todo `apps/` confirma que la
// ÚNICA ruta que lo invoca es `checkinOnline.ts`, y solo para `consent_kind =
// 'tratamiento_datos'` -- no existe ninguna ruta real para registrar un consentimiento
// de MARKETING; los tests que ejercitan el gate de marketing (opt-in-marketing.spec.ts)
// insertan la fila `consent` directo con el cliente admin, un atajo de prueba que no
// existe como camino de producción. Y "multi-país" no existía en ninguna parte: la
// tabla trata todo consentimiento igual, sin ninguna noción de jurisdicción para poder
// auditar/reportar por país (ni una tabla de reporte, ni una columna, ni una función).
//
// Este módulo agrega la pieza de dominio pura que le falta a ambos huecos: deriva la
// jurisdicción de un consentimiento a partir del teléfono E.164 del huésped -- sin
// tabla nueva, sin dependencia externa, sin geolocalización de terceros: el teléfono ya
// vive en `guest.phone` -- y expone las funciones que
// `apps/api/src/routes/consentimiento.ts` usa para registrar (nueva ruta) y para
// agrupar/filtrar el ledger por jurisdicción al consultarlo.
import { z } from "zod";

/**
 * Jurisdicciones reconocidas por prefijo de código de país E.164: México primero (mercado
 * actual del producto), EE. UU./Canadá y España (expansión ya documentada en
 * H06/H21/BP-146..151), un puñado de mercados hispanohablantes adicionales, y dos
 * cajones honestos para todo lo demás -- "OTRA" (prefijo E.164 válido pero no
 * catalogado) y "DESCONOCIDA" (sin teléfono o formato no reconocible). Ningún
 * consentimiento se descarta ni se deja de registrar por no poder clasificar su
 * jurisdicción; se reporta honestamente en vez de adivinar.
 */
export const CONSENT_JURISDICTIONS = ["MX", "US_CA", "ES", "CO", "AR", "BR", "OTRA", "DESCONOCIDA"] as const;
export type ConsentJurisdiction = (typeof CONSENT_JURISDICTIONS)[number];

// Prefijos ordenados de más específico a menos específico donde hace falta (ninguno de
// estos colisiona por ser prefijo de otro en esta lista, pero el orden se conserva por
// claridad si se agrega uno nuevo más adelante, p. ej. un +1-xxx de un territorio
// separado).
const COUNTRY_CODE_PREFIXES: ReadonlyArray<{ prefix: string; jurisdiction: ConsentJurisdiction }> = [
  { prefix: "+52", jurisdiction: "MX" },
  { prefix: "+1", jurisdiction: "US_CA" },
  { prefix: "+34", jurisdiction: "ES" },
  { prefix: "+57", jurisdiction: "CO" },
  { prefix: "+54", jurisdiction: "AR" },
  { prefix: "+55", jurisdiction: "BR" },
];

/** Normaliza a E.164 mínimo (mismo criterio laxo que el resto del repo usa para
 *  teléfono de huésped -- no valida longitud/operador exacto por país, eso es un
 *  problema de telefonía real fuera de alcance sin credenciales, ver REQ-HUE-001/011):
 *  agrega "+" si falta y quita espacios/paréntesis/guiones. */
function normalizePhone(phone: string): string {
  const trimmed = phone.trim().replace(/[\s()-]/g, "");
  return trimmed.startsWith("+") ? trimmed : `+${trimmed}`;
}

/**
 * Deriva la jurisdicción de un teléfono de huésped a partir de su prefijo de país
 * E.164 -- puro, sin I/O, cero dependencia externa nueva (no llama a ningún servicio de
 * geolocalización). Vacío/`null`/formato no reconocible → "DESCONOCIDA"; prefijo válido
 * pero no catalogado → "OTRA".
 */
export function resolveConsentJurisdiction(phone: string | null | undefined): ConsentJurisdiction {
  if (!phone || phone.trim().length === 0) return "DESCONOCIDA";
  const normalized = normalizePhone(phone);
  if (!/^\+\d{6,15}$/.test(normalized)) return "DESCONOCIDA";
  for (const { prefix, jurisdiction } of COUNTRY_CODE_PREFIXES) {
    if (normalized.startsWith(prefix)) return jurisdiction;
  }
  return "OTRA";
}

export const consentKindSchema = z.enum(["tratamiento_datos", "marketing"]);
export const consentChannelSchema = z.enum(["checkin_online", "whatsapp", "web", "presencial"]);
export type ConsentKind = z.infer<typeof consentKindSchema>;
export type ConsentChannel = z.infer<typeof consentChannelSchema>;

export interface ConsentLedgerRow {
  id: string;
  guestId: string | null;
  guestPhone: string | null;
  channel: ConsentChannel;
  consentKind: ConsentKind;
  avisoVersion: string;
  granted: boolean;
  createdAt: string;
}

export interface ConsentLedgerEntry extends ConsentLedgerRow {
  jurisdiction: ConsentJurisdiction;
}

/** Enriquece cada fila del ledger con su jurisdicción derivada -- puro, se aplica
 *  después de leer `consent` (join con `guest.phone`) sin tocar el esquema existente. */
export function annotateConsentLedger(rows: readonly ConsentLedgerRow[]): ConsentLedgerEntry[] {
  return rows.map((row) => ({ ...row, jurisdiction: resolveConsentJurisdiction(row.guestPhone) }));
}

/** Filtra el ledger ya anotado por jurisdicción y/o tipo de consentimiento -- ambos
 *  opcionales, `undefined` no filtra por ese criterio. */
export function filterConsentLedger(
  entries: readonly ConsentLedgerEntry[],
  filter: { jurisdiction?: ConsentJurisdiction; consentKind?: ConsentKind } = {},
): ConsentLedgerEntry[] {
  return entries.filter(
    (entry) =>
      (filter.jurisdiction === undefined || entry.jurisdiction === filter.jurisdiction) &&
      (filter.consentKind === undefined || entry.consentKind === filter.consentKind),
  );
}

export interface ConsentLedgerSummaryBucket {
  jurisdiction: ConsentJurisdiction;
  consentKind: ConsentKind;
  granted: number;
  revoked: number;
}

/**
 * Agrupa el ledger anotado por (jurisdicción, tipo de consentimiento) contando
 * otorgados vs. revocados -- el reporte de cumplimiento que REQ-HUE-024 pide poder
 * "consultar": cuántos huéspedes de qué país tienen marketing vigente hoy, sin leer
 * fila por fila. Nota: un mismo guest puede tener varias filas históricas (otorgar,
 * luego revocar); este resumen cuenta FILAS del ledger, no huéspedes únicos -- para el
 * estado vigente de un huésped puntual se usa la fila más reciente, como ya hace
 * `isMarketingSendBlocked`.
 */
export function summarizeConsentLedger(entries: readonly ConsentLedgerEntry[]): ConsentLedgerSummaryBucket[] {
  const buckets = new Map<string, ConsentLedgerSummaryBucket>();
  for (const entry of entries) {
    const key = `${entry.jurisdiction}::${entry.consentKind}`;
    const bucket = buckets.get(key) ?? {
      jurisdiction: entry.jurisdiction,
      consentKind: entry.consentKind,
      granted: 0,
      revoked: 0,
    };
    if (entry.granted) bucket.granted += 1;
    else bucket.revoked += 1;
    buckets.set(key, bucket);
  }
  return Array.from(buckets.values()).sort(
    (a, b) => a.jurisdiction.localeCompare(b.jurisdiction) || a.consentKind.localeCompare(b.consentKind),
  );
}
