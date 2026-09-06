// H12a · REQ-LAUNCH: alta autoservicio de un hotel nuevo (POST /registro,
// routes/registro.ts) y alta vía Google (routes/auth-google.ts, `purpose=registro`)
// comparten EXACTAMENTE esta transacción -- nunca se duplica la lógica de crear
// org+location+hotel+config fiscal+política de cancelación+owner+membresía.
//
// Se ejecuta como UN SOLO statement SQL (una cadena de CTEs de escritura encadenadas)
// en vez de un BEGIN/COMMIT explícito de varias sentencias: `engine.admin` es una
// ÚNICA conexión compartida por todo el proceso (ver packages/db/src/engines.ts,
// `EmbeddedPostgresEngine.admin`), nunca un pool -- dos llamadas concurrentes a este
// helper con BEGIN/COMMIT explícitos correrían intercaladas sobre la MISMA conexión
// física y corromperían ambas transacciones. Un único statement con CTEs de datos
// (`with x as (insert ... returning ...)`) es atómico por definición en Postgres (todo
// el statement es una transacción implícita), sin depender de aislar la conexión.
import type { DbClient } from "@atiende-hoteles/db";
import { Errors } from "./errors.ts";

export interface CrearHotelAutoservicioInput {
  hotelName: string;
  city: string;
  stateName: string;
  ownerEmail: string;
  ownerFullName: string;
  /** `null` cuando el alta viene de Google (sin contraseña, ver auth-google.ts). */
  passwordHash: string | null;
  createdVia: "registro_autoservicio" | "google";
  /** `true` cuando el correo ya viene verificado por el proveedor (Google ya validó
   *  `email_verified` en el id_token) -- una alta por contraseña SIEMPRE llega en
   *  `false` (REQ-LAUNCH: verificación de correo obligatoria antes de poder operar). */
  emailAlreadyVerified: boolean;
}

export interface HotelAutoservicioCreado {
  orgId: string;
  hotelId: string;
  locationId: string;
  staffUserId: string;
}

/** REQ-LAUNCH: un mismo correo no puede dar de alta dos hoteles nuevos por
 *  autoservicio si YA existe una cuenta de staff con ese correo (evita duplicar
 *  `staff_user.email`, que es UNIQUE, y produce un mensaje honesto en vez del error
 *  crudo de restricción de unicidad de Postgres). */
export async function existeCuentaConCorreo(db: DbClient, email: string): Promise<boolean> {
  const { rows } = await db.query<{ id: string }>("select id from public.staff_user where email = $1;", [email]);
  return rows.length > 0;
}

export async function crearHotelAutoservicio(
  db: DbClient,
  input: CrearHotelAutoservicioInput,
): Promise<HotelAutoservicioCreado> {
  if (await existeCuentaConCorreo(db, input.ownerEmail)) {
    throw Errors.conflict("Ya existe una cuenta con este correo. Inicia sesión en vez de registrarte de nuevo.");
  }

  const { rows } = await db.query<{
    org_id: string;
    location_id: string;
    hotel_id: string;
    staff_user_id: string;
  }>(
    `with new_org as (
       insert into public.org (name) values ($1) returning id
     ),
     new_location as (
       insert into public.location (org_id, kind, name, city, state_name)
       select id, 'hotel', $1, $2, $3 from new_org
       returning id, org_id
     ),
     new_hotel as (
       insert into public.hotel (id, org_id)
       select id, org_id from new_location
       returning id, org_id
     ),
     new_tax_config as (
       insert into public.hotel_tax_config (hotel_id, tenant_id, state_code)
       select id, org_id, $3 from new_hotel
       returning hotel_id
     ),
     new_cancellation_policy as (
       insert into public.hotel_cancellation_policy (hotel_id, tenant_id)
       select id, org_id from new_hotel
       returning hotel_id
     ),
     new_staff as (
       insert into public.staff_user (email, full_name, password_hash, created_via, email_verified_at)
       values ($4, $5, $6, $7, case when $8 then now() else null end)
       returning id
     ),
     new_membership as (
       insert into public.hotel_staff (org_id, hotel_id, user_id, role)
       select new_hotel.org_id, new_hotel.id, new_staff.id, 'owner'
       from new_hotel, new_staff
       returning hotel_id
     )
     select new_org.id as org_id, new_location.id as location_id, new_hotel.id as hotel_id, new_staff.id as staff_user_id
     from new_org, new_location, new_hotel, new_staff, new_membership, new_tax_config, new_cancellation_policy;`,
    [
      input.hotelName,
      input.city,
      input.stateName,
      input.ownerEmail,
      input.ownerFullName,
      input.passwordHash,
      input.createdVia,
      input.emailAlreadyVerified,
    ],
  );

  const row = rows[0];
  if (!row) throw Errors.internal("No se pudo crear el hotel: la transacción de alta no devolvió ninguna fila.");

  return { orgId: row.org_id, hotelId: row.hotel_id, locationId: row.location_id, staffUserId: row.staff_user_id };
}
