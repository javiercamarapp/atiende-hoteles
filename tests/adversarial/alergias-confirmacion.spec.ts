// REQ-AB-004 (P0/GOB): "Cuando el huésped declare alergia/restricción alimentaria en
// un pedido de F&B, la orden debe marcarse explícitamente y requerir confirmación
// humana del cocinero antes de que el sistema asegure al huésped que el platillo es
// seguro; sin confirmación, el sistema no debe afirmarlo." Prueba REAL contra
// PGlite/embedded-postgres (sin mocks de base de datos) vía la app Hono real
// (`tests/support/api-fixture.ts`), ejercitando `apps/api/src/routes/pedidosFnb.ts`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../support/api-fixture.ts";

describe("adversarial: pedido de F&B con alergia declarada exige confirmación del cocinero antes de asegurar seguridad (REQ-AB-004)", () => {
  let fixture: ApiFixture;
  let hotelId: string;
  let frontdeskToken: string;
  let fnbToken: string;
  let ownerToken: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotel = fixture.seed.hotels[0]!;
    hotelId = hotel.id;
    frontdeskToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "frontdesk")!.email);
    fnbToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "fnb")!.email);
    ownerToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "owner")!.email);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  function auth(token: string) {
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
  }

  async function crearPedido(body: Record<string, unknown>) {
    const res = await fixture.app.request(`/hoteles/${hotelId}/pedidos-fnb`, {
      method: "POST",
      headers: auth(frontdeskToken),
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as {
      id: string;
      alergiaDeclarada: boolean;
      alergiaDetectadaVia: string | null;
      puedeAsegurarSeguridad: boolean;
      mensajeSeguridad: string;
    };
  }

  it("un pedido SIN alergia declarada puede asegurarse como seguro de inmediato (nada que confirmar)", async () => {
    const pedido = await crearPedido({ items: [{ nombre: "Pizza margarita" }] });
    expect(pedido.alergiaDeclarada).toBe(false);
    expect(pedido.puedeAsegurarSeguridad).toBe(true);
    expect(pedido.mensajeSeguridad).not.toMatch(/es seguro/i);

    const res = await fixture.app.request(`/hoteles/${hotelId}/pedidos-fnb/${pedido.id}/asegurar-seguridad`, {
      method: "POST",
      headers: auth(fnbToken),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
  });

  it("un pedido CON alergia declarada (campo estructurado) se marca explícitamente y NO puede asegurarse sin confirmación", async () => {
    const pedido = await crearPedido({
      items: [{ nombre: "Ensalada César", notas: "sin camarones" }],
      alergiaDeclarada: true,
      notas: "alergia a los mariscos",
    });
    expect(pedido.alergiaDeclarada).toBe(true);
    expect(pedido.alergiaDetectadaVia).toBe("estructurado");
    expect(pedido.puedeAsegurarSeguridad).toBe(false);
    expect(pedido.mensajeSeguridad).not.toMatch(/es seguro/i);

    // El intento de "asegurar seguridad" DEBE rechazarse -- 0 confirmaciones = 0
    // afirmaciones de seguridad, sin importar quién lo intente (incluido el owner).
    const intento1 = await fixture.app.request(`/hoteles/${hotelId}/pedidos-fnb/${pedido.id}/asegurar-seguridad`, {
      method: "POST",
      headers: auth(fnbToken),
      body: JSON.stringify({}),
    });
    expect(intento1.status).toBe(409);
    const intento2 = await fixture.app.request(`/hoteles/${hotelId}/pedidos-fnb/${pedido.id}/asegurar-seguridad`, {
      method: "POST",
      headers: auth(ownerToken),
      body: JSON.stringify({}),
    });
    expect(intento2.status).toBe(409);

    // Evidencia estructural en la base real: NINGUNA fila quedó con
    // `safety_assurance_sent_at` lleno para este pedido -- el sistema nunca afirmó
    // seguridad, verificado directamente contra Postgres, no solo contra la respuesta HTTP.
    const { rows } = await fixture.engine.admin.query<{ safety_assurance_sent_at: string | null; kitchen_confirmed_at: string | null }>(
      "select safety_assurance_sent_at::text as safety_assurance_sent_at, kitchen_confirmed_at::text as kitchen_confirmed_at from public.fnb_order where id = $1;",
      [pedido.id],
    );
    expect(rows[0]!.safety_assurance_sent_at).toBeNull();
    expect(rows[0]!.kitchen_confirmed_at).toBeNull();
  });

  it("red de seguridad: alergia declarada SOLO en una nota de texto libre también se marca y bloquea la afirmación de seguridad", async () => {
    const pedido = await crearPedido({
      items: [{ nombre: "Pasta alfredo", notas: "tengo alergia al gluten, por favor confirmen" }],
      // alergiaDeclarada NO se marca explícita -- el huésped solo lo escribió en la nota.
    });
    expect(pedido.alergiaDeclarada).toBe(true);
    expect(pedido.alergiaDetectadaVia).toBe("texto_libre");
    expect(pedido.puedeAsegurarSeguridad).toBe(false);

    const bloqueado = await fixture.app.request(`/hoteles/${hotelId}/pedidos-fnb/${pedido.id}/asegurar-seguridad`, {
      method: "POST",
      headers: auth(fnbToken),
      body: JSON.stringify({}),
    });
    expect(bloqueado.status).toBe(409);
  });

  it("frontdesk NO puede confirmar en nombre de la cocina (solo fnb/owner/gm)", async () => {
    const pedido = await crearPedido({ items: [{ nombre: "Sopa de mariscos" }], alergiaDeclarada: true });

    const rechazado = await fixture.app.request(`/hoteles/${hotelId}/pedidos-fnb/${pedido.id}/confirmar-cocina`, {
      method: "POST",
      headers: auth(frontdeskToken),
      body: JSON.stringify({}),
    });
    expect(rechazado.status).toBe(403);
  });

  it("tras la confirmación humana del cocinero, y SOLO entonces, el sistema puede asegurar que el platillo es seguro", async () => {
    const pedido = await crearPedido({
      items: [{ nombre: "Tacos de camarón" }],
      alergiaDeclarada: true,
      notas: "alergia severa a los mariscos, verificar receta",
    });
    expect(pedido.puedeAsegurarSeguridad).toBe(false);

    const confirmacion = await fixture.app.request(`/hoteles/${hotelId}/pedidos-fnb/${pedido.id}/confirmar-cocina`, {
      method: "POST",
      headers: auth(fnbToken),
      body: JSON.stringify({ nota: "receta verificada, sin mariscos ni derivados" }),
    });
    expect(confirmacion.status).toBe(200);
    const confirmado = (await confirmacion.json()) as { puedeAsegurarSeguridad: boolean; cocineroConfirmoPor: string | null };
    expect(confirmado.puedeAsegurarSeguridad).toBe(true);
    expect(confirmado.cocineroConfirmoPor).not.toBeNull();

    const aseguramiento = await fixture.app.request(`/hoteles/${hotelId}/pedidos-fnb/${pedido.id}/asegurar-seguridad`, {
      method: "POST",
      headers: auth(fnbToken),
      body: JSON.stringify({}),
    });
    expect(aseguramiento.status).toBe(200);
    const asegurado = (await aseguramiento.json()) as { mensajeSeguridad: string; seguridadAseguradaEn: string | null };
    expect(asegurado.mensajeSeguridad).toMatch(/es seguro/i);
    expect(asegurado.seguridadAseguradaEn).not.toBeNull();

    // Confirmado en la base real: exactamente 1 fila con ambas marcas de tiempo, y en
    // el orden correcto (nunca se afirmó seguridad ANTES de la confirmación humana).
    const { rows } = await fixture.engine.admin.query<{ kitchen_confirmed_at: string; safety_assurance_sent_at: string }>(
      "select kitchen_confirmed_at::text as kitchen_confirmed_at, safety_assurance_sent_at::text as safety_assurance_sent_at from public.fnb_order where id = $1;",
      [pedido.id],
    );
    const row = rows[0]!;
    expect(new Date(row.safety_assurance_sent_at).getTime()).toBeGreaterThanOrEqual(new Date(row.kitchen_confirmed_at).getTime());
  });

  it("no se puede confirmar cocina sobre un pedido que no declaró alergia (nada que confirmar)", async () => {
    const pedido = await crearPedido({ items: [{ nombre: "Agua mineral" }] });
    const res = await fixture.app.request(`/hoteles/${hotelId}/pedidos-fnb/${pedido.id}/confirmar-cocina`, {
      method: "POST",
      headers: auth(fnbToken),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
  });

  // AUDITORÍA (8-sep-2026, P0/GOB): confirmado en vivo contra esta misma app que la
  // frase "no tolero los mariscos, me hace mal comerlos" (sin marcar el campo
  // estructurado) daba `alergiaDeclarada=false`/`puedeAsegurarSeguridad=true`, y
  // `POST /asegurar-seguridad` devolvía 200 SIN confirmación humana de cocina --
  // exactamente lo que REQ-AB-004 prohíbe. Extremo a extremo contra la app Hono real:
  // nunca debe volver a devolver 200 sin confirmación para esta ni para otras frases
  // naturales/coloquiales de food-safety.
  it.each([
    "no tolero los mariscos, me hace mal comerlos",
    "me cae mal el camarón, evítenmelo por favor",
    "soy sensible al gluten",
    "me da reacción si el platillo lleva cacahuate",
    "tuve un shock anafiláctico con nueces antes",
  ])(
    'red de seguridad (frase natural/adversarial): "%s" en nota libre marca alergia y BLOQUEA asegurar-seguridad sin confirmación',
    async (nota) => {
      const pedido = await crearPedido({
        items: [{ nombre: "Pasta del día", notas: nota }],
        // alergiaDeclarada NO se marca explícita -- solo va en la nota de texto libre,
        // igual que reportó la auditoría.
      });
      expect(pedido.alergiaDeclarada).toBe(true);
      expect(pedido.alergiaDetectadaVia).toBe("texto_libre");
      expect(pedido.puedeAsegurarSeguridad).toBe(false);
      expect(pedido.mensajeSeguridad).not.toMatch(/es seguro/i);

      const intento = await fixture.app.request(`/hoteles/${hotelId}/pedidos-fnb/${pedido.id}/asegurar-seguridad`, {
        method: "POST",
        headers: auth(fnbToken),
        body: JSON.stringify({}),
      });
      // NUNCA un 200 silencioso sin confirmación humana -- debe rechazarse con 409.
      expect(intento.status).toBe(409);

      const { rows } = await fixture.engine.admin.query<{ safety_assurance_sent_at: string | null }>(
        "select safety_assurance_sent_at::text as safety_assurance_sent_at from public.fnb_order where id = $1;",
        [pedido.id],
      );
      expect(rows[0]!.safety_assurance_sent_at).toBeNull();
    },
  );
});
