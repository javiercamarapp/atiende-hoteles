// REQ-RES-021 · Emisión/verificación de API keys de agentes MCP externos. Mismo
// criterio de secreto que cualquier otro de este repo (webhooks HMAC,
// `@atiende-hoteles/mcp-shared`): SOLO se persiste el hash, la key en claro se muestra
// una única vez al crearla (`apps/api/src/routes/mcpAgentes.ts`) y nunca se puede
// recuperar después -- perderla implica revocar y emitir una nueva.
import { createHash, randomBytes } from "node:crypto";

const API_KEY_PREFIX = "mcp_live_";

/** 32 bytes de entropía de `node:crypto` (nunca `Math.random()`), codificados
 *  base64url para que viajen limpios en un header `Authorization: Bearer`. */
export function generateMcpAgentApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** sha256 hex -- lo único que `mcp_agent_credential.api_key_hash` (migración 0130)
 *  almacena o que viaja como parámetro a las funciones `SECURITY DEFINER` de SQL. */
export function hashMcpAgentApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey, "utf8").digest("hex");
}

/** Extrae la API key de un header `Authorization: Bearer <key>`. `null` si el header
 *  falta o no tiene el esquema esperado -- el llamador decide cómo responder (401). */
export function extractBearerApiKey(authorizationHeader: string | undefined | null): string | null {
  if (!authorizationHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  return match?.[1]?.trim() || null;
}
