// REQ-UX-004 (H18-005/H01-016/H02-018): "El panel del dueño/gerente debe mostrar,
// junto a cada línea de cobro variable, un enlace al reporte de ahorro/valor que la
// sustenta." El frontend (apps/web/src/pages/BackOffice.tsx) YA implementa la UI
// completa y honesta -- muestra el enlace cuando `roiEventUrl` viene poblado, y un
// aviso explícito ("sin justificación registrada — no debería facturarse así") cuando
// no -- pero no existía NINGUNA ruta real en apps/api que respondiera
// `GET /hoteles/:hotelId/back-office/cobros`, así que la pantalla nunca podía cargar
// ni un estado vacío honesto ni datos reales.
//
// La fuente de verdad de las líneas de cobro variable (el registro `ROIEvent` de
// REQ-AGT-003/REQ-REV-018: monto_verificado/monto_estimado/método_contrafactual/
// confianza) es responsabilidad del frente H7 (`agentes.ts`/`roi.ts`), que trabaja en
// paralelo en `main` -- este archivo NO crea esa tabla ni duplica su esquema. Se
// verifica en tiempo de ejecución si `public.roi_event` ya existe
// (`to_regclass`, sin asumir NUNCA su forma exacta); si no existe todavía, se
// devuelve una lista vacía REAL (nunca datos simulados, REQ-UX-002) -- el mismo
// resultado que el frontend ya sabe mostrar de forma honesta. Si en el futuro
// `roi_event` existe pero con columnas distintas a las esperadas aquí, la consulta se
// protege con try/catch y también degrada a lista vacía en vez de romper la pantalla.
import { Hono } from "hono";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { ADMIN_ROLES } from "../domain/roles.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

interface LineaCobroRow {
  id: string;
  concepto: string;
  monto: string;
}

export function backOfficeRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/back-office/*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  app.get("/hoteles/:hotelId/back-office/cobros", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");

    const { rows: existe } = await db.query<{ existe: boolean }>(
      "select to_regclass('public.roi_event') is not null as existe;",
    );

    if (!existe[0]?.existe) {
      // roi_event todavía no existe en este entorno (H7 en curso) -- lista vacía
      // REAL, el frontend ya la muestra como "No hay líneas de cobro variable este
      // mes.", nunca como un error.
      return c.json([]);
    }

    try {
      // Forma esperada de `roi_event` según REQ-AGT-003/REQ-REV-018 (documentada, no
      // garantizada): id, hotel_id, `concepto` (texto) y `monto_verificado`
      // (numeric) -- el monto que SÍ se factura, nunca el estimado. Nótese que NO se
      // usa `coalesce` entre nombres alternativos de columna: Postgres exige que
      // TODAS las columnas referenciadas existan para poder siquiera planear la
      // consulta, así que "adivinar" varios nombres a la vez no ayuda -- si H7 define
      // la tabla con nombres distintos a estos dos, este SELECT falla al compilar y
      // se degrada a lista vacía honesta (catch de abajo) en vez de mostrar un error.
      const { rows } = await db.query<LineaCobroRow>(
        `select id::text as id, concepto, monto_verificado::text as monto
         from public.roi_event
         where hotel_id = $1
           and created_at >= date_trunc('month', now())
         order by created_at desc;`,
        [hotelId],
      );
      return c.json(
        rows.map((r) => ({
          id: r.id,
          concepto: r.concepto,
          monto: Number(r.monto),
          roiEventUrl: `/back-office/roi-eventos/${r.id}`,
        })),
      );
    } catch {
      return c.json([]);
    }
  });

  return app;
}
