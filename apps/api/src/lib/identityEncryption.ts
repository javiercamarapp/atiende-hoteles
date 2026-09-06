// REQ-REC-011/REQ-SEG-014 · "documento del huésped cifrado en reposo con clave de
// env": AES-256-GCM (autenticado -- cualquier alteración del ciphertext/IV/tag se
// detecta al descifrar, nunca devuelve texto corrupto silenciosamente). NO se usa
// `pgcrypto` (decisión ya documentada en packages/db/migrations/0001_extensions_and_auth.sql:
// "portable entre PGlite y Postgres real, sin crear extensiones") -- el cifrado ocurre
// en código de aplicación, la base de datos solo almacena bytes opacos.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH_BYTES = 32;
const IV_LENGTH_BYTES = 12; // recomendado por NIST SP 800-38D para GCM.

export interface EncryptedField {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

/**
 * Lee `IDENTITY_VAULT_ENCRYPTION_KEY` del entorno (32 bytes en hex = 64 caracteres).
 * Mismo criterio que `JWT_SECRET` en env.ts: SIN default silencioso en producción; un
 * default explícitamente marcado "solo desarrollo" fuera de producción para no
 * bloquear `npm test`/`npm run dev` sin configuración adicional.
 */
export function loadIdentityVaultEncryptionKey(source: NodeJS.ProcessEnv = process.env): Buffer {
  const isProd = (source.NODE_ENV ?? "development") === "production";
  const raw = source.IDENTITY_VAULT_ENCRYPTION_KEY ?? (isProd ? undefined : DEV_ONLY_KEY_HEX);

  if (!raw) {
    throw new Error(
      "IDENTITY_VAULT_ENCRYPTION_KEY no está configurado. En producción es obligatorio " +
        "(REQ-REC-011/REQ-SEG-014): no existe un valor por defecto silencioso.",
    );
  }
  const key = Buffer.from(raw, "hex");
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new Error(`IDENTITY_VAULT_ENCRYPTION_KEY inválida: se esperaban ${KEY_LENGTH_BYTES} bytes en hex (${KEY_LENGTH_BYTES * 2} caracteres), se recibieron ${key.length}.`);
  }
  return key;
}

// Clave FIJA solo para desarrollo/pruebas -- nunca usar contra datos reales, mismo
// criterio documentado que `DEV_ONLY_JWT_SECRET` en env.ts.
const DEV_ONLY_KEY_HEX = "0".repeat(63) + "1"; // 64 hex chars = 32 bytes, obviamente no aleatoria.

export function encryptIdentityField(plaintext: string, key: Buffer): EncryptedField {
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, iv, authTag };
}

export function decryptIdentityField(encrypted: EncryptedField, key: Buffer): string {
  const decipher = createDecipheriv(ALGORITHM, key, encrypted.iv);
  decipher.setAuthTag(encrypted.authTag);
  const plaintext = Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}
