// H2 · Flujo real: login → /auth/me → /hoteles → /hoteles/:id/resumen, contra el mismo
// arnés embedded-postgres de H1 (packages/db). Verifica también "sin datos honesto"
// (REQ-UX-002): un hotel sin availability para hoy responde null, nunca 0 fabricado.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEV_SEED_PASSWORD } from "@atiende-hoteles/db";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

describe("apps/api: auth + resumen (integración real)", () => {
  let fixture: ApiFixture;

  beforeAll(async () => {
    fixture = await createApiFixture();
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  it("login con credenciales correctas devuelve un token y datos de sesión", async () => {
    const gmEmail = fixture.seed.hotels[0]!.staff.find((s) => s.role === "gm")!.email;
    const res = await fixture.app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: gmEmail, password: DEV_SEED_PASSWORD }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; email: string; rol: string; hoteles: unknown[] };
    expect(body.token).toBeTruthy();
    expect(body.email).toBe(gmEmail);
    expect(body.rol).toBe("gm");
    expect(body.hoteles).toHaveLength(1);
  });

  it("login con contraseña incorrecta responde 401 con formato uniforme {code,message,request_id}", async () => {
    const gmEmail = fixture.seed.hotels[0]!.staff.find((s) => s.role === "gm")!.email;
    const res = await fixture.app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: gmEmail, password: "contraseña-incorrecta" }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string; message: string; request_id: string };
    expect(body.code).toBe("unauthorized");
    expect(body.request_id).toBeTruthy();
  });

  it("login con email inexistente responde el mismo 401 genérico (no filtra si el correo existe)", async () => {
    const res = await fixture.app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "no-existe@demo.test", password: "cualquiera" }),
    });
    expect(res.status).toBe(401);
  });

  it("sin token, una ruta protegida responde 401", async () => {
    const res = await fixture.app.request(`/hoteles/${fixture.seed.hotels[0]!.id}/resumen`);
    expect(res.status).toBe(401);
  });

  it("GET /auth/me devuelve los hoteles/roles reales del usuario autenticado", async () => {
    const gmEmail = fixture.seed.hotels[0]!.staff.find((s) => s.role === "gm")!.email;
    const token = await loginAs(fixture.app, gmEmail);

    const res = await fixture.app.request("/auth/me", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { email: string; hoteles: { id: string; rol: string }[] };
    expect(body.email).toBe(gmEmail);
    expect(body.hoteles).toHaveLength(1);
    expect(body.hoteles[0]!.rol).toBe("gm");
  });

  it("GET /hoteles devuelve solo los hoteles del usuario autenticado", async () => {
    const gmEmail = fixture.seed.hotels[0]!.staff.find((s) => s.role === "gm")!.email;
    const token = await loginAs(fixture.app, gmEmail);

    const res = await fixture.app.request("/hoteles", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; nombre: string }[];
    expect(body).toHaveLength(1);
    expect(body[0]!.id).toBe(fixture.seed.hotels[0]!.id);
  });

  it("GET /hoteles/:id/resumen con datos de la seed devuelve cifras reales (no null)", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const gmEmail = hotelA.staff.find((s) => s.role === "gm")!.email;
    const token = await loginAs(fixture.app, gmEmail);

    const res = await fixture.app.request(`/hoteles/${hotelA.id}/resumen`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ocupacionPct: number | null; adr: number | null; revpar: number | null; reservasHoy: number | null };
    expect(body.adr).not.toBeNull();
    expect(body.ocupacionPct).not.toBeNull();
    expect(body.reservasHoy).toBe(0);
  });

  it("resumen de un hotel sin availability para hoy responde null honesto, nunca 0 fabricado", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const gmEmail = hotelA.staff.find((s) => s.role === "gm")!.email;

    // Vacía la disponibilidad de HOY para este hotel directamente con el cliente admin
    // (bypassa RLS, es preparación de datos de prueba, no una acción del actor bajo
    // prueba).
    await fixture.engine.admin.query("delete from public.availability where hotel_id = $1 and date = current_date;", [
      hotelA.id,
    ]);

    const token = await loginAs(fixture.app, gmEmail);
    const res = await fixture.app.request(`/hoteles/${hotelA.id}/resumen`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ocupacionPct: number | null; adr: number | null };
    expect(body.ocupacionPct).toBeNull();
    expect(body.adr).toBeNull();
  });
});
