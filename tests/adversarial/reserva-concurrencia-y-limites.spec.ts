// H2 · Concurrencia real (embedded-postgres, NUNCA solo PGlite) sobre el endpoint HTTP
// completo: dos POST /reservas simultáneos por la última habitación → exactamente uno
// 201, el otro 409 "sin_disponibilidad", sin sobreventa. También cubre inyección en
// campos de texto (SQL/HTML) y límite de tasa por IP/usuario.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../support/api-fixture.ts";
import { createApp, loadEnv, RateLimiter, type AppDeps } from "@atiende-hoteles/api";
import pino from "pino";

describe("adversarial: concurrencia real de reservas (última habitación) vía HTTP", () => {
  let fixture: ApiFixture;
  let hotelId: string;
  let roomTypeId: string;
  let gmToken: string;
  let lastDate: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    roomTypeId = hotelA.roomTypes[0]!.id;
    gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);

    const { rows } = await fixture.engine.admin.query<{ date: string }>(
      "select date::text as date from public.availability where hotel_id = $1 and room_type_id = $2 order by date asc limit 1;",
      [hotelId, roomTypeId],
    );
    lastDate = rows[0]!.date;
    await fixture.engine.admin.query(
      "update public.availability set total_rooms = 1, booked_rooms = 0 where hotel_id = $1 and room_type_id = $2 and date = $3;",
      [hotelId, roomTypeId, lastDate],
    );
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  it("dos POST /reservas concurrentes por la última habitación: exactamente 1x201 y 1x409, sin sobreventa", async () => {
    const checkOut = new Date(`${lastDate}T00:00:00Z`);
    checkOut.setUTCDate(checkOut.getUTCDate() + 1);
    const checkOutStr = checkOut.toISOString().slice(0, 10);

    const attempt = () =>
      fixture.app.request(`/hoteles/${hotelId}/reservas`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${gmToken}`,
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
        },
        body: JSON.stringify({ roomTypeId, checkInDate: lastDate, checkOutDate: checkOutStr }),
      });

    const [a, b] = await Promise.all([attempt(), attempt()]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);

    const failed = a.status === 409 ? a : b;
    const failedBody = (await failed.json()) as { code: string };
    expect(failedBody.code).toBe("sin_disponibilidad");

    const { rows: finalState } = await fixture.engine.admin.query<{ booked_rooms: number; total_rooms: number }>(
      "select booked_rooms, total_rooms from public.availability where hotel_id = $1 and room_type_id = $2 and date = $3;",
      [hotelId, roomTypeId, lastDate],
    );
    expect(finalState[0]!.booked_rooms).toBe(1);
    expect(finalState[0]!.total_rooms).toBe(1);
  });
});

describe("adversarial: inyección en campos de texto", () => {
  let fixture: ApiFixture;

  beforeAll(async () => {
    fixture = await createApiFixture();
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  it("un nombre de huésped con carga SQL/HTML se guarda como texto literal, no se ejecuta ni rompe la query", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const token = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "frontdesk")!.email);
    const payload = "Robert'); DROP TABLE public.guest; --<script>alert(1)</script>";

    const res = await fixture.app.request(`/hoteles/${hotelA.id}/huespedes`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ nombre: payload }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; nombre: string };
    expect(created.nombre).toBe(payload);

    // La tabla `guest` sigue existiendo y la fila quedó guardada tal cual (parametrizado,
    // nunca concatenado en el SQL).
    const { rows } = await fixture.engine.admin.query<{ full_name: string }>(
      "select full_name from public.guest where id = $1;",
      [created.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.full_name).toBe(payload);

    const stillWorks = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.guest;",
    );
    expect(Number(stillWorks.rows[0]!.count)).toBeGreaterThan(0);
  });

  it("un email con formato inválido en el body de login es rechazado por validación (400), nunca llega a SQL", async () => {
    const res = await fixture.app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "' OR 1=1 --", password: "x" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("validation_error");
  });
});

describe("adversarial: límite de tasa por IP y por usuario", () => {
  let fixture: ApiFixture;
  let limitedApp: ReturnType<typeof createApp>;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const env = loadEnv({ NODE_ENV: "test", JWT_SECRET: "test-secret-not-for-production" } as NodeJS.ProcessEnv);
    const deps: AppDeps = {
      engine: fixture.engine,
      env,
      logger: pino({ level: "silent" }),
      ipLimiter: new RateLimiter({ limit: 3, windowMs: 60_000 }),
      userLimiter: new RateLimiter({ limit: 1000, windowMs: 60_000 }),
    };
    limitedApp = createApp(deps);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  it("una IP que excede el límite configurado recibe 429 con formato uniforme", async () => {
    const ip = "203.0.113.7";
    const results: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await limitedApp.request("/health", { headers: { "x-forwarded-for": ip } });
      results.push(res.status);
    }
    expect(results.slice(0, 3)).toEqual([200, 200, 200]);
    expect(results.slice(3)).toEqual([429, 429]);

    const last = await limitedApp.request("/health", { headers: { "x-forwarded-for": ip } });
    const body = (await last.json()) as { code: string; request_id: string };
    expect(body.code).toBe("rate_limited");
    expect(body.request_id).toBeTruthy();
  });

  it("una IP distinta no se ve afectada por el límite de la primera", async () => {
    const res = await limitedApp.request("/health", { headers: { "x-forwarded-for": "198.51.100.9" } });
    expect(res.status).toBe(200);
  });
});
