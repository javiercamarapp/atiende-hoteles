// H12a · REQ-LAUNCH: onboarding guiado tras el alta -- crear un tipo de habitación con
// su tarifa base (siembra room_type+room+rate_plan+availability, mismo patrón que
// packages/db/src/seed.ts) y ajustar la zona horaria del hotel.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixtureH12a, destroyApiFixtureH12a, type ApiFixtureH12a } from "../../support/api-fixture-h12a.ts";

let fixture: ApiFixtureH12a;
let hotelId: string;
let ownerToken: string;

beforeAll(async () => {
  fixture = await createApiFixtureH12a();
  hotelId = fixture.seed.hotels[0]!.id;
  const ownerEmail = fixture.seed.hotels[0]!.staff.find((s) => s.role === "owner")!.email;
  const login = await fixture.app.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: ownerEmail, password: "atiende-dev-2026" }),
  });
  ownerToken = ((await login.json()) as { token: string }).token;
});

afterAll(async () => {
  await destroyApiFixtureH12a(fixture);
});

function auth(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

describe("POST /hoteles/:hotelId/onboarding/tipos-habitacion", () => {
  it("crea el tipo de habitación con sus cuartos y 30 días de tarifa/disponibilidad", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/onboarding/tipos-habitacion`, {
      method: "POST",
      headers: auth(ownerToken),
      body: JSON.stringify({ name: "Junior Suite", maxOccupancy: 3, totalRooms: 8, basePrice: 1800 }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { roomTypeId: string };

    const { rows: rooms } = await fixture.engine.admin.query<{ id: string }>("select id from public.room where room_type_id = $1;", [
      body.roomTypeId,
    ]);
    expect(rooms).toHaveLength(8);

    const { rows: rates } = await fixture.engine.admin.query<{ price: string }>("select price from public.rate_plan where room_type_id = $1;", [
      body.roomTypeId,
    ]);
    expect(rates).toHaveLength(30);
    expect(Number(rates[0]!.price)).toBe(1800);
  });

  it("un rol sin permiso de administración no puede crear tipos de habitación (403)", async () => {
    const frontdeskEmail = fixture.seed.hotels[0]!.staff.find((s) => s.role === "frontdesk")!.email;
    const login = await fixture.app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: frontdeskEmail, password: "atiende-dev-2026" }),
    });
    const token = ((await login.json()) as { token: string }).token;

    const res = await fixture.app.request(`/hoteles/${hotelId}/onboarding/tipos-habitacion`, {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ name: "Otro", totalRooms: 2, basePrice: 900 }),
    });
    expect(res.status).toBe(403);
  });
});

describe("PATCH /hoteles/:hotelId/onboarding/zona-horaria", () => {
  it("actualiza hotel.timezone", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/onboarding/zona-horaria`, {
      method: "PATCH",
      headers: auth(ownerToken),
      body: JSON.stringify({ timezone: "America/Cancun" }),
    });
    expect(res.status).toBe(200);

    const { rows } = await fixture.engine.admin.query<{ timezone: string }>("select timezone from public.hotel where id = $1;", [hotelId]);
    expect(rows[0]!.timezone).toBe("America/Cancun");
  });

  it("rechaza una zona horaria mal formada", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/onboarding/zona-horaria`, {
      method: "PATCH",
      headers: auth(ownerToken),
      body: JSON.stringify({ timezone: "no-es-iana" }),
    });
    expect(res.status).toBe(400);
  });
});
