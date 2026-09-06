import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { listarHoteles, type Hotel } from "../lib/api";

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
  const { data, isLoading, error } = useQuery({
    queryKey: ["hoteles"],
    queryFn: listarHoteles,
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
