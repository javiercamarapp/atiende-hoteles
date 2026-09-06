import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider, Toaster } from "@atiende/ui";
import { AuthProvider } from "./hooks/useAuth";
import { HotelProvider } from "./hooks/useHotel";
import { RutaProtegida } from "./hooks/useAuth";
import { AppShell } from "./layouts/AppShell";
import { Login } from "./pages/Login";
import { Registro } from "./pages/Registro";
import { VerificarCorreo } from "./pages/VerificarCorreo";
import { AceptarInvitacion } from "./pages/AceptarInvitacion";
import { GoogleCallback } from "./pages/GoogleCallback";
import { Onboarding } from "./pages/Onboarding";
import { NotFound } from "./pages/NotFound";
import { Privacidad } from "./pages/Privacidad";
import { CheckinPublico } from "./pages/CheckinPublico";
import { Terminos } from "./pages/Terminos";
import { Resumen } from "./pages/Resumen";
import { Reservas } from "./pages/Reservas";
import { Disponibilidad } from "./pages/Disponibilidad";
import { Huespedes } from "./pages/Huespedes";
import { Recepcion } from "./pages/Recepcion";
import { Housekeeping } from "./pages/Housekeeping";
import { Mantenimiento } from "./pages/Mantenimiento";
import { AlimentosBebidas } from "./pages/AlimentosBebidas";
import { Mensajeria } from "./pages/Mensajeria";
import { Reputacion } from "./pages/Reputacion";
import { BackOffice } from "./pages/BackOffice";
import { Aprobaciones } from "./pages/Aprobaciones";
import { Configuracion } from "./pages/Configuracion";
import { Agentes } from "./pages/Agentes";
import { AdminLayout } from "./pages/admin/AdminLayout";
import { AdminNegocio } from "./pages/admin/AdminNegocio";
import { AdminCostoIA } from "./pages/admin/AdminCostoIA";
import { AdminSalud } from "./pages/admin/AdminSalud";
import { AdminAuditoria } from "./pages/admin/AdminAuditoria";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthProvider>
          <HotelProvider>
            <BrowserRouter>
              <Routes>
                <Route path="/" element={<Navigate to="/resumen" replace />} />
                <Route path="/login" element={<Login />} />
                <Route path="/registro" element={<Registro />} />
                <Route path="/registro/verificar" element={<VerificarCorreo />} />
                <Route path="/registro/invitacion" element={<AceptarInvitacion />} />
                <Route path="/auth/google/callback" element={<GoogleCallback />} />
                <Route path="/terminos" element={<Terminos />} />
                <Route path="/privacidad" element={<Privacidad />} />
                <Route path="/checkin-publico/:token" element={<CheckinPublico />} />

                <Route
                  path="/onboarding"
                  element={
                    <RutaProtegida>
                      <Onboarding />
                    </RutaProtegida>
                  }
                />

                <Route
                  element={
                    <RutaProtegida>
                      <AppShell />
                    </RutaProtegida>
                  }
                >
                  <Route path="/resumen" element={<Resumen />} />
                  <Route path="/reservas" element={<Reservas />} />
                  <Route path="/disponibilidad" element={<Disponibilidad />} />
                  <Route path="/huespedes" element={<Huespedes />} />
                  <Route path="/recepcion" element={<Recepcion />} />
                  <Route path="/housekeeping" element={<Housekeeping />} />
                  <Route path="/mantenimiento" element={<Mantenimiento />} />
                  <Route path="/alimentos-bebidas" element={<AlimentosBebidas />} />
                  <Route path="/mensajeria" element={<Mensajeria />} />
                  <Route path="/reputacion" element={<Reputacion />} />
                  <Route path="/back-office" element={<BackOffice />} />
                  <Route path="/aprobaciones" element={<Aprobaciones />} />
                  <Route path="/agentes" element={<Agentes />} />
                  <Route path="/configuracion" element={<Configuracion />} />
                </Route>

                {/* H12b · LAUNCH-007: consola superadmin cross-tenant, deliberadamente
                    FUERA de <AppShell> (sin selector de hotel, sin sidebar operativo) --
                    solo exige sesión (RutaProtegida); la autorización real de "eres
                    superadmin de plataforma" la impone la API (apps/api/src/routes/admin.ts,
                    403 explícito) y cada subpágina la refleja vía DataState/EstadoError. */}
                <Route
                  path="/admin"
                  element={
                    <RutaProtegida>
                      <AdminLayout />
                    </RutaProtegida>
                  }
                >
                  <Route index element={<AdminNegocio />} />
                  <Route path="costo-ia" element={<AdminCostoIA />} />
                  <Route path="salud" element={<AdminSalud />} />
                  <Route path="auditoria" element={<AdminAuditoria />} />
                </Route>

                <Route path="*" element={<NotFound />} />
              </Routes>
            </BrowserRouter>
            <Toaster />
          </HotelProvider>
        </AuthProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
