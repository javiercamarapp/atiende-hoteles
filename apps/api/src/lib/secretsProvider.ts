// REQ-SEG-013 (GOB-041) · Provider de secretos: variables de entorno en desarrollo/
// test y, en producción, una capa REAL y opcional de Vault/KMS.
//
// Estado real de este requisito (ver docs/REQUISITOS.md / docs/logs/REQ-SEG-013/):
//   - La mitad "variables de entorno" YA estaba resuelta antes de este archivo:
//     `apps/api/src/env.ts` (JWT_SECRET, CORS_ALLOWED_ORIGINS) y
//     `apps/api/src/lib/identityEncryption.ts` (IDENTITY_VAULT_ENCRYPTION_KEY) leen
//     `process.env` sin ningún default silencioso para un secreto real en
//     producción -- ausencia = arranque falla explícito, nunca un valor inventado.
//   - La mitad "Vault/KMS en producción" NO existía en ningún lugar del repo antes
//     de este archivo. Este módulo la agrega como capa REAL (protocolo genuino de la
//     API HTTP de HashiCorp Vault KV v2), pero es 100% OPCIONAL/opt-in
//     (`SECRETS_BACKEND=vault`) para no cambiar el comportamiento de nada que ya
//     funciona: sin esa variable, el arranque es exactamente el de siempre (lee
//     `process.env` directo, cero llamadas de red, cero dependencia nueva).
//   - Brecha que sigue abierta y NO se inventa aquí: este repo nunca ha tenido una
//     instancia de Vault/KMS desplegada ni credenciales de ese servicio (no existe
//     forma honesta de probar `VaultSecretsProvider` de extremo a extremo sin esa
//     infraestructura real). Los tests de este archivo verifican el PROTOCOLO (URL,
//     cabecera `X-Vault-Token`, forma de la respuesta KV v2, fail-closed) contra un
//     `fetch` sustituido -- nunca contra un Vault real. Adoptar esto en producción
//     de verdad sigue "pendiente-credenciales/infraestructura real".
//
// Diseño:
//   - `bootstrapProductionSecrets()` es el único punto de entrada real, llamado una
//     vez al arrancar el proceso (`apps/api/src/server.ts`, ANTES de `loadEnv()`).
//   - Si `SECRETS_BACKEND` no está definido o vale "env": no-op inmediato. Ningún
//     otro archivo del repo (env.ts, identityEncryption.ts, moneyAlert.ts, etc.)
//     necesita cambiar -- siguen leyendo `process.env` exactamente igual que hoy.
//   - Si vale "vault": exige `VAULT_ADDR` + `VAULT_TOKEN` + `VAULT_SECRET_PATH`
//     (`VAULT_KV_MOUNT`, default "secret"). Si falta cualquiera de las tres
//     obligatorias, lanza de inmediato (fail-closed): declarar `SECRETS_BACKEND=vault`
//     y no completar su configuración NUNCA cae en silencio de vuelta a variables de
//     entorno planas -- eso simularía tener Vault sin tenerlo de verdad. Si la
//     configuración está completa, lee TODAS las claves del secreto KV v2 declarado
//     y las copia a `process.env` (sobrescribe cualquier valor plano previo -- una
//     vez activado, Vault es la fuente de verdad) antes de que el resto del proceso
//     lea `process.env`.
//   - Cualquier otro valor de `SECRETS_BACKEND` -> error explícito (catálogo cerrado
//     de dos backends; nunca "hace algo genérico" con un valor desconocido).

export type SecretsBackend = "env" | "vault";

const VALID_BACKENDS: readonly SecretsBackend[] = ["env", "vault"];

/** Error de configuración del provider de secretos -- SIEMPRE fail-closed: nunca se
 *  atrapa para continuar con un valor por defecto, debe propagarse y detener el
 *  arranque del proceso. */
export class SecretsConfigError extends Error {}

export interface VaultConfig {
  addr: string;
  token: string;
  secretPath: string;
  kvMount: string;
}

function readBackend(source: NodeJS.ProcessEnv): SecretsBackend {
  const raw = source.SECRETS_BACKEND?.trim();
  if (!raw || raw === "env") return "env";
  if ((VALID_BACKENDS as string[]).includes(raw)) return raw as SecretsBackend;
  throw new SecretsConfigError(
    `SECRETS_BACKEND="${raw}" no es un backend válido (catálogo cerrado: ${VALID_BACKENDS.join(", ")}). ` +
      "REQ-SEG-013: un valor desconocido nunca se trata como \"env\" en silencio.",
  );
}

function readVaultConfig(source: NodeJS.ProcessEnv): VaultConfig {
  const addr = source.VAULT_ADDR?.trim();
  const token = source.VAULT_TOKEN?.trim();
  const secretPath = source.VAULT_SECRET_PATH?.trim();
  const kvMount = source.VAULT_KV_MOUNT?.trim() || "secret";

  const missing: string[] = [];
  if (!addr) missing.push("VAULT_ADDR");
  if (!token) missing.push("VAULT_TOKEN");
  if (!secretPath) missing.push("VAULT_SECRET_PATH");
  if (missing.length > 0) {
    throw new SecretsConfigError(
      `SECRETS_BACKEND=vault pero falta configuración obligatoria: ${missing.join(", ")}. ` +
        "REQ-SEG-013 (fail-closed): declarar Vault como backend y no completar su configuración " +
        "nunca cae en silencio de vuelta a variables de entorno planas.",
    );
  }
  return { addr: addr!, token: token!, secretPath: secretPath!, kvMount };
}

/** Forma real de la respuesta de Vault KV v2:
 *  `GET {addr}/v1/{mount}/data/{path}` -> `{ data: { data: { CLAVE: "valor", ... } } }`
 *  (https://developer.hashicorp.com/vault/api-docs/secret/kv/kv-v2#read-secret-version). */
interface VaultKvV2Response {
  data?: { data?: Record<string, string> } | null;
}

/**
 * Lee TODAS las claves de un secreto KV v2 de un Vault real vía su API HTTP
 * documentada. No envuelve errores de red/HTTP/forma de respuesta en un valor por
 * defecto: cualquier fallo se propaga (fail-closed) -- un Vault inalcanzable, un
 * token inválido o un secreto vacío/inexistente detienen el arranque, nunca
 * continúan con secretos parciales o ausentes en silencio.
 */
export async function fetchVaultSecrets(config: VaultConfig, fetchImpl: typeof fetch = fetch): Promise<Record<string, string>> {
  const url = `${config.addr.replace(/\/+$/, "")}/v1/${config.kvMount}/data/${config.secretPath}`;
  let res: Response;
  try {
    res = await fetchImpl(url, { method: "GET", headers: { "X-Vault-Token": config.token } });
  } catch (err) {
    throw new SecretsConfigError(
      `No se pudo contactar a Vault en ${config.addr} (${err instanceof Error ? err.message : String(err)}). ` +
        "REQ-SEG-013 (fail-closed): el arranque se detiene, nunca continúa sin los secretos reales.",
    );
  }
  if (!res.ok) {
    throw new SecretsConfigError(
      `Vault respondió ${res.status} ${res.statusText} al leer ${config.kvMount}/${config.secretPath}. ` +
        "REQ-SEG-013 (fail-closed): el arranque se detiene, nunca continúa sin los secretos reales.",
    );
  }
  const body = (await res.json()) as VaultKvV2Response;
  const data = body.data?.data;
  if (!data || Object.keys(data).length === 0) {
    throw new SecretsConfigError(
      `Vault respondió 200 pero sin datos utilizables en ${config.kvMount}/${config.secretPath} ` +
        "(¿ruta KV v2 correcta? ¿existe el secreto? ¿está vacío?). REQ-SEG-013 (fail-closed).",
    );
  }
  return data;
}

export interface BootstrapResult {
  backend: SecretsBackend;
  /** Claves copiadas a `target` -- nunca los valores (no se loguean secretos). */
  keysLoaded: string[];
}

/**
 * Punto de entrada real: llamar UNA vez al arrancar el proceso, antes de
 * `loadEnv()` (ver `apps/api/src/server.ts`). Sin `SECRETS_BACKEND=vault` es un
 * no-op exacto (0 llamadas de red, 0 cambio de comportamiento respecto al código
 * anterior a este archivo).
 */
export async function bootstrapProductionSecrets(
  source: NodeJS.ProcessEnv = process.env,
  target: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<BootstrapResult> {
  const backend = readBackend(source);
  if (backend === "env") {
    return { backend, keysLoaded: [] };
  }
  const config = readVaultConfig(source);
  const secrets = await fetchVaultSecrets(config, fetchImpl);
  const keysLoaded = Object.keys(secrets);
  for (const key of keysLoaded) {
    target[key] = secrets[key];
  }
  return { backend, keysLoaded };
}
