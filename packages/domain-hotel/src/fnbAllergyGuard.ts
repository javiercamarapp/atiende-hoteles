/**
 * REQ-AB-004 (P0/GOB): "Cuando el huésped declare alergia/restricción alimentaria en
 * un pedido de F&B, la orden debe marcarse explícitamente y requerir confirmación
 * humana del cocinero antes de que el sistema asegure al huésped que el platillo es
 * seguro; sin confirmación, el sistema no debe afirmarlo." Módulo de dominio PURO
 * (mismo principio que `checkinFreeTextGuard.ts`/`paymentFreeTextGuard.ts`): ninguna
 * función de aquí toca I/O -- `apps/api/src/routes/pedidosFnb.ts` es quien persiste el
 * estado y decide cuándo invocar la guarda antes de responder al huésped.
 *
 * Dos responsabilidades:
 *   1. Detección defensiva (fail-closed) de una declaración de alergia/restricción en
 *      texto libre (notas del pedido), para el caso en que el huésped no marcó el
 *      campo estructurado pero SÍ lo escribió -- igual que `looksLikeCheckinDataInFreeText`,
 *      si hay duda razonable se trata como declarado, nunca al revés.
 *   2. La guarda central: dado el estado de confirmación de un pedido, decide si es
 *      seguro afirmarle al huésped que el platillo no representa riesgo. Es la ÚNICA
 *      función que cualquier capa (ruta HTTP hoy, mensajería/agente en el futuro) debe
 *      llamar antes de emitir esa afirmación -- si no truena, es seguro afirmar.
 */

// Palabras/frases que indican una alergia o restricción alimentaria declarada por el
// huésped en texto libre. Deliberadamente amplio (alergia, intolerancia, enfermedad
// celiaca, anafilaxia, "no puedo comer X", "sin gluten/lácteos/nueces por salud") --
// un falso positivo aquí solo cuesta pedir una confirmación de más al cocinero; un
// falso negativo deja pasar un pedido con riesgo real sin marcar. Fail-closed.
// Se aplica SOBRE TEXTO SIN ACENTOS (ver `stripDiacritics`) para reconocer por igual
// "alérgico"/"alergico" y "célíaco"/"celiaco" -- un huésped escribiendo desde el
// teclado de un celular omite acentos con la misma frecuencia con la que los pone.
const ALLERGY_KEYWORDS_RE =
  /\b(alerg\w*|intoleran\w*|celiac\w*|anafilax\w*|hipersensibilidad|no\s+puedo\s+comer|restriccion(?:es)?\s+alimentari\w*)\b/i;

function stripDiacritics(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

/** true si `text` PARECE declarar una alergia/restricción alimentaria. */
export function looksLikeAllergyDeclaration(text: string | null | undefined): boolean {
  if (!text) return false;
  return ALLERGY_KEYWORDS_RE.test(stripDiacritics(text));
}

export type AllergyDeclaredVia = "estructurado" | "texto_libre";

export interface ResolveAllergyDeclaredInput {
  /** Campo estructurado del formulario/API ("¿el huésped declaró alergia?"). */
  readonly structuredFlag: boolean;
  /** Notas de texto libre del pedido (notas generales + notas por platillo) a
   *  inspeccionar defensivamente cuando el campo estructurado viene en `false`. */
  readonly freeTextFields: ReadonlyArray<string | null | undefined>;
}

export interface ResolveAllergyDeclaredResult {
  readonly allergyDeclared: boolean;
  /** De dónde se detectó -- `null` cuando no se declaró. Se persiste para auditoría:
   *  saber si la detección vino del campo explícito o de la red de seguridad de texto
   *  libre importa para revisar la calidad de la detección con el tiempo. */
  readonly declaredVia: AllergyDeclaredVia | null;
}

/** Determina si un pedido debe tratarse como "con alergia/restricción declarada" --
 *  ya sea porque el campo estructurado lo dice, o porque alguna nota de texto libre
 *  PARECE declararlo. */
export function resolveAllergyDeclared(input: ResolveAllergyDeclaredInput): ResolveAllergyDeclaredResult {
  if (input.structuredFlag) return { allergyDeclared: true, declaredVia: "estructurado" };
  const detected = input.freeTextFields.some((field) => looksLikeAllergyDeclaration(field));
  return detected ? { allergyDeclared: true, declaredVia: "texto_libre" } : { allergyDeclared: false, declaredVia: null };
}

export interface FnbOrderSafetyState {
  /** true si el pedido está marcado con alergia/restricción declarada. */
  readonly allergyDeclared: boolean;
  /** id del cocinero (rol `fnb`) que confirmó, o `null`/`undefined` si nadie ha
   *  confirmado todavía. */
  readonly kitchenConfirmedBy: string | null | undefined;
}

/** true si, dado el estado actual del pedido, el sistema PUEDE afirmar al huésped que
 *  el platillo es seguro. Sin alergia declarada no hay nada que confirmar (siempre
 *  `true`); con alergia declarada, únicamente tras confirmación humana del cocinero. */
export function canAssureDishIsSafe(order: FnbOrderSafetyState): boolean {
  if (!order.allergyDeclared) return true;
  return order.kitchenConfirmedBy != null;
}

export class AllergySafetyAssuranceBlockedError extends Error {
  code = "fnb_alergia_confirmacion_requerida";
  constructor() {
    super(
      "No se puede asegurar al huésped que el platillo es seguro: el pedido tiene una " +
        "alergia/restricción alimentaria declarada y todavía no tiene confirmación " +
        "humana del cocinero (REQ-AB-004).",
    );
    this.name = "AllergySafetyAssuranceBlockedError";
  }
}

/** Guarda central, fail-closed: lanza `AllergySafetyAssuranceBlockedError` si se
 *  intenta asegurar seguridad sin confirmación. Toda capa que vaya a afirmarle al
 *  huésped "el platillo es seguro" DEBE llamar esto primero -- si no truena, es seguro
 *  afirmar; si truena, el llamador NUNCA debe emitir la afirmación. */
export function assertCanAssureDishIsSafe(order: FnbOrderSafetyState): void {
  if (!canAssureDishIsSafe(order)) throw new AllergySafetyAssuranceBlockedError();
}

/** Texto listo para mostrar/enviar al huésped según el estado de confirmación --
 *  regla de dominio pura (sin I/O); la capa de mensajería/ruta decide cuándo enviarlo.
 *  El mensaje de "pendiente" NUNCA afirma que el platillo es seguro. */
export function describeSafetyAssuranceMessage(order: FnbOrderSafetyState): string {
  if (!order.allergyDeclared) return "Pedido recibido.";
  if (order.kitchenConfirmedBy == null) {
    return (
      "Registramos tu alergia/restricción alimentaria. Un cocinero debe confirmar el " +
      "platillo antes de poder darte una respuesta sobre su seguridad."
    );
  }
  return "Confirmado por el cocinero: el platillo es seguro para tu alergia/restricción declarada.";
}
