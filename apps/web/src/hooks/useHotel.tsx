import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { listarHoteles, type Hotel } from "../lib/api";
import { useAuth } from "./useAuth";

const CLAVE_HOTEL = "atiende-hoteles-hotel-activo";

interface HotelContextValue {
  hoteles: Hotel[];
  hotelActivoId: string | null;
  seleccionarHotel: (id: string) => void;
  cargando: boolean;
  error: Error | null;
}

const HotelContext = createContext<HotelContextValue | null>(null);

export function HotelProvider({ children }: { children: ReactNode }) {
  // `HotelProvider` envuelve TODA la app, incluida /login (App.tsx): sin gatear esta
  // query a que exista sesión, dispararía GET /hoteles sin token en cuanto se monta,
  // recibiría 401 y (con `retry:false`) react-query dejaría esa consulta cacheada como
  // error para siempre bajo la misma `queryKey` -- ni el login exitoso posterior la
  // reintenta automáticamente (no hay remount ni invalidación). La `queryKey` incluye
  // el token para que iniciar sesión cuente como una consulta NUEVA (nunca reutiliza el
  // error pre-login) y `enabled` evita la llamada mientras no hay sesión.
  const { sesion } = useAuth();
  const { data, isLoading, error } = useQuery({
    queryKey: ["hoteles", sesion?.token],
    queryFn: listarHoteles,
    enabled: Boolean(sesion),
    retry: false,
  });

  const hoteles = useMemo(() => data ?? [], [data]);
  const [hotelActivoId, setHotelActivoId] = useState<string | null>(() => window.localStorage.getItem(CLAVE_HOTEL));

  useEffect(() => {
    if (!hotelActivoId && hoteles.length > 0) {
      setHotelActivoId(hoteles[0].id);
    }
  }, [hoteles, hotelActivoId]);

  const seleccionarHotel = (id: string) => {
    window.localStorage.setItem(CLAVE_HOTEL, id);
    setHotelActivoId(id);
  };

  const value = useMemo(
    () => ({ hoteles, hotelActivoId, seleccionarHotel, cargando: isLoading, error: error as Error | null }),
    [hoteles, hotelActivoId, isLoading, error],
  );

  return <HotelContext.Provider value={value}>{children}</HotelContext.Provider>;
}

export function useHotel() {
  const ctx = useContext(HotelContext);
  if (!ctx) throw new Error("useHotel debe usarse dentro de <HotelProvider>");
  return ctx;
}
