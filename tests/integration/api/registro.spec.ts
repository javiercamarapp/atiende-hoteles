// H12a · REQ-LAUNCH: alta autoservicio completa -- POST /registro crea org+hotel+owner,
// exige verificación de correo antes de poder iniciar sesión, y el correo de bienvenida
// se envía tras confirmar. Todo el correo se lee de `email_outbox` (FakeEmailAdapter),
// nunca se llama a ningún proveedor real.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixtureH12a, destroyApiFixtureH12a, ultimoCorreoPara, type ApiFixtureH12a } from "../../support/api-fixture-h12a.ts";

let fixture: ApiFixtureH12a;

beforeAll(async () => {
  fixture = await createApiFixtureH12a();
});

afterAll(async () => {
  await destroyApiFixtureH12a(fixture);
});

async function registrar(overrides: Partial<Record<string, string>> = {}) {
  const body = {
    hotelName: "Hotel Amanecer Registro",
    city: "Playa del Carmen",
    stateName: "Quintana Roo",
    ownerFullName: "Ana Torres",
    ownerEmail: "ana@hotelamanecer.example",
    password: "Contrasena2026",
    ...overrides,
  };
  return fixture.app.request("/registro", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function tokenDeVerificacion(email: string): Promise<string> {
  const { rows } = await fixture.engine.admin.query<{ token: string }>(
    "select token from public.account_token where email = $1 and purpose = 'verificar_correo' and status = 'pendiente' order by created_at desc limit 1;",
    [email],
  );
  return rows[0]!.token;
}

describe("POST /registro -- alta autoservicio", () => {
  it("crea org+hotel+owner, envía correo de verificación, y bloquea el login hasta confirmar", async () => {
    const res = await registrar();
    expect(res.status).toBe(201);
    const body = (await res.json()) as { hotelId: string };
    expect(body.hotelId).toBeTruthy();

    const correo = await ultimoCorreoPara(fixture.engine, "ana@hotelamanecer.example", "verificacion-cuenta");
    expect(correo).not.toBeNull();
    expect(correo!.html).toContain("Hotel Amanecer Registro");
    expect(correo!.text_body).not.toContain("undefined");

    const loginBloqueado = await fixture.app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ana@hotelamanecer.example", password: "Contrasena2026" }),
    });
    expect(loginBloqueado.status).toBe(403);

    const token = await tokenDeVerificacion("ana@hotelamanecer.example");
    const verificar = await fixture.app.request("/registro/verificar", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(verificar.status).toBe(200);

    const bienvenida = await ultimoCorreoPara(fixture.engine, "ana@hotelamanecer.example", "bienvenida-hotel");
    expect(bienvenida).not.toBeNull();

    const loginOk = await fixture.app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ana@hotelamanecer.example", password: "Contrasena2026" }),
    });
    expect(loginOk.status).toBe(200);
    const session = (await loginOk.json()) as { rol: string; hoteles: { id: string }[] };
    expect(session.rol).toBe("owner");
    expect(session.hoteles).toHaveLength(1);
  });

  it("rechaza un correo que ya tiene cuenta (409)", async () => {
    await registrar({ ownerEmail: "duplicado@hotelamanecer.example" });
    const segundo = await registrar({ ownerEmail: "duplicado@hotelamanecer.example", hotelName: "Otro hotel" });
    expect(segundo.status).toBe(409);
  });

  it("POST /registro/reenviar-verificacion invalida el token anterior y emite uno nuevo", async () => {
    await registrar({ ownerEmail: "reenvio@hotelamanecer.example" });
    const primerToken = await tokenDeVerificacion("reenvio@hotelamanecer.example");

    const reenvio = await fixture.app.request("/registro/reenviar-verificacion", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "reenvio@hotelamanecer.example" }),
    });
    expect(reenvio.status).toBe(200);

    const segundoToken = await tokenDeVerificacion("reenvio@hotelamanecer.example");
    expect(segundoToken).not.toBe(primerToken);

    const conElAnterior = await fixture.app.request("/registro/verificar", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: primerToken }),
    });
    expect(conElAnterior.status).toBe(409);
  });
});
