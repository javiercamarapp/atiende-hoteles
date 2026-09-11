// REQ-AB-001 (P1/F): "El menú QR con video debe estar disponible en habitación,
// alberca, camastro, playa y mesa, con reglas de all-inclusive/day-pass y alérgenos
// multilingües, y numeración física única por ubicación codificada en el QR."
//
// Dos superficies:
//   * Gestión de staff (autenticada, rol owner/gm/fnb): dar de alta platillos del menú
//     (`/hoteles/:hotelId/menu-items`) y registrar ubicaciones físicas donde se planta
//     un QR (`/hoteles/:hotelId/menu-qr/ubicaciones`) -- esta última devuelve el
//     `locationCode`/`qrTargetUrl` que hay que imprimir.
//   * Lectura pública SIN sesión (`GET /menu/:locationCode`): el huésped escanea el QR
//     y nunca inicia sesión en el panel -- mismo patrón que
//     `experienciasPublicasRoutes` (REQ-TEN-004): usa `deps.engine.admin` (sin RLS de
//     staff) detrás de funciones SECURITY DEFINER que ya acotan qué columnas exponen
//     (migración 0153).
//
// Fuera de alcance (REQ-AB-002, pendiente-credenciales de PMS/POS): tomar el pedido
// desde esta pantalla, enrutarlo a KDS o cargarlo a folio -- este REQ es únicamente la
// superficie de lectura del menú con sus reglas ya aplicadas.
import { Hono } from "hono";
import { z } from "zod";
import {
  ALLERGEN_CODES,
  LOCATION_TYPES,
  SUPPORTED_MENU_LANGUAGES,
  buildLocationCode,
  buildMenuQrTargetUrl,
  resolveMenuForGuest,
  type AllergenCode,
  type FareContext,
  type MenuItemCatalog,
  type MenuLanguage,
} from "@atiende-hoteles/domain-hotel";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

// Quién puede dar de alta/editar el menú y las ubicaciones físicas de QR -- decisión
// de contenido/precio (igual que `experience_catalog`, migración 0050) más el rol
// operativo real de F&B (igual que `fnb_order`, migración 0084).
const GESTIONAR_MENU_ROLES = ["owner", "gm", "fnb"] as const;

const FARE_CONTEXTS: readonly FareContext[] = ["all_inclusive", "day_pass", "ninguno"];

function parseFareContext(raw: string | undefined): FareContext {
  if (!raw) return "ninguno";
  if ((FARE_CONTEXTS as readonly string[]).includes(raw)) return raw as FareContext;
  throw Errors.validation(`tarifa: debe ser una de ${FARE_CONTEXTS.join(", ")}.`);
}

function parseLang(raw: string | undefined): MenuLanguage {
  if (!raw) return "es";
  if ((SUPPORTED_MENU_LANGUAGES as readonly string[]).includes(raw)) return raw as MenuLanguage;
  throw Errors.validation(`idioma: debe ser uno de ${SUPPORTED_MENU_LANGUAGES.join(", ")}.`);
}

const crearMenuItemSchema = z.object({
  nombre: z.string().trim().min(1).max(150),
  descripcion: z.string().trim().max(1000).optional(),
  // `.max(4000)`, no 2000: un `videoUrl` real hospedado (Cloudinary/S3/etc.) nunca se
  // acerca a ese límite, pero un `data:video/mp4;base64,...` autocontenido (el único
  // video que `tests/e2e/menu-qr.spec.ts` puede sembrar sin depender de un host externo
  // en CI, fixture de ~2.2 KB reales -> ~2978 chars en base64+prefijo) sí lo excedía --
  // `video_url` es `text` sin límite en Postgres (migración 0153), así que este cap es
  // puramente de saneamiento de payload, no de almacenamiento.
  videoUrl: z.string().trim().url().max(4000),
  precio: z.number().finite().min(0),
  incluidoEnTodoIncluido: z.boolean().default(false),
  disponibleDayPass: z.boolean().default(true),
  recargoDayPass: z.number().finite().min(0).default(0),
  alergenos: z.array(z.enum(ALLERGEN_CODES)).default([]),
});

const crearUbicacionSchema = z.object({
  tipoUbicacion: z.enum(LOCATION_TYPES),
  numeroFisico: z.number().int().positive(),
});

interface MenuItemRow {
  id: string;
  name: string;
  description: string | null;
  video_url: string;
  price: string;
  all_inclusive_included: boolean;
  day_pass_available: boolean;
  day_pass_surcharge: string;
  allergens: AllergenCode[];
  active: boolean;
  created_at: string;
}

function serializeMenuItem(r: MenuItemRow) {
  return {
    id: r.id,
    nombre: r.name,
    descripcion: r.description,
    videoUrl: r.video_url,
    precio: Number(r.price),
    incluidoEnTodoIncluido: r.all_inclusive_included,
    disponibleDayPass: r.day_pass_available,
    recargoDayPass: Number(r.day_pass_surcharge),
    alergenos: r.allergens,
    activo: r.active,
    creadoEn: r.created_at,
  };
}

interface UbicacionRow {
  id: string;
  location_type: string;
  physical_number: number;
  location_code: string;
  active: boolean;
  created_at: string;
}

function serializeUbicacion(r: UbicacionRow, publicBaseUrl: string) {
  return {
    id: r.id,
    tipoUbicacion: r.location_type,
    numeroFisico: r.physical_number,
    locationCode: r.location_code,
    qrTargetUrl: buildMenuQrTargetUrl(publicBaseUrl, r.location_code),
    activo: r.active,
    creadoEn: r.created_at,
  };
}

export function menuQrRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  // Mismo `deps.env.frontendUrl` que `registro.ts`/`correo.ts`/`mensajeria.ts` usan
  // para construir enlaces públicos absolutos (FRONTEND_URL o, si no está definida,
  // el primer origen de CORS) -- el guest-facing `/menu/:locationCode` vive en ese
  // mismo frontend (App.tsx), así que reusa la misma fuente de verdad en vez de
  // inventar una variable de entorno nueva.
  const publicBaseUrl = deps.env.frontendUrl;

  app.use(
    "/hoteles/:hotelId/menu-items/*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );
  app.use(
    "/hoteles/:hotelId/menu-items",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );
  app.use(
    "/hoteles/:hotelId/menu-qr/*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );
  app.use(
    "/hoteles/:hotelId/menu-qr",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  // ---------------------------------------------------------------------------
  // Gestión de staff
  // ---------------------------------------------------------------------------
  app.get("/hoteles/:hotelId/menu-items", async (c) => {
    const db = c.get("db");
    const { rows } = await db.query<MenuItemRow>(
      `select id, name, description, video_url, price::text as price, all_inclusive_included,
              day_pass_available, day_pass_surcharge::text as day_pass_surcharge, allergens, active,
              created_at::text as created_at
       from public.menu_item
       where hotel_id = $1
       order by name;`,
      [c.req.param("hotelId")],
    );
    return c.json(rows.map(serializeMenuItem));
  });

  app.post("/hoteles/:hotelId/menu-items", async (c) => {
    assertRole(c, [...GESTIONAR_MENU_ROLES]);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const orgId = c.get("orgId");
    const body = parseBody(crearMenuItemSchema, await c.req.json().catch(() => ({})));

    const { rows } = await db.query<MenuItemRow>(
      `insert into public.menu_item
         (tenant_id, hotel_id, name, description, video_url, price, all_inclusive_included,
          day_pass_available, day_pass_surcharge, allergens, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       returning id, name, description, video_url, price::text as price, all_inclusive_included,
                 day_pass_available, day_pass_surcharge::text as day_pass_surcharge, allergens, active,
                 created_at::text as created_at;`,
      [
        orgId,
        hotelId,
        body.nombre,
        body.descripcion ?? null,
        body.videoUrl,
        body.precio,
        body.incluidoEnTodoIncluido,
        body.disponibleDayPass,
        body.recargoDayPass,
        body.alergenos,
        c.get("userId"),
      ],
    );

    return c.json(serializeMenuItem(rows[0]!), 201);
  });

  app.get("/hoteles/:hotelId/menu-qr/ubicaciones", async (c) => {
    const db = c.get("db");
    const { rows } = await db.query<UbicacionRow>(
      `select id, location_type, physical_number, location_code, active, created_at::text as created_at
       from public.menu_qr_location
       where hotel_id = $1
       order by location_type, physical_number;`,
      [c.req.param("hotelId")],
    );
    return c.json(rows.map((r) => serializeUbicacion(r, publicBaseUrl)));
  });

  // Da de alta una ubicación física de QR y devuelve el `locationCode`/`qrTargetUrl`
  // listos para imprimir (REQ-AB-001: "numeración física única por ubicación
  // codificada en el QR"). El código se calcula en dominio (`buildLocationCode`,
  // determinístico) -- el índice único `menu_qr_location(location_code)` es la
  // garantía de fondo si dos requests concurrentes reclamaran la misma numeración.
  app.post("/hoteles/:hotelId/menu-qr/ubicaciones", async (c) => {
    assertRole(c, [...GESTIONAR_MENU_ROLES]);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const orgId = c.get("orgId");
    const body = parseBody(crearUbicacionSchema, await c.req.json().catch(() => ({})));
    const locationCode = buildLocationCode(hotelId, body.tipoUbicacion, body.numeroFisico);

    try {
      const { rows } = await db.query<UbicacionRow>(
        `insert into public.menu_qr_location (tenant_id, hotel_id, location_type, physical_number, location_code, created_by)
         values ($1, $2, $3, $4, $5, $6)
         returning id, location_type, physical_number, location_code, active, created_at::text as created_at;`,
        [orgId, hotelId, body.tipoUbicacion, body.numeroFisico, locationCode, c.get("userId")],
      );
      return c.json(serializeUbicacion(rows[0]!, publicBaseUrl), 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/duplicate key|unique constraint/i.test(message)) {
        throw Errors.conflict(`Ya existe un QR registrado para ${body.tipoUbicacion} número ${body.numeroFisico} en este hotel.`);
      }
      throw err;
    }
  });

  // ---------------------------------------------------------------------------
  // Lectura pública -- el huésped escanea el QR, sin sesión de staff.
  // ---------------------------------------------------------------------------
  app.get("/menu/:locationCode", async (c) => {
    const locationCode = c.req.param("locationCode");
    const fareContext = parseFareContext(c.req.query("tarifa"));
    const lang = parseLang(c.req.query("idioma"));

    const { rows: locationRows } = await deps.engine.admin.query<{
      hotel_id: string;
      location_type: string;
      physical_number: number;
    }>("select * from public.resolve_menu_location_public($1);", [locationCode]);

    if (locationRows.length === 0) {
      throw Errors.notFound("Este código de menú no existe o ya no está activo.");
    }
    const location = locationRows[0]!;

    const { rows: itemRows } = await deps.engine.admin.query<{
      id: string;
      name: string;
      description: string | null;
      video_url: string;
      price: string;
      all_inclusive_included: boolean;
      day_pass_available: boolean;
      day_pass_surcharge: string;
      allergens: AllergenCode[];
    }>("select * from public.list_menu_items_public($1);", [location.hotel_id]);

    const catalog: MenuItemCatalog[] = itemRows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      videoUrl: r.video_url,
      price: Number(r.price),
      allInclusiveIncluded: r.all_inclusive_included,
      dayPassAvailable: r.day_pass_available,
      dayPassSurcharge: Number(r.day_pass_surcharge),
      allergens: r.allergens,
    }));

    const items = resolveMenuForGuest(catalog, fareContext, lang);

    return c.json({
      locationCode,
      tipoUbicacion: location.location_type,
      numeroFisico: location.physical_number,
      tarifa: fareContext,
      idioma: lang,
      items,
    });
  });

  return app;
}
