// Seeds de desarrollo (H1): 1 org con 2 hoteles, 2 tipos de habitacion por hotel, 5
// habitaciones por tipo, tarifa + disponibilidad para 30 dias, y 2 usuarios por hotel con
// roles distintos (uno con acceso a dinero, otro sin el) para poder ejercitar de
// inmediato las pruebas de aislamiento/roles de tests/unit y tests/integration.

import type { DbClient } from "./types.ts";
import { hashPassword } from "./password.ts";

export interface SeedHotel {
  id: string;
  name: string;
  roomTypes: { id: string; name: string; price: number }[];
  staff: { id: string; email: string; role: string }[];
}

export interface SeedResult {
  orgId: string;
  hotels: SeedHotel[];
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function isoDate(daysFromNow: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  const parts = d.toISOString().split("T");
  return parts[0] as string;
}

const AVAILABILITY_HORIZON_DAYS = 30;
const ROOMS_PER_TYPE = 5;

/** Contraseña de desarrollo para TODOS los usuarios sembrados (H2/ADR-004). Documentada
 *  también en apps/api/README.md — nunca se usa fuera de PGlite/embedded-postgres. */
export const DEV_SEED_PASSWORD = "atiende-dev-2026";

/** Inserta los datos de desarrollo. Debe correr con un cliente admin (superusuario del
 *  motor, ver engines.ts) para no depender de RLS/roles durante el seed. */
export async function seedDev(db: DbClient): Promise<SeedResult> {
  const orgRes = await db.query<{ id: string }>(
    "insert into public.org (name) values ($1) returning id;",
    ["Grupo Demo Atiende Hoteles"],
  );
  const orgId = orgRes.rows[0]!.id;

  const hotelDefs = [
    { name: "Hotel Demo Centro" },
    { name: "Hotel Demo Playa" },
  ];

  const roomTypeDefs = [
    { name: "Estandar", maxOccupancy: 2, price: 1200 },
    { name: "Suite", maxOccupancy: 4, price: 2500 },
  ];

  // Los 8 roles exactos de REQ-TEN-003/ADR-004, uno por hotel, para poder ejercitar la
  // matriz completa de permisos en tests/adversarial (H2) ademas de las pruebas de RLS
  // de H1 que ya usaban solo gm/housekeeping (siguen encontrando esos dos roles aqui).
  const staffDefs: { role: string; label: string }[] = [
    { role: "owner", label: "Propietario" },
    { role: "gm", label: "Gerencia" },
    { role: "frontdesk", label: "Recepción" },
    { role: "reservations", label: "Reservaciones" },
    { role: "housekeeping", label: "Camarista" },
    { role: "maintenance", label: "Mantenimiento" },
    { role: "fnb", label: "Alimentos y Bebidas" },
    { role: "accountant", label: "Contabilidad" },
  ];

  const hotels: SeedHotel[] = [];
  const devPasswordHash = await hashPassword(DEV_SEED_PASSWORD);

  for (const hotelDef of hotelDefs) {
    const locationRes = await db.query<{ id: string }>(
      "insert into public.location (org_id, kind, name) values ($1, 'hotel', $2) returning id;",
      [orgId, hotelDef.name],
    );
    const hotelId = locationRes.rows[0]!.id;
    await db.query("insert into public.hotel (id, org_id) values ($1, $2);", [hotelId, orgId]);

    const roomTypes: SeedHotel["roomTypes"] = [];
    for (const rt of roomTypeDefs) {
      const rtRes = await db.query<{ id: string }>(
        "insert into public.room_type (tenant_id, hotel_id, name, max_occupancy) values ($1, $2, $3, $4) returning id;",
        [orgId, hotelId, rt.name, rt.maxOccupancy],
      );
      const roomTypeId = rtRes.rows[0]!.id;
      roomTypes.push({ id: roomTypeId, name: rt.name, price: rt.price });

      for (let i = 1; i <= ROOMS_PER_TYPE; i += 1) {
        const code = `${rt.name.slice(0, 3).toUpperCase()}-${i}`;
        await db.query(
          "insert into public.room (tenant_id, hotel_id, room_type_id, code) values ($1, $2, $3, $4);",
          [orgId, hotelId, roomTypeId, code],
        );
      }

      for (let day = 0; day < AVAILABILITY_HORIZON_DAYS; day += 1) {
        const date = isoDate(day);
        await db.query(
          "insert into public.rate_plan (tenant_id, hotel_id, room_type_id, date, price) values ($1, $2, $3, $4, $5);",
          [orgId, hotelId, roomTypeId, date, rt.price],
        );
        await db.query(
          "insert into public.availability (tenant_id, hotel_id, room_type_id, date, total_rooms) values ($1, $2, $3, $4, $5);",
          [orgId, hotelId, roomTypeId, date, ROOMS_PER_TYPE],
        );
      }
    }

    const staff: SeedHotel["staff"] = [];
    const hotelSlug = slugify(hotelDef.name);
    for (const s of staffDefs) {
      const email = `${s.role}@${hotelSlug}.demo`;
      const userRes = await db.query<{ id: string }>(
        "insert into public.staff_user (email, full_name, password_hash) values ($1, $2, $3) returning id;",
        [email, `${s.label} — ${hotelDef.name}`, devPasswordHash],
      );
      const userId = userRes.rows[0]!.id;
      await db.query(
        "insert into public.hotel_staff (org_id, hotel_id, user_id, role) values ($1, $2, $3, $4);",
        [orgId, hotelId, userId, s.role],
      );
      staff.push({ id: userId, email, role: s.role });
    }

    // H4 · Impuestos y política de cancelación por hotel (REQ-REV-001/REQ-RES-004):
    // se siembran explícitamente en vez de confiar solo en los DEFAULT de la columna
    // para que el panel de configuración tenga algo real que listar/editar desde el
    // primer arranque, nunca un "sin dato" fabricado.
    await db.query(
      "insert into public.hotel_tax_config (hotel_id, tenant_id, iva_rate, ish_rate) values ($1, $2, 0.16, 0.03);",
      [hotelId, orgId],
    );
    await db.query(
      `insert into public.hotel_cancellation_policy
         (hotel_id, tenant_id, free_until_hours, penalty_pct, no_show_pct, deposit_pct)
       values ($1, $2, 24, 50, 100, 20);`,
      [hotelId, orgId],
    );

    hotels.push({ id: hotelId, name: hotelDef.name, roomTypes, staff });
  }

  return { orgId, hotels };
}
