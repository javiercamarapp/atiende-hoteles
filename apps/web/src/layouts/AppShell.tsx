import { Outlet } from "react-router-dom";
import {
  LayoutDashboard,
  CalendarCheck,
  CalendarRange,
  Users,
  BellRing,
  Sparkles,
  Wrench,
  UtensilsCrossed,
  MessageCircle,
  Star,
  Building2,
  Settings,
  ShieldCheck,
  Bot,
  CreditCard,
} from "lucide-react";
import { Sidebar, BottomNav, MobileHeader, AtiendeWordmark, type SidebarSection, type BottomNavItem } from "@atiende/ui";
import { useAuth } from "../hooks/useAuth";
import { useHotel } from "../hooks/useHotel";
import { ApiUnavailableError } from "../lib/api";
import { SelectorHotel } from "../components/SelectorHotel";
import { AprobacionesBadge } from "../components/AprobacionesBadge";
import { NotificacionesBell } from "../components/NotificacionesBell";
import { CookieConsentBanner } from "../components/CookieConsentBanner";

// Mapa de navegación hotelero (docs/referencia/05-frontend-restaurantes.md
// §5) — misma anatomía de acordeón/colapso que AdminSidebar de Restaurantes,
// grupos adaptados al dominio de hotel en vez de restaurante.
const sections: SidebarSection[] = [
  {
    title: "ANÁLISIS",
    siempreAbierto: true,
    items: [{ to: "/resumen", label: "Resumen", icon: LayoutDashboard }],
  },
  {
    title: "OPERACIÓN",
    items: [
      { to: "/reservas", label: "Reservas", icon: CalendarCheck },
      { to: "/disponibilidad", label: "Disponibilidad", icon: CalendarRange },
      { to: "/recepcion", label: "Recepción", icon: BellRing },
    ],
  },
  {
    title: "SERVICIOS",
    items: [
      { to: "/housekeeping", label: "Housekeeping", icon: Sparkles },
      { to: "/mantenimiento", label: "Mantenimiento", icon: Wrench },
      { to: "/alimentos-bebidas", label: "Alimentos y Bebidas", icon: UtensilsCrossed },
    ],
  },
  {
    title: "HUÉSPEDES",
    items: [
      { to: "/huespedes", label: "Huéspedes", icon: Users },
      { to: "/mensajeria", label: "Mensajería", icon: MessageCircle },
      { to: "/reputacion", label: "Reputación", icon: Star },
    ],
  },
  {
    title: "ADMINISTRAR",
    items: [
      { to: "/aprobaciones", label: "Aprobaciones", icon: ShieldCheck },
      { to: "/agentes", label: "Agentes", icon: Bot },
      { to: "/back-office", label: "Back office", icon: Building2 },
      { to: "/suscripcion", label: "Suscripción", icon: CreditCard },
      { to: "/configuracion", label: "Configuración", icon: Settings },
    ],
  },
];

// Bottom-nav móvil real (cierra el hueco de 05§2.5/§2.6): subconjunto
// operativo para personal en tablet/celular (recepción/housekeeping/
// mantenimiento), no los 12 módulos completos — un bottom-nav con más de
// 5 ítems deja de ser usable con el pulgar.
const itemsMovil: BottomNavItem[] = [
  { to: "/resumen", label: "Inicio", icon: LayoutDashboard },
  { to: "/recepcion", label: "Recepción", icon: BellRing },
  { to: "/housekeeping", label: "Housekeeping", icon: Sparkles },
  { to: "/mantenimiento", label: "Mantenimiento", icon: Wrench },
  { to: "/mensajeria", label: "Mensajes", icon: MessageCircle },
];

/**
 * REQ-UX-002 (hallazgo real, verificado con `tests/e2e/estados-vacios-honestos.spec.ts`):
 * cuando `GET /hoteles` (useHotel) falla -- API caída, sesión inválida, o SIN
 * `VITE_API_URL` configurada -- `hotelActivoId` nunca se resuelve, así que TODAS las
 * queries de cada pantalla (`enabled: Boolean(hotelActivoId)`) se quedan deshabilitadas
 * para siempre: nunca corren, nunca entran en `isError`, y `DataState` termina
 * mostrando su `mensajeVacio` genérico ("No hay reservas/huéspedes/tickets registrados
 * todavía...") -- una atribución falsa, indistinguible de un hotel real vacío, para lo
 * que en realidad es un bloqueo de credenciales/conexión a nivel de toda la app. Antes
 * de este fix el único indicio era el badge "Sin hoteles" del selector, con el motivo
 * real escondido en un `title` (tooltip) que nadie ve sin pasar el mouse. Este banner,
 * en el layout que envuelve TODAS las pantallas protegidas, hace visible la causa real
 * una sola vez, arriba del contenido de cada página.
 */
function BannerHotelesBloqueado() {
  const { error, cargando } = useHotel();
  if (cargando || !error) return null;
  const err = error instanceof ApiUnavailableError ? error : null;

  return (
    <div role="alert" className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
      <p className="font-medium">
        {err?.pendienteCredenciales
          ? `${err.integracion} está pendiente de credenciales.`
          : `No se pudo conectar con ${err?.integracion ?? "la API de Atiende Hoteles"}.`}
      </p>
      <p className="mt-0.5 text-destructive/90">
        No se pudo cargar la lista de hoteles de tu organización todavía -- las pantallas de abajo no pueden mostrar
        datos reales de ningún hotel hasta que esto se resuelva. Esto NO significa que el hotel esté vacío.
      </p>
    </div>
  );
}

export function AppShell() {
  const { sesion, cerrarSesion } = useAuth();

  return (
    <div className="min-h-screen bg-background flex w-full">
      <a
        href="#contenido-principal"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[100] focus:rounded-md focus:bg-primary focus:text-primary-foreground focus:px-4 focus:py-2"
      >
        Saltar al contenido principal
      </a>

      <div className="hidden md:block p-3">
        <Sidebar
          sections={sections}
          user={sesion ? { email: sesion.email, rol: sesion.rol } : null}
          onLogout={cerrarSesion}
          hotelSelector={<SelectorHotel />}
        />
      </div>

      <MobileHeader
        title={<AtiendeWordmark className="scale-90 origin-left" />}
        action={
          <div className="flex items-center gap-2">
            <NotificacionesBell />
            <AprobacionesBadge />
            <SelectorHotel />
          </div>
        }
      />

      <div className="flex-1 flex flex-col min-w-0">
        <header className="hidden md:flex items-center justify-end gap-3 px-6 py-3">
          <NotificacionesBell />
          <AprobacionesBadge />
          <span className="text-sm text-muted-foreground">{sesion?.email}</span>
        </header>
        <main id="contenido-principal" tabIndex={-1} className="flex-1 px-4 py-4 pt-20 pb-24 md:pt-2 md:pb-8 md:px-6">
          <div className="max-w-6xl mx-auto w-full">
            <BannerHotelesBloqueado />
            <Outlet />
          </div>
        </main>
      </div>

      <BottomNav items={itemsMovil} />
      <CookieConsentBanner />
    </div>
  );
}
