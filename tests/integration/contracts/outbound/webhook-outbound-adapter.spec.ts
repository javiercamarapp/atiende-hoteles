// H18 · conector-pms-enterprise: prueba de CONTRATO real de `WebhookOutboundAdapter`
// (fetch de verdad) contra `tests/support/fakeOutboundTargetServer.ts` -- mismo criterio
// que `stripe-adapter.spec.ts`: prueba el código del adaptador de extremo a extremo,
// NUNCA contra el sistema real de un hotel. `verificadoContraReal` permanece `false`
// incluso después de esta prueba.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebhookOutboundAdapter, OutboundDeliveryError, WEBHOOK_OUTBOUND_VERIFICADO_CONTRA_REAL } from "@atiende-hoteles/mcp-outbound";
import { SsrfBlockedError, verifyHmacSignature } from "@atiende-hoteles/mcp-shared";
import {
  startFakeOutboundTargetServer,
  type FakeOutboundTargetServer,
} from "../../../support/fakeOutboundTargetServer.ts";

describe("contrato: WebhookOutboundAdapter real contra simulador HTTP local", () => {
  let server: FakeOutboundTargetServer;

  beforeAll(async () => {
    server = await startFakeOutboundTargetServer();
  });

  afterAll(async () => {
    await server.close();
  });

  afterEach(() => {
    server.received.length = 0;
    server.resetForcedResponses();
  });

  // Patrón Likida/atiende.ai #1 (anti-SSRF, safeFetch.ts): `allowPrivateIpForTesting`
  // es SOLO para que esta suite pueda hablar con `fakeOutboundTargetServer.ts`, que por
  // diseño corre en 127.0.0.1 (loopback) -- ver comentario de
  // `WebhookOutboundAdapterConfig`. La prueba "bloquea SSRF" de abajo (sin esta bandera)
  // es la que demuestra que la protección real sigue activa.
  function makeAdapter(requestTimeoutMs = 5_000): WebhookOutboundAdapter {
    return new WebhookOutboundAdapter({ requestTimeoutMs, maxAttempts: 4, allowPrivateIpForTesting: true });
  }

  function sampleTask(overrides: Partial<Parameters<WebhookOutboundAdapter["pushTask"]>[1]> = {}) {
    return {
      idempotencyKey: "housekeeping_task:task-1",
      taskType: "housekeeping_task" as const,
      taskId: "task-1",
      hotelId: "hotel-1",
      title: "Limpieza habitación 101",
      priority: "media" as const,
      roomCode: "101",
      status: "pendiente",
      occurredAt: "2026-09-09T12:00:00.000Z",
      ...overrides,
    };
  }

  it("status() reporta available=true sin depender de credenciales de proceso", () => {
    expect(makeAdapter().status()).toEqual({ provider: "webhook-outbound-generico", available: true, simulated: false });
  });

  it("nunca declara verificado contra el sistema real de un hotel, ni siquiera con la suite en verde", () => {
    expect(makeAdapter().verificadoContraReal).toBe(false);
    expect(WEBHOOK_OUTBOUND_VERIFICADO_CONTRA_REAL).toBe(false);
  });

  it("pushTask(): camino feliz -- POST firmado, el receptor verifica la firma y responde 2xx", async () => {
    const adapter = makeAdapter();
    const task = sampleTask();
    const result = await adapter.pushTask({ url: server.webhookUrl, secret: server.secret }, task);

    expect(result.delivered).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.externalTaskId).toMatch(/^HOTELSYS-/);

    expect(server.received).toHaveLength(1);
    const received = server.received[0]!;
    expect(received.eventId).toBe(task.idempotencyKey);
    expect(received.taskType).toBe("housekeeping_task");
    expect(JSON.parse(received.rawBody)).toMatchObject({ taskId: "task-1", title: task.title });
    // El receptor puede verificar la firma con el MISMO primitivo que el resto del repo
    // usa para verificar webhooks entrantes -- prueba de que el formato es compatible.
    expect(verifyHmacSignature(received.rawBody, received.signature, server.secret)).toBe(true);
  });

  it("pushTask(): un secreto incorrecto produce una firma que el receptor rechaza (401 -> OutboundDeliveryError)", async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.pushTask({ url: server.webhookUrl, secret: "secreto-equivocado-1234567890" }, sampleTask()),
    ).rejects.toBeInstanceOf(OutboundDeliveryError);
  });

  it("pushTask(): 429 con Retry-After se reintenta y termina entregando", async () => {
    const adapter = makeAdapter();
    server.force429(0, 1);
    const result = await adapter.pushTask({ url: server.webhookUrl, secret: server.secret }, sampleTask());
    expect(result.delivered).toBe(true);
    expect(server.received).toHaveLength(2); // 1 intento rechazado + 1 exitoso
  });

  it("pushTask(): 429 sostenido agota los reintentos y lanza (nunca finge éxito)", async () => {
    const adapter = makeAdapter();
    server.force429(0, 10); // más que maxAttempts (4): nunca se recupera
    await expect(adapter.pushTask({ url: server.webhookUrl, secret: server.secret }, sampleTask())).rejects.toThrow();
  });

  it("pushTask(): 500 (no-2xx que no es 429) NUNCA se reintenta -- un solo intento, lanza de inmediato", async () => {
    const adapter = makeAdapter();
    server.force500();
    await expect(
      adapter.pushTask({ url: server.webhookUrl, secret: server.secret }, sampleTask()),
    ).rejects.toBeInstanceOf(OutboundDeliveryError);
    expect(server.received).toHaveLength(1);
  });

  it("pushTask(): timeout de red propaga un error, nunca finge éxito", async () => {
    const adapter = makeAdapter(200);
    server.forceHang();
    await expect(adapter.pushTask({ url: server.webhookUrl, secret: server.secret }, sampleTask())).rejects.toThrow();
  });

  it("pushTask(): dos tareas distintas firman distinto (la firma cubre el cuerpo completo, no solo el secreto)", async () => {
    const adapter = makeAdapter();
    await adapter.pushTask({ url: server.webhookUrl, secret: server.secret }, sampleTask({ taskId: "task-a" }));
    await adapter.pushTask({ url: server.webhookUrl, secret: server.secret }, sampleTask({ taskId: "task-b" }));
    expect(server.received[0]!.signature).not.toBe(server.received[1]!.signature);
  });

  // Patrón Likida/atiende.ai #1 (anti-SSRF): sin `allowPrivateIpForTesting` (el default
  // real, el que usa producción), el adaptador debe rechazar `destination.url` aunque
  // apunte a un servidor local real que SÍ respondería -- la protección es sobre la IP
  // resuelta, no sobre "si el servidor existe". Sin este chequeo, la prueba "camino
  // feliz" de arriba (con la bandera activada) sería la única evidencia sobre este
  // adaptador, y nunca demostraría que la protección real está conectada.
  it("SIN allowPrivateIpForTesting, pushTask() bloquea destination.url apuntando a 127.0.0.1 (SSRF)", async () => {
    const adapter = new WebhookOutboundAdapter({ requestTimeoutMs: 2_000, maxAttempts: 1 });
    await expect(adapter.pushTask({ url: server.webhookUrl, secret: server.secret }, sampleTask())).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
    expect(server.received).toHaveLength(0); // ningún socket real se abrió contra el servidor.
  });
});
