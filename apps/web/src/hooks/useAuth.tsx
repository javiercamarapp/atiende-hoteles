import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { borrarSesion, leerSesion, guardarSesion, login as apiLogin, type Sesion } from "../lib/api";

interface AuthContextValue {
  sesion: Sesion | null;
  iniciarSesion: (email: string, password: string) => Promise<void>;
  cerrarSesion: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [sesion, setSesion] = useState<Sesion | null>(() => leerSesion());

  const iniciarSesion = useCallback(async (email: string, password: string) => {
    const nueva = await apiLogin(email, password);
    guardarSesion(nueva);
    setSesion(nueva);
  }, []);

  const cerrarSesion = useCallback(() => {
    borrarSesion();
    setSesion(null);
  }, []);

  const value = useMemo(() => ({ sesion, iniciarSesion, cerrarSesion }), [sesion, iniciarSesion, cerrarSesion]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth debe usarse dentro de <AuthProvider>");
  return ctx;
}

/**
 * Guard de rutas: exige una sesión guardada localmente antes de renderizar
 * pantallas protegidas. No valida el JWT contra el backend en cada
 * navegación (eso corre en cada llamada real a la API vía `ApiUnavailableError`
 * en 401, que cierra la sesión) — es deliberadamente simple porque H3 es
 * solo el frontend; el backend real de auth lo entrega H2/ADR-004.
 */
export function RutaProtegida({ children }: { children: ReactNode }) {
  const { sesion } = useAuth();
  const location = useLocation();
  if (!sesion) {
    return <Navigate to="/login" replace state={{ desde: location.pathname }} />;
  }
  return <>{children}</>;
}
