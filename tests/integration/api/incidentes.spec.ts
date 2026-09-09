// REQ-SEG-009 (H19-010/BP-153) — "Debe existir un procedimiento documentado y probado de
// notificación de brechas de seguridad (detección, evaluación, notificación al afectado
// y a la autoridad en plazo); una brecha de datos de pasaporte se considera vulneración
// significativa que requiere notificación obligatoria." Este archivo es la parte
// "probado" del requisito, contra la app real (embedded Postgres, sin mocks):
//   - Solo owner/gm pueden declarar una brecha (403 para housekeeping).
//   - Declarar una brecha deja un registro INMUTABLE en audit_log (mismo mecanismo que
//     el resto del repo) y calcula correctamente "vulneración significativa" cuando
//     involucra un documento de identidad (pasaporte).
//   - GET lista las brechas declaradas del hotel.
//   - La notificación interna REALMENTE llega -- se prueba contra un servidor HTTP de
//     verdad (node:http, sin credenciales de ningún proveedor), nunca solo con un
//     `fetch` sustituido -- ver también tests/unit/api/security-breach-alert.spec.ts
//     para la cobertura de unidad del mecanismo.
// El canal final de producción (Slack/PagerDuty/correo real) sigue sin credenciales en
// este entorno (ADR-007) -- lo que este archivo prueba es que el mecanismo GENÉRICO de
// entrega funciona de punta a punta con cualquier URL que se configure.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

function auth(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

interface WebhookCapture {
  server: Server;
  url: string;
  received: Array<Record<string, unknown>>;
}

async function startCapturingWebhook(): Promise<WebhookCapture> {
  const received: Array<Record<string, unknown>> = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        received.push({});
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}/webhook`, received };
}

async function stopWebhook(capture: WebhookCapture): Promise<void> {
  await new Promise<void>((resolve, reject) => capture.server.close((err) => (err ? reject(err) : resolve())));
}

interface AuditLogRow {
  id: string;
  hash: string;
  prev_hash: string | null;
}

describe("adversarial/integración: notificación de brechas de seguridad (REQ-SEG-009)", () => {
  let fixture: ApiFixture;
  let ownerToken: string;
  let gmToken: string;
  let housekeepingToken: string;
  let hotelId: string;
  const previoWebhookEnv = process.env.SECURITY_BREACH_ALERT_WEBHOOK_URL;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    ownerToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "owner")!.email);
    gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);
    housekeepingToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "housekeeping")!.email);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  afterEach(() => {
    if (previoWebhookEnv === undefined) delete process.env.SECURITY_BREACH_ALERT_WEBHOOK_URL;
    else process.env.SECURITY_BREACH_ALERT_WEBHOOK_URL = previoWebhookEnv;
  });

  it("housekeeping NO puede declarar una brecha (403) -- solo owner/gm", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/incidentes/brecha`, {
      method: "POST",
      headers: auth(housekeepingToken),
      body: JSON.stringify({ categoria: "otro", descripcion: "Prueba sin autorización." }),
    });
    expect(res.status).toBe(403);
  });

  it("gm declara una brecha con documento de identidad: vulneracionSignificativa=true, queda en audit_log inmutable, y GET la lista", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/incidentes/brecha`, {
      method: "POST",
      headers: auth(gmToken),
      body: JSON.stringify({
        categoria: "documento_identidad",
        descripcion: "Un log de aplicación expuso temporalmente el número de pasaporte de un huésped.",
        datosInvolucrados: ["pasaporte"],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      incidenteId: string;
      detectadoEn: string;
      vulneracionSignificativa: boolean;
      categoria: string;
    };
    expect(body.vulneracionSignificativa).toBe(true);
    expect(body.categoria).toBe("documento_identidad");
    expect(new Date(body.detectadoEn).getTime()).toBeLessThanOrEqual(Date.now());

    // Registro inmutable real -- misma cadena de hash append-only que el resto del
    // repo (0008/0012/0015/0016), no una tabla paralela inventada para este endpoint.
    const { rows } = await fixture.engine.admin.query<AuditLogRow>(
      "select id, hash, prev_hash from public.audit_log where id = $1 and entity_type = 'security_breach' and action = 'security_breach.declared';",
      [body.incidenteId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.hash.length).toBeGreaterThan(0);

    const listar = await fixture.app.request(`/hoteles/${hotelId}/incidentes/brecha`, { headers: auth(ownerToken) });
    expect(listar.status).toBe(200);
    const lista = (await listar.json()) as { incidenteId: string }[];
    expect(lista.some((i) => i.incidenteId === body.incidenteId)).toBe(true);
  });

  it("una brecha SIN datos de identidad involucrados: vulneracionSignificativa=false", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/incidentes/brecha`, {
      method: "POST",
      headers: auth(gmToken),
      body: JSON.stringify({
        categoria: "otro",
        descripcion: "Un empleado dejó su sesión abierta en una computadora compartida.",
        datosInvolucrados: [],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { vulneracionSignificativa: boolean };
    expect(body.vulneracionSignificativa).toBe(false);
  });

  it("con SECURITY_BREACH_ALERT_WEBHOOK_URL configurado: la notificación LLEGA de verdad a un servidor HTTP real (mecanismo probado de punta a punta)", async () => {
    const webhook = await startCapturingWebhook();
    process.env.SECURITY_BREACH_ALERT_WEBHOOK_URL = webhook.url;
    try {
      const res = await fixture.app.request(`/hoteles/${hotelId}/incidentes/brecha`, {
        method: "POST",
        headers: auth(ownerToken),
        body: JSON.stringify({
          categoria: "credencial_fiscal",
          descripcion: "Posible exposición de la e.firma en un backup mal configurado.",
          datosInvolucrados: ["efirma"],
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { incidenteId: string };

      expect(webhook.received).toHaveLength(1);
      const entregado = webhook.received[0]!;
      expect(entregado.nivel).toBe("alerta");
      expect(entregado.tipo).toBe("brecha_seguridad_detectada");
      expect(entregado.incident_id).toBe(body.incidenteId);
      expect(entregado.vulneracion_significativa).toBe(true);
      expect(entregado.categoria).toBe("credencial_fiscal");
    } finally {
      await stopWebhook(webhook);
    }
  });

  it("sin ningún destino configurado: la brecha SIGUE quedando registrada (nunca depende de la notificación para persistir)", async () => {
    delete process.env.SECURITY_BREACH_ALERT_WEBHOOK_URL;
    const res = await fixture.app.request(`/hoteles/${hotelId}/incidentes/brecha`, {
      method: "POST",
      headers: auth(ownerToken),
      body: JSON.stringify({ categoria: "otro", descripcion: "Brecha declarada sin ningún webhook configurado en el entorno." }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { incidenteId: string };
    const { rows } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.audit_log where id = $1;",
      [body.incidenteId],
    );
    expect(rows[0]!.count).toBe("1");
  });
});
