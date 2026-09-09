/**
 * REQ-HUE-023 (P0/SEG), mitad "cambio de contacto exige OTP al canal original": un
 * huésped que pide cambiar su teléfono o correo registrado debe verificarse con un
 * código de un solo uso (OTP) enviado al canal YA REGISTRADO antes del cambio -- nunca
 * al valor nuevo que se está solicitando (eso permitiría que quien ya comprometió/
 * adivinó el nuevo contacto se autoverifique). `apps/api/src/routes/huespedes.ts`
 * congela `guest.phone` (el canal original) en `guest_contact_change_request.otp_sent_to_phone`
 * AL CREAR la solicitud, y siempre envía el OTP ahí -- nunca acepta un destino distinto
 * en el cuerpo de la petición (defensa estructural, no solo de este módulo).
 *
 * Módulo de dominio PURO (mismo principio que `voiceGuardrails.ts`): sin I/O, sin
 * reloj real (`now` siempre se recibe como parámetro), sin hashing real aquí -- el hash/
 * verificación del código en sí reutiliza `hashPassword`/`verifyPassword` de
 * `@atiende-hoteles/db` (mismo perfil scrypt que las contraseñas de staff, sin
 * inventar un segundo esquema de hashing en este repo) desde la capa de ruta; este
 * módulo decide el RESULTADO de una confirmación ya verificada bit a bit por esa capa,
 * y genera el código en sí.
 */

import { randomInt } from "node:crypto";

export const OTP_CODE_LENGTH = 6;
export const OTP_TTL_MINUTES = 10;
export const OTP_MAX_ATTEMPTS = 5;

/** Código numérico de `OTP_CODE_LENGTH` dígitos (con ceros a la izquierda), generado
 *  con `crypto.randomInt` (CSPRNG, no `Math.random`). `randomIntFn` es inyectable para
 *  pruebas deterministas -- nunca se usa `Math.random()` en este módulo. */
export function generateOtpCode(randomIntFn: (min: number, max: number) => number = randomInt): string {
  const max = 10 ** OTP_CODE_LENGTH;
  const value = randomIntFn(0, max);
  return String(value).padStart(OTP_CODE_LENGTH, "0");
}

export type OtpConfirmationOutcome =
  | "aceptado"
  | "rechazado_codigo_incorrecto"
  | "rechazado_expirado"
  | "rechazado_ya_confirmado"
  | "rechazado_intentos_agotados";

export interface EvaluateOtpConfirmationInput {
  /** Estado actual de la fila `guest_contact_change_request` antes de este intento. */
  readonly status: "pendiente" | "confirmado" | "rechazado_expirado" | "rechazado_intentos_agotados" | "cancelado";
  readonly expiresAt: Date;
  readonly now: Date;
  readonly attemptsBefore: number;
  readonly maxAttempts: number;
  /** Resultado de `verifyPassword(codigoIngresado, otp_code_hash)` -- ya calculado por
   *  la capa de ruta (timing-safe, scrypt); este módulo nunca compara códigos en texto
   *  plano directamente. */
  readonly codeMatches: boolean;
}

export interface EvaluateOtpConfirmationResult {
  readonly outcome: OtpConfirmationOutcome;
  /** `true` cuando el cambio de contacto debe aplicarse (UPDATE de `guest.email`/
   *  `guest.phone`) como parte de la MISMA transacción que registra este resultado. */
  readonly applyChange: boolean;
  /** Nuevo `status` a persistir en `guest_contact_change_request`. */
  readonly nextStatus: EvaluateOtpConfirmationInput["status"];
  /** Nuevo valor de `attempts` a persistir -- igual a `attemptsBefore` cuando este
   *  intento ni siquiera llegó a comparar el código (solicitud ya cerrada, o ya
   *  expirada/agotada de una llamada anterior), incrementado en 1 solo cuando SÍ se
   *  comparó el código de este intento (haya acertado o no). El llamador (capa de
   *  ruta) persiste este valor tal cual, sin volver a decidir cuándo incrementar. */
  readonly attemptsAfter: number;
}

/** Decide el resultado de UN intento de confirmación de OTP, dado el estado ya cargado
 *  de la solicitud. Puro: no consulta la base ni el reloj, todo llega por parámetro --
 *  así la misma decisión es 100% reproducible en pruebas unitarias sin PGlite.
 *
 *  Orden de verificación (fail-closed, la primera condición que aplique gana):
 *  1. Una solicitud que ya NO está `pendiente` (ya confirmada/expirada/cancelada/
 *     agotada) nunca se reevalúa -- evita que un código correcto reabra una solicitud
 *     ya cerrada por cualquier motivo.
 *  2. Expiración por tiempo (`now >= expiresAt`) SIEMPRE se revisa antes que el código,
 *     incluso si el código es correcto -- un OTP vencido nunca es válido aunque alguien
 *     lo haya adivinado o interceptado después de la ventana.
 *  3. Intentos agotados (`attemptsBefore >= maxAttempts`) antes de evaluar el código de
 *     ESTE intento -- el intento número `maxAttempts + 1` ni siquiera compara el código.
 *  4. Código incorrecto: se rechaza, la solicitud SIGUE `pendiente` (el llamador debe
 *     incrementar `attempts` en la fila) para permitir reintentos hasta el máximo.
 *  5. Código correcto: única rama que aplica el cambio. */
export function evaluateOtpConfirmation(input: EvaluateOtpConfirmationInput): EvaluateOtpConfirmationResult {
  if (input.status !== "pendiente") {
    return { outcome: "rechazado_ya_confirmado", applyChange: false, nextStatus: input.status, attemptsAfter: input.attemptsBefore };
  }
  if (input.now.getTime() >= input.expiresAt.getTime()) {
    return { outcome: "rechazado_expirado", applyChange: false, nextStatus: "rechazado_expirado", attemptsAfter: input.attemptsBefore };
  }
  if (input.attemptsBefore >= input.maxAttempts) {
    return {
      outcome: "rechazado_intentos_agotados",
      applyChange: false,
      nextStatus: "rechazado_intentos_agotados",
      attemptsAfter: input.attemptsBefore,
    };
  }
  if (!input.codeMatches) {
    const attemptsAfter = input.attemptsBefore + 1;
    const agotado = attemptsAfter >= input.maxAttempts;
    return {
      outcome: agotado ? "rechazado_intentos_agotados" : "rechazado_codigo_incorrecto",
      applyChange: false,
      nextStatus: agotado ? "rechazado_intentos_agotados" : "pendiente",
      attemptsAfter,
    };
  }
  return { outcome: "aceptado", applyChange: true, nextStatus: "confirmado", attemptsAfter: input.attemptsBefore };
}
