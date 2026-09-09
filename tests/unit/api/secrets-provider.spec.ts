// REQ-SEG-013 (GOB-041) · provider de secretos: variables de entorno (backend "env",
// default) y Vault/KMS real opt-in (backend "vault", protocolo KV v2 de HashiCorp
// Vault). Estos tests prueban el PROTOCOLO (URL, cabecera, forma de respuesta,
// fail-closed) contra un `fetch` sustituido -- nunca contra un Vault real (este
// entorno no tiene una instancia de Vault desplegada, ver comentario de archivo en
// secretsProvider.ts).
import { describe, expect, it, vi } from "vitest";
import { bootstrapProductionSecrets, fetchVaultSecrets, SecretsConfigError } from "../../../apps/api/src/lib/secretsProvider.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("bootstrapProductionSecrets — backend por defecto (\"env\")", () => {
  it("sin SECRETS_BACKEND es un no-op exacto: 0 llamadas de red, target sin cambios", async () => {
    const fetchImpl = vi.fn();
    const target: NodeJS.ProcessEnv = { JWT_SECRET: "ya-estaba" } as NodeJS.ProcessEnv;
    const result = await bootstrapProductionSecrets({ NODE_ENV: "production" } as NodeJS.ProcessEnv, target, fetchImpl);
    expect(result).toEqual({ backend: "env", keysLoaded: [] });
    expect(target.JWT_SECRET).toBe("ya-estaba");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("SECRETS_BACKEND=env explícito también es no-op", async () => {
    const fetchImpl = vi.fn();
    const result = await bootstrapProductionSecrets({ SECRETS_BACKEND: "env" } as NodeJS.ProcessEnv, {} as NodeJS.ProcessEnv, fetchImpl);
    expect(result).toEqual({ backend: "env", keysLoaded: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("un backend desconocido nunca se trata como \"env\" en silencio", async () => {
    await expect(
      bootstrapProductionSecrets({ SECRETS_BACKEND: "aws-secrets-manager" } as NodeJS.ProcessEnv),
    ).rejects.toThrow(/no es un backend válido/);
  });
});

describe("bootstrapProductionSecrets — backend \"vault\" (fail-closed en configuración incompleta)", () => {
  it("lanza si falta VAULT_ADDR/VAULT_TOKEN/VAULT_SECRET_PATH, sin caer a variables planas", async () => {
    const fetchImpl = vi.fn();
    await expect(
      bootstrapProductionSecrets({ SECRETS_BACKEND: "vault" } as NodeJS.ProcessEnv, {} as NodeJS.ProcessEnv, fetchImpl),
    ).rejects.toThrow(SecretsConfigError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("el mensaje de error nombra exactamente las variables faltantes", async () => {
    await expect(
      bootstrapProductionSecrets({ SECRETS_BACKEND: "vault", VAULT_ADDR: "https://vault.example:8200" } as NodeJS.ProcessEnv),
    ).rejects.toThrow(/VAULT_TOKEN, VAULT_SECRET_PATH/);
  });

  it("con configuración completa, llama a Vault con la URL/cabecera KV v2 correctas y copia las claves a `target`", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: { data: { JWT_SECRET: "vault-jwt-secret", METRICS_TOKEN: "vault-metrics-token" } } }));
    const target: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv;
    const source = {
      SECRETS_BACKEND: "vault",
      VAULT_ADDR: "https://vault.example:8200/",
      VAULT_TOKEN: "s.real-token",
      VAULT_SECRET_PATH: "atiende-hoteles/produccion",
    } as NodeJS.ProcessEnv;

    const result = await bootstrapProductionSecrets(source, target, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    // Barra final de VAULT_ADDR recortada antes de concatenar -- nunca "//v1/".
    expect(url).toBe("https://vault.example:8200/v1/secret/data/atiende-hoteles/produccion");
    expect((init as RequestInit).headers).toEqual({ "X-Vault-Token": "s.real-token" });

    expect(result).toEqual({ backend: "vault", keysLoaded: ["JWT_SECRET", "METRICS_TOKEN"] });
    expect(target.JWT_SECRET).toBe("vault-jwt-secret");
    expect(target.METRICS_TOKEN).toBe("vault-metrics-token");
  });

  it("respeta VAULT_KV_MOUNT cuando se declara", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: { data: { X: "y" } } }));
    await bootstrapProductionSecrets(
      {
        SECRETS_BACKEND: "vault",
        VAULT_ADDR: "https://vault.example:8200",
        VAULT_TOKEN: "t",
        VAULT_SECRET_PATH: "p",
        VAULT_KV_MOUNT: "kv-custom",
      } as NodeJS.ProcessEnv,
      {} as NodeJS.ProcessEnv,
      fetchImpl,
    );
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://vault.example:8200/v1/kv-custom/data/p");
  });

  it("Vault sobrescribe un valor plano previo en `target` (una vez activado, es la fuente de verdad)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: { data: { JWT_SECRET: "de-vault" } } }));
    const target: NodeJS.ProcessEnv = { JWT_SECRET: "plano-anterior" } as NodeJS.ProcessEnv;
    await bootstrapProductionSecrets(
      { SECRETS_BACKEND: "vault", VAULT_ADDR: "https://v", VAULT_TOKEN: "t", VAULT_SECRET_PATH: "p" } as NodeJS.ProcessEnv,
      target,
      fetchImpl,
    );
    expect(target.JWT_SECRET).toBe("de-vault");
  });
});

describe("fetchVaultSecrets — fail-closed ante respuestas no exitosas o vacías", () => {
  const config = { addr: "https://vault.example", token: "t", secretPath: "p", kvMount: "secret" };

  it("propaga un error explícito si Vault responde 403 (token inválido/sin permiso)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("forbidden", { status: 403, statusText: "Forbidden" }));
    await expect(fetchVaultSecrets(config, fetchImpl)).rejects.toThrow(/Vault respondió 403/);
  });

  it("propaga un error explícito si Vault responde 404 (secreto inexistente)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("not found", { status: 404, statusText: "Not Found" }));
    await expect(fetchVaultSecrets(config, fetchImpl)).rejects.toThrow(/Vault respondió 404/);
  });

  it("propaga un error explícito si Vault responde 200 sin datos (`data.data` vacío/ausente)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: { data: {} } }));
    await expect(fetchVaultSecrets(config, fetchImpl)).rejects.toThrow(/sin datos utilizables/);
  });

  it("propaga un error explícito si Vault responde 200 sin la forma KV v2 esperada", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { errors: [] }));
    await expect(fetchVaultSecrets(config, fetchImpl)).rejects.toThrow(/sin datos utilizables/);
  });

  it("nunca hace caché/reintento silencioso: cada llamada usa el fetch inyectado", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed: ECONNREFUSED"));
    await expect(fetchVaultSecrets(config, fetchImpl)).rejects.toThrow(/No se pudo contactar a Vault/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
