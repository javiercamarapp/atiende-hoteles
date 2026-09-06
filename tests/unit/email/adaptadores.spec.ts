// H12a · Contrato de "honestidad" de los adaptadores de envío (ver port.ts): sin
// credenciales, ResendAdapter/SmtpAdapter deben devolver `status: "no_configurado"` sin
// lanzar y sin `simulated: true` -- nunca fingen un envío exitoso. FakeEmailAdapter (el
// único que sí simula) debe deduplicar por `dedupeKey` y persistir en el sink de
// archivos usado por `npm run email:preview`.
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ResendAdapter,
  SmtpAdapter,
  FakeEmailAdapter,
  fileEmailOutboxSink,
  sampleVerificacionCuentaData,
  renderVerificacionCuenta,
} from "@atiende-hoteles/email";
import type { EmailMessage } from "@atiende-hoteles/email";

function buildMessage(overrides: Partial<EmailMessage> = {}): EmailMessage {
  const rendered = renderVerificacionCuenta(sampleVerificacionCuentaData());
  return {
    ...rendered,
    to: { email: "huesped@example.com", name: "Huésped de Prueba" },
    template: "verificacion-cuenta",
    ...overrides,
  };
}

describe("ResendAdapter sin configurar (H12a)", () => {
  it("configured es false y send() devuelve no_configurado sin lanzar ni simular", async () => {
    const adapter = new ResendAdapter({});
    expect(adapter.configured).toBe(false);

    const result = await adapter.send(buildMessage());
    expect(result.status).toBe("no_configurado");
    expect(result.simulated).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe("SmtpAdapter sin configurar (H12a)", () => {
  it("configured es false y send() devuelve no_configurado sin lanzar ni simular", async () => {
    const adapter = new SmtpAdapter({});
    expect(adapter.configured).toBe(false);

    const result = await adapter.send(buildMessage());
    expect(result.status).toBe("no_configurado");
    expect(result.simulated).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe("FakeEmailAdapter con fileEmailOutboxSink (H12a)", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("send() devuelve enviado/simulated:true y persiste el archivo .json con el contenido correcto", async () => {
    dir = await mkdtemp(join(tmpdir(), "atiende-email-outbox-"));
    const adapter = new FakeEmailAdapter(fileEmailOutboxSink(dir));
    const message = buildMessage({ dedupeKey: "dedupe-unico-1" });

    const result = await adapter.send(message);
    expect(result.status).toBe("enviado");
    expect(result.simulated).toBe(true);
    expect(result.providerMessageId).toBeTruthy();

    const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);

    const raw = await readFile(join(dir, files[0]!), "utf8");
    const entry = JSON.parse(raw) as Record<string, unknown>;
    expect(entry.toEmail).toBe("huesped@example.com");
    expect(entry.subject).toBe(message.subject);
    expect(entry.html).toBe(message.html);
    expect(entry.dedupeKey).toBe("dedupe-unico-1");
    expect(entry.status).toBe("enviado");
  });

  it("dos envíos con la misma dedupeKey devuelven el mismo providerMessageId y el sink solo guarda 1 archivo", async () => {
    dir = await mkdtemp(join(tmpdir(), "atiende-email-outbox-"));
    const adapter = new FakeEmailAdapter(fileEmailOutboxSink(dir));
    const message = buildMessage({ dedupeKey: "dedupe-repetido" });

    const first = await adapter.send(message);
    const second = await adapter.send(message);

    expect(second.providerMessageId).toBe(first.providerMessageId);

    const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);
  });
});
