// REQ-REC-011/REQ-SEG-014: cifrado en reposo (AES-256-GCM) del número de documento de
// identidad, con clave de entorno.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptIdentityField, encryptIdentityField, loadIdentityVaultEncryptionKey } from "../../../apps/api/src/lib/identityEncryption.ts";

describe("encryptIdentityField / decryptIdentityField", () => {
  const key = randomBytes(32);

  it("descifra exactamente el texto original", () => {
    const encrypted = encryptIdentityField("G1234567", key);
    expect(decryptIdentityField(encrypted, key)).toBe("G1234567");
  });

  it("el ciphertext NUNCA contiene el texto plano como subcadena", () => {
    const plaintext = "PASSPORTNUMBER123";
    const encrypted = encryptIdentityField(plaintext, key);
    expect(encrypted.ciphertext.toString("latin1")).not.toContain(plaintext);
    expect(encrypted.ciphertext.toString("hex")).not.toContain(Buffer.from(plaintext).toString("hex"));
  });

  it("dos cifrados del mismo texto producen ciphertext distinto (IV aleatorio)", () => {
    const a = encryptIdentityField("G1234567", key);
    const b = encryptIdentityField("G1234567", key);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.iv.equals(b.iv)).toBe(false);
  });

  it("un ciphertext alterado (1 byte) falla al descifrar (autenticado, GCM detecta manipulación)", () => {
    const encrypted = encryptIdentityField("G1234567", key);
    const alterado = Buffer.from(encrypted.ciphertext);
    alterado[0] = alterado[0]! ^ 0xff;
    expect(() => decryptIdentityField({ ...encrypted, ciphertext: alterado }, key)).toThrow();
  });

  it("descifrar con la clave equivocada falla (nunca devuelve texto corrupto silenciosamente)", () => {
    const encrypted = encryptIdentityField("G1234567", key);
    const otraClave = randomBytes(32);
    expect(() => decryptIdentityField(encrypted, otraClave)).toThrow();
  });
});

describe("loadIdentityVaultEncryptionKey", () => {
  it("usa un default SOLO fuera de producción", () => {
    const key = loadIdentityVaultEncryptionKey({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    expect(key).toHaveLength(32);
  });

  it("en producción, sin la variable configurada, lanza sin default silencioso", () => {
    expect(() => loadIdentityVaultEncryptionKey({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(
      /IDENTITY_VAULT_ENCRYPTION_KEY no está configurado/,
    );
  });

  it("rechaza una clave de longitud incorrecta", () => {
    expect(() =>
      loadIdentityVaultEncryptionKey({ NODE_ENV: "test", IDENTITY_VAULT_ENCRYPTION_KEY: "abcd" } as NodeJS.ProcessEnv),
    ).toThrow(/IDENTITY_VAULT_ENCRYPTION_KEY inválida/);
  });
});
