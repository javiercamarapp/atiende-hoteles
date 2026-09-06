// H2 · Hash de contraseñas para `staff_user.password_hash` (ADR-004: login por
// email/contraseña). Se usa `scrypt` de `node:crypto` (nativo, sin dependencia nueva)
// en vez de argon2id porque este monorepo evita paquetes nativos adicionales que
// requieran compilación (ninguno de los binarios de sistema de docs/BLOQUEOS.md B-002
// está disponible para verificarlo). `scrypt` con N=16384 (2^14), r=8, p=1 es el
// mismo perfil de costo que recomienda OWASP para scrypt cuando argon2id no está
// disponible.
//
// Formato almacenado: `scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>` — versionado a
// propósito para poder subir el costo en el futuro sin invalidar hashes viejos
// (se compara con los parámetros guardados en el propio hash, no con los actuales).

import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";

function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

const DEFAULT_N = 16384;
const DEFAULT_R = 8;
const DEFAULT_P = 1;
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH, {
    N: DEFAULT_N,
    r: DEFAULT_R,
    p: DEFAULT_P,
  });
  return `scrypt$${DEFAULT_N}$${DEFAULT_R}$${DEFAULT_P}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4] as string, "hex");
  const expected = Buffer.from(parts[5] as string, "hex");

  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p) || salt.length === 0 || expected.length === 0) {
    return false;
  }

  const derived = await scrypt(password, salt, expected.length, { N: n, r, p });
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}
