/**
 * Chequeo honesto de credenciales/hardware por variable de entorno, compartido por todos
 * los adaptadores reales de packages/mcp-servers/*. Un adaptador real construye SIEMPRE
 * este chequeo primero: si falta algo, `status()` reporta `unavailable` con la razón
 * exacta (qué variable falta) y ningún método hace una llamada de red real ni fabrica una
 * respuesta -- ver docs/ARQUITECTURA.md ADR-007/ADR-011.
 */

export interface CredentialCheck {
  available: boolean;
  missing: string[];
}

/** Verifica que todas las variables de entorno en `names` estén definidas y no vacías. */
export function checkEnvCredentials(names: readonly string[]): CredentialCheck {
  const missing = names.filter((name) => {
    const value = process.env[name];
    return value === undefined || value.trim() === "";
  });
  return { available: missing.length === 0, missing };
}

/** Estado uniforme que cada adaptador (real o simulado) expone via `status()`. */
export interface AdapterStatus {
  /** Nombre corto del proveedor, p.ej. "cloudbeds", "meta-whatsapp". */
  provider: string;
  /** `true` solo en adaptadores Fake/Simulated, o en un adaptador real con credenciales verificadas. */
  available: boolean;
  /** `true` en adaptadores Fake/Simulated -- NUNCA en un adaptador que hable con el proveedor real. */
  simulated: boolean;
  /** Razón legible por humanos cuando `available` es `false` (p.ej. "[PENDIENTE DE CREDENCIALES] falta CLOUDBEDS_API_KEY"). */
  reason?: string;
}
