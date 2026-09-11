// REQ-RES-013 (docs/ACEPTACION.md): "...ninguna propuesta de RFP sale sin un registro
// de validación humana previa (0 propuestas sin ese registro)." Verificado aquí contra
// Postgres REAL (embedded-postgres, ADR-003) escribiendo SQL DIRECTO bajo una sesión de
// staff autenticada real (`withAppSession`, RLS activa) -- nunca por la ruta HTTP
// (`routes/grupos.ts` ya se prueba en `tests/integration/grupos/seguimiento.spec.ts`):
// `packages/db/migrations/0130_seguimiento_solicitud_grupo.sql`
// (`propuesta_rfp_guard`) es la autoridad de verdad, no la aplicación -- ningún actor,
// ni siquiera uno con permiso RLS de INSERT sobre `propuesta_rfp` (owner/gm/frontdesk/
// reservations), puede saltarse el gate escribiendo la fila a mano. Mismo criterio de
// prueba que `tests/adversarial/roi-sin-linea-base.spec.ts` (trigger como gate real,
// discrimina de verdad -- se prueban también los casos que SÍ deben permitirse, no solo
// los que se rechazan).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgFixture, destroyPgFixture, type PgFixture } from "../support/pg-fixture.ts";

describe("adversarial: 0 propuestas de RFP sin un registro de validación humana previo (REQ-RES-013)", () => {
  let fixture: PgFixture;
  let orgId: string;
  let hotelId: string;
  let reservationsId: string;

  beforeAll(async () => {
    fixture = await createPgFixture();
    const hotel = fixture.seed.hotels[0]!;
    orgId = fixture.seed.orgId;
    hotelId = hotel.id;
    reservationsId = hotel.staff.find((s) => s.role === "reservations")!.id;
  });

  afterAll(async () => {
    await destroyPgFixture(fixture);
  });

  async function crearSolicitud(descripcion: string): Promise<string> {
    const { rows } = await fixture.engine.withAppSession({ userId: reservationsId }, (db) =>
      db.query<{ id: string }>(
        `insert into public.solicitud_grupo (org_id, hotel_id, organizador_nombre, organizador_telefono, descripcion)
         values ($1, $2, 'Organizador de prueba', '+525500000000', $3)
         returning id;`,
        [orgId, hotelId, descripcion],
      ),
    );
    return rows[0]!.id;
  }

  async function crearValidacion(solicitudId: string, validadoEn: Date): Promise<string> {
    const { rows } = await fixture.engine.withAppSession({ userId: reservationsId }, (db) =>
      db.query<{ id: string }>(
        `insert into public.validacion_humana_rfp (solicitud_id, validado_por, validado_en)
         values ($1, $2, $3) returning id;`,
        [solicitudId, reservationsId, validadoEn.toISOString()],
      ),
    );
    return rows[0]!.id;
  }

  function insertarPropuesta(params: { solicitudId: string; validacionHumanaId: string; enviadoEn: Date }) {
    return fixture.engine.withAppSession({ userId: reservationsId }, (db) =>
      db.query(
        `insert into public.propuesta_rfp (solicitud_id, validacion_humana_id, contenido, enviado_por, enviado_en)
         values ($1, $2, 'Propuesta de prueba', $3, $4);`,
        [params.solicitudId, params.validacionHumanaId, reservationsId, params.enviadoEn.toISOString()],
      ),
    );
  }

  it("rechaza un id de validación humana que no existe -- 0 propuestas insertadas", async () => {
    const solicitudId = await crearSolicitud("Sin validación alguna");
    await expect(
      insertarPropuesta({ solicitudId, validacionHumanaId: randomUUID(), enviadoEn: new Date() }),
    ).rejects.toThrow(/validacion_humana_no_encontrada/);

    const { rows } = await fixture.engine.admin.query<{ n: string }>(
      "select count(*)::text as n from public.propuesta_rfp where solicitud_id = $1;",
      [solicitudId],
    );
    expect(rows[0]!.n).toBe("0");
  });

  it("rechaza una validación que pertenece a OTRA solicitud de grupo -- 0 propuestas insertadas", async () => {
    const solicitudA = await crearSolicitud("Solicitud A");
    const solicitudB = await crearSolicitud("Solicitud B");
    const validacionDeA = await crearValidacion(solicitudA, new Date(Date.now() - 60_000));

    await expect(
      insertarPropuesta({ solicitudId: solicitudB, validacionHumanaId: validacionDeA, enviadoEn: new Date() }),
    ).rejects.toThrow(/validacion_no_corresponde_a_solicitud/);

    const { rows } = await fixture.engine.admin.query<{ n: string }>(
      "select count(*)::text as n from public.propuesta_rfp where solicitud_id = $1;",
      [solicitudB],
    );
    expect(rows[0]!.n).toBe("0");
  });

  it("rechaza una validación fechada DESPUÉS del envío de la propuesta -- 0 propuestas insertadas", async () => {
    const solicitudId = await crearSolicitud("Validación tardía");
    const enviadoEn = new Date("2026-03-01T10:00:00.000Z");
    const validadoEn = new Date("2026-03-01T10:00:01.000Z"); // 1s DESPUÉS del envío
    const validacionId = await crearValidacion(solicitudId, validadoEn);

    await expect(insertarPropuesta({ solicitudId, validacionHumanaId: validacionId, enviadoEn })).rejects.toThrow(
      /validacion_posterior_al_envio/,
    );

    const { rows } = await fixture.engine.admin.query<{ n: string }>(
      "select count(*)::text as n from public.propuesta_rfp where solicitud_id = $1;",
      [solicitudId],
    );
    expect(rows[0]!.n).toBe("0");
  });

  it("el gate DISCRIMINA de verdad: permite la propuesta cuando la validación es real, de la misma solicitud, y previa al envío", async () => {
    const solicitudId = await crearSolicitud("Validación correcta");
    const validadoEn = new Date("2026-03-01T09:00:00.000Z");
    const enviadoEn = new Date("2026-03-01T10:00:00.000Z");
    const validacionId = await crearValidacion(solicitudId, validadoEn);

    await insertarPropuesta({ solicitudId, validacionHumanaId: validacionId, enviadoEn });

    const { rows } = await fixture.engine.admin.query<{ validacion_humana_id: string }>(
      "select validacion_humana_id from public.propuesta_rfp where solicitud_id = $1;",
      [solicitudId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.validacion_humana_id).toBe(validacionId);
  });

  it("una validación fechada en el MISMO instante del envío se acepta como previa (límite inclusivo)", async () => {
    const solicitudId = await crearSolicitud("Validación simultánea");
    const instante = new Date("2026-03-02T00:00:00.000Z");
    const validacionId = await crearValidacion(solicitudId, instante);

    await insertarPropuesta({ solicitudId, validacionHumanaId: validacionId, enviadoEn: instante });

    const { rows } = await fixture.engine.admin.query<{ n: string }>(
      "select count(*)::text as n from public.propuesta_rfp where solicitud_id = $1;",
      [solicitudId],
    );
    expect(rows[0]!.n).toBe("1");
  });
});
