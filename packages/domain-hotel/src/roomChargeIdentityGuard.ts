/**
 * REQ-AB-012 (P1/NF): "...y verificar identidad doblemente al cargar a habitación."
 * Módulo de dominio PURO (mismo principio que `fnbAllergyGuard.ts`): ninguna función
 * de aquí toca I/O -- `apps/api/src/routes/folios.ts` (cargo en vivo) y
 * `apps/api/src/routes/fnbOfflineQueue.ts` (REQ-AB-003, reconciliación offline) son
 * quienes cargan los datos reales (folio -> reservation -> guest) y deciden cuándo
 * invocar la guarda antes de postear un cargo de A&B al folio del huésped.
 *
 * Contexto del riesgo: "cargar a habitación" (posteo de un consumo de F&B al folio sin
 * cobro con tarjeta presente) es el vector clásico de fuga/fraude en el punto de venta
 * de alimentos y bebidas -- alguien afirma "cárguelo al 304" sin ser huésped de esa
 * habitación, o el mesero anota mal el número. Ninguna tabla de este sistema modela
 * hoy la asignación real de una habitación física a una reserva (esa asignación vive
 * en el PMS externo, REQ-AB-002/013, pendiente-credenciales) -- por eso esta guarda NO
 * intenta verificar "el huésped está en la habitación X": verifica DOS factores de
 * identidad independientes que SÍ son datos propios del sistema (capturados al crear
 * al huésped, `packages/db/migrations/0005_guest.sql`): el apellido que el huésped
 * declara y los últimos 4 dígitos del teléfono en archivo. Dos reclamos independientes
 * cruzados contra el registro real de huésped es una verificación de identidad
 * genuina, aunque no sustituye una integración con el PMS.
 *
 * Fail-closed en dos frentes:
 *   1. Reclamo que NO coincide (nombre o teléfono) -> SIEMPRE bloqueado, sin
 *      excepción/override por este canal -- una discrepancia activa es evidencia de
 *      una identidad falsa, nunca un dato faltante que un administrador pueda
 *      "completar".
 *   2. Dato NO disponible para comparar (sin huésped en archivo, o huésped sin
 *      teléfono capturado) -> bloqueado por defecto, con una única válvula de escape:
 *      autorización explícita de un rol administrativo (owner/gm) YA VERIFICADO contra
 *      `hotel_staff` por el llamador (mismo patrón que
 *      `evaluateDiscountAuthorization`/`authorizedByAdminUserId` en `folioEngine.ts`)
 *      -- nunca un booleano que el cliente pueda simplemente mandar en `true`.
 */

function stripDiacritics(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

function normalizeName(text: string): string {
  return stripDiacritics(text).toLowerCase().trim().replace(/\s+/g, " ");
}

/** true si `statedSurname` aparece como palabra completa dentro de `fullNameOnFile`
 *  (nunca una subcadena parcial -- "ana" NO debe calzar con "susana"). */
export function surnameMatchesGuestName(statedSurname: string, fullNameOnFile: string): boolean {
  const stated = normalizeName(statedSurname);
  if (!stated) return false;
  const tokens = normalizeName(fullNameOnFile).split(" ").filter(Boolean);
  return tokens.includes(stated);
}

/** Últimos 4 dígitos numéricos de un teléfono en cualquier formato de captura
 *  (espacios/guiones/lada con o sin '+'). `null` si el valor no trae al menos 4
 *  dígitos -- nunca compara con una cadena vacía/parcial. */
function last4Digits(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/** true si los últimos 4 dígitos declarados coinciden EXACTO con los últimos 4
 *  dígitos del teléfono en archivo. */
export function phoneLast4Matches(statedLast4: string, phoneOnFile: string): boolean {
  const statedDigits = statedLast4.replace(/\D/g, "");
  if (statedDigits.length !== 4) return false;
  return last4Digits(phoneOnFile) === statedDigits;
}

export interface RoomChargeIdentityClaim {
  /** Apellido que el huésped declaró al mesero/recepción al pedir el cargo a
   *  habitación. */
  readonly statedSurname: string;
  /** Últimos 4 dígitos del teléfono que el huésped declaró (tal cual los dictó --
   *  esta guarda extrae los dígitos, el llamador no necesita normalizar). */
  readonly statedPhoneLast4: string;
}

export interface RoomChargeIdentityOnFile {
  /** Nombre completo del huésped de la reserva del folio, o `null` si la reserva no
   *  tiene huésped asociado (`reservation.guest_id is null`). */
  readonly guestFullName: string | null;
  /** Teléfono en archivo del huésped, o `null` si el huésped existe pero nunca
   *  capturó teléfono. Irrelevante si `guestFullName` ya es `null`. */
  readonly guestPhone: string | null;
}

export type RoomChargeIdentityBlockedReason =
  | "sin_huesped_en_archivo"
  | "sin_telefono_en_archivo"
  | "apellido_no_coincide"
  | "telefono_no_coincide";

export interface RoomChargeIdentityResult {
  readonly verified: boolean;
  /** true si `verified` se concedió por la válvula de escape administrativa (dato no
   *  disponible para comparar), nunca porque un reclamo activo haya coincidido. */
  readonly viaAdminOverride: boolean;
  readonly blockedReason: RoomChargeIdentityBlockedReason | null;
}

export interface EvaluateRoomChargeIdentityInput {
  readonly claim: RoomChargeIdentityClaim;
  readonly onFile: RoomChargeIdentityOnFile;
  /** YA VERIFICADO por el llamador (owner/gm de este hotel, contra `hotel_staff`) --
   *  esta función nunca resuelve identidad/rol, solo aplica la regla de negocio con la
   *  autorización ya confirmada (mismo contrato que `evaluateDiscountAuthorization`). */
  readonly overrideAuthorizedByAdmin: boolean;
}

/** Guarda central de REQ-AB-012: decide si un cargo "a habitación" puede postearse.
 *  Determinista, sin I/O -- ver comentario de módulo para la política fail-closed
 *  completa. */
export function evaluateRoomChargeIdentity(input: EvaluateRoomChargeIdentityInput): RoomChargeIdentityResult {
  const { claim, onFile, overrideAuthorizedByAdmin } = input;

  if (onFile.guestFullName == null) {
    if (overrideAuthorizedByAdmin) return { verified: true, viaAdminOverride: true, blockedReason: null };
    return { verified: false, viaAdminOverride: false, blockedReason: "sin_huesped_en_archivo" };
  }

  // Reclamo #1 (nombre): una discrepancia activa NUNCA es overridable por esta vía.
  if (!surnameMatchesGuestName(claim.statedSurname, onFile.guestFullName)) {
    return { verified: false, viaAdminOverride: false, blockedReason: "apellido_no_coincide" };
  }

  if (onFile.guestPhone == null) {
    if (overrideAuthorizedByAdmin) return { verified: true, viaAdminOverride: true, blockedReason: null };
    return { verified: false, viaAdminOverride: false, blockedReason: "sin_telefono_en_archivo" };
  }

  // Reclamo #2 (teléfono): misma regla -- discrepancia activa nunca overridable.
  if (!phoneLast4Matches(claim.statedPhoneLast4, onFile.guestPhone)) {
    return { verified: false, viaAdminOverride: false, blockedReason: "telefono_no_coincide" };
  }

  return { verified: true, viaAdminOverride: false, blockedReason: null };
}

const BLOCKED_REASON_MESSAGES: Record<RoomChargeIdentityBlockedReason, string> = {
  sin_huesped_en_archivo:
    "La reserva de este folio no tiene un huésped en archivo contra el cual verificar identidad; requiere autorización de un rol administrativo (owner/gm).",
  sin_telefono_en_archivo:
    "El huésped en archivo no tiene teléfono capturado para verificar el segundo factor; requiere autorización de un rol administrativo (owner/gm).",
  apellido_no_coincide: "El apellido declarado no coincide con el huésped en archivo para este folio.",
  telefono_no_coincide: "Los últimos 4 dígitos de teléfono declarados no coinciden con el huésped en archivo para este folio.",
};

export class RoomChargeIdentityBlockedError extends Error {
  code = "fnb_cargo_habitacion_identidad_no_verificada";
  reason: RoomChargeIdentityBlockedReason;
  constructor(reason: RoomChargeIdentityBlockedReason) {
    super(`No se puede postear el cargo a habitación (REQ-AB-012): ${BLOCKED_REASON_MESSAGES[reason]}`);
    this.name = "RoomChargeIdentityBlockedError";
    this.reason = reason;
  }
}

/** Fail-closed: lanza `RoomChargeIdentityBlockedError` si la verificación no pasa. Toda
 *  capa que vaya a postear un cargo de A&B "a habitación" (en vivo u offline
 *  reconciliado) DEBE llamar esto antes del INSERT -- si no truena, es seguro postear. */
export function assertRoomChargeIdentityVerified(input: EvaluateRoomChargeIdentityInput): RoomChargeIdentityResult {
  const result = evaluateRoomChargeIdentity(input);
  if (!result.verified) throw new RoomChargeIdentityBlockedError(result.blockedReason!);
  return result;
}
