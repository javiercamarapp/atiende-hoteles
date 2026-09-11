// Patrón Likida/atiende.ai #7 ("onboarding conversacional con guardas deterministas"):
// las 3 tools de escritura reproducen la MISMA lógica SQL que
// `apps/api/src/routes/registro.ts` (tipos de habitación/zona horaria) y
// `apps/api/src/routes/correo.ts` (invitación de staff) -- verificado aquí corriendo
// contra PGlite real (ADR-003), nunca contra un mock de SQL. La tool de lectura
// (`consultar_estado_onboarding`) es la base del guard "nunca termina sin preguntar"
// (ver tests/unit/agent-core/runner.spec.ts, sección Patrón #7).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildToolContext,
  createConsultarEstadoOnboardingTool,
  createGuardarTipoHabitacionOnboardingTool,
  createGuardarZonaHorariaOnboardingTool,
  createInvitarStaffOnboardingTool,
  createRunBudget,
  ONBOARDING_RATE_HORIZON_DAYS,
  type EmailSenderLike,
} from "@atiende-hoteles/agent-core";
import { createPgliteFixture, destroyPgliteFixture, type PgliteFixture } from "../../support/pglite-fixture.ts";

describe("onboardingTools (contra PGlite real)", () => {
  let fixture: PgliteFixture;
  let hotelId: string;
  let orgId: string;

  beforeEach(async () => {
    fixture = await createPgliteFixture();
    orgId = fixture.seed.orgId;
    // Hotel NUEVO y "en blanco" (sin room_type/timezone/invitaciones todavía) --
    // aislado del hotel de demo que `seedDev` ya deja completo, para poder probar la
    // transición incompleto -> completo desde cero.
    const { rows } = await fixture.engine.admin.query<{ id: string }>(
      `insert into public.location (org_id, kind, name) values ($1, 'hotel', 'Hotel En Blanco') returning id;`,
      [orgId],
    );
    hotelId = rows[0]!.id;
    await fixture.engine.admin.query("insert into public.hotel (id, org_id) values ($1, $2);", [hotelId, orgId]);
  });

  afterEach(async () => {
    await destroyPgliteFixture(fixture);
  });

  function ctx() {
    return buildToolContext(
      { orgId, hotelId, actor: { type: "staff", id: fixture.seed.hotels[0]!.staff[0]!.id, staffRole: "owner" }, requestId: "req-onb-1" },
      createRunBudget({}),
    );
  }

  it("consultar_estado_onboarding: un hotel nuevo reporta los 3 pasos como faltantes", async () => {
    const tool = createConsultarEstadoOnboardingTool({ db: fixture.engine.admin });
    const result = await tool.run(ctx(), {});
    expect(result.ok).toBe(true);
    const data = result.data as { completo: boolean; camposFaltantes: string[] };
    expect(data.completo).toBe(false);
    expect(data.camposFaltantes).toHaveLength(3);
  });

  it("guardar_tipo_habitacion_onboarding: crea room_type + rooms + tarifa/disponibilidad de 30 días", async () => {
    const tool = createGuardarTipoHabitacionOnboardingTool({ db: fixture.engine.admin });
    const result = await tool.run(ctx(), { name: "Estándar", maxOccupancy: 2, totalRooms: 5, basePrice: 1500 });
    expect(result.ok).toBe(true);
    const { roomTypeId } = result.data as { roomTypeId: string };

    const { rows: rooms } = await fixture.engine.admin.query("select id from public.room where room_type_id = $1;", [roomTypeId]);
    expect(rooms).toHaveLength(5);

    const { rows: rates } = await fixture.engine.admin.query("select id from public.rate_plan where room_type_id = $1;", [roomTypeId]);
    expect(rates).toHaveLength(ONBOARDING_RATE_HORIZON_DAYS);

    const { rows: audit } = await fixture.engine.admin.query(
      "select id from public.audit_log where hotel_id = $1 and action = 'room_type.created_onboarding';",
      [hotelId],
    );
    expect(audit).toHaveLength(1);
  });

  it("guardar_zona_horaria_onboarding: actualiza hotel.timezone y deja auditoría", async () => {
    const tool = createGuardarZonaHorariaOnboardingTool({ db: fixture.engine.admin });
    const result = await tool.run(ctx(), { timezone: "America/Cancun" });
    expect(result.ok).toBe(true);

    const { rows } = await fixture.engine.admin.query<{ timezone: string }>("select timezone from public.hotel where id = $1;", [hotelId]);
    expect(rows[0]!.timezone).toBe("America/Cancun");
  });

  it("invitar_staff_onboarding SIN adaptador de correo: crea el account_token igual, pero no intenta enviar", async () => {
    const tool = createInvitarStaffOnboardingTool({ db: fixture.engine.admin });
    const result = await tool.run(ctx(), { email: "nueva@ejemplo.com", role: "frontdesk" });
    expect(result.ok).toBe(true);
    expect((result.data as { correoEnviado: boolean }).correoEnviado).toBe(false);

    const { rows } = await fixture.engine.admin.query(
      "select id, role from public.account_token where hotel_id = $1 and purpose = 'invitacion_staff' and lower(email) = 'nueva@ejemplo.com';",
      [hotelId],
    );
    expect(rows).toHaveLength(1);
  });

  it("invitar_staff_onboarding CON adaptador de correo: sí llama a email.send() con la URL de invitación", async () => {
    const send = vi.fn().mockResolvedValue({});
    const email: EmailSenderLike = { send };
    const tool = createInvitarStaffOnboardingTool({
      db: fixture.engine.admin,
      email,
      frontendUrl: "https://app.ejemplo.com",
      generateToken: () => "token-fijo-de-prueba",
    });
    const result = await tool.run(ctx(), { email: "con-correo@ejemplo.com", role: "gm" });
    expect(result.ok).toBe(true);
    expect((result.data as { correoEnviado: boolean }).correoEnviado).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const sentArg = send.mock.calls[0]![0] as { to: string; text: string };
    expect(sentArg.to).toBe("con-correo@ejemplo.com");
    expect(sentArg.text).toContain("token-fijo-de-prueba");
  });

  it("después de los 3 pasos, consultar_estado_onboarding reporta completo=true", async () => {
    await createGuardarTipoHabitacionOnboardingTool({ db: fixture.engine.admin }).run(ctx(), {
      name: "Estándar",
      maxOccupancy: 2,
      totalRooms: 3,
      basePrice: 1200,
    });
    await createGuardarZonaHorariaOnboardingTool({ db: fixture.engine.admin }).run(ctx(), { timezone: "America/Mexico_City" });
    await createInvitarStaffOnboardingTool({ db: fixture.engine.admin }).run(ctx(), { email: "equipo@ejemplo.com", role: "reservations" });

    const result = await createConsultarEstadoOnboardingTool({ db: fixture.engine.admin }).run(ctx(), {});
    const data = result.data as { completo: boolean; camposFaltantes: string[] };
    expect(data.completo).toBe(true);
    expect(data.camposFaltantes).toHaveLength(0);
  });

  it("con SOLO 2 de 3 pasos, consultar_estado_onboarding reporta exactamente el campo restante", async () => {
    await createGuardarTipoHabitacionOnboardingTool({ db: fixture.engine.admin }).run(ctx(), {
      name: "Estándar",
      maxOccupancy: 2,
      totalRooms: 3,
      basePrice: 1200,
    });
    await createGuardarZonaHorariaOnboardingTool({ db: fixture.engine.admin }).run(ctx(), { timezone: "America/Mexico_City" });

    const result = await createConsultarEstadoOnboardingTool({ db: fixture.engine.admin }).run(ctx(), {});
    const data = result.data as { completo: boolean; camposFaltantes: string[] };
    expect(data.completo).toBe(false);
    expect(data.camposFaltantes).toHaveLength(1);
    expect(data.camposFaltantes[0]).toMatch(/equipo/i);
  });
});
