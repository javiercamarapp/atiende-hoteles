// REQ-AB-001 (P1/F): "El menú QR con video debe estar disponible en habitación,
// alberca, camastro, playa y mesa, con reglas de all-inclusive/day-pass y alérgenos
// multilingües, y numeración física única por ubicación codificada en el QR." Página
// pública de UN SOLO destino por QR (mismo patrón que `CheckinPublico.tsx` —
// REQ-RES-016): sin sesión de staff, el huésped llega aquí directo al escanear el QR
// físico plantado en su habitación/alberca/camastro/playa/mesa.
//
// El selector de tarifa es INFORMATIVO -- muestra el precio que le tocaría pagar a
// cada tipo de huésped (todo-incluido/day-pass/a la carta), aplicando exactamente las
// mismas reglas que `resolveMenuForGuest` (packages/domain-hotel/src/menuQr.ts) del
// lado del servidor. La verificación REAL de que un huésped concreto de verdad tiene
// ese plan (para poder cargarlo a folio) es responsabilidad de REQ-AB-002
// (pendiente-credenciales de PMS/POS) -- esta pantalla nunca cobra ni pide un pedido,
// solo informa.
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { AtiendeWordmark } from "@atiende/ui";

const API_BASE_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "");

type FareContext = "all_inclusive" | "day_pass" | "ninguno";
type MenuLanguage = "es" | "en" | "fr";

interface AlergenoResuelto {
  codigo: string;
  etiqueta: string;
}

interface MenuItemPublico {
  id: string;
  name: string;
  description: string | null;
  videoUrl: string;
  precioAPagar: number;
  incluidoEnPlan: boolean;
  alergenos: AlergenoResuelto[];
}

interface MenuPublicoResponse {
  locationCode: string;
  tipoUbicacion: string;
  numeroFisico: number;
  tarifa: FareContext;
  idioma: MenuLanguage;
  items: MenuItemPublico[];
}

const ETIQUETAS_UBICACION: Record<string, string> = {
  habitacion: "Habitación",
  alberca: "Alberca",
  camastro: "Camastro",
  playa: "Playa",
  mesa: "Mesa",
};

const ETIQUETAS_TARIFA: Record<FareContext, string> = {
  ninguno: "A la carta",
  all_inclusive: "Todo incluido",
  day_pass: "Day pass",
};

const IDIOMAS: { codigo: MenuLanguage; etiqueta: string }[] = [
  { codigo: "es", etiqueta: "Español" },
  { codigo: "en", etiqueta: "English" },
  { codigo: "fr", etiqueta: "Français" },
];

// Textos de la pantalla que envuelven directamente a un alérgeno/precio traducido por
// el servidor (`resolveMenuForGuest`) -- deben cambiar de idioma junto con esa
// traducción, o el resultado sería un texto mixto sin sentido (ej. "Contiene: Fish").
// El resto del chrome de la página (encabezados, mensajes de carga/error) se queda en
// español a propósito: el REQ exige alérgenos multilingües, no una traducción completa
// del panel de staff que un huésped nunca ve.
const TEXTOS: Record<MenuLanguage, { contiene: string; incluido: string; sinPlatillos: string }> = {
  es: { contiene: "Contiene", incluido: "Incluido", sinPlatillos: "No hay platillos disponibles para tu tarifa en este momento." },
  en: { contiene: "Contains", incluido: "Included", sinPlatillos: "No dishes are available for your rate right now." },
  fr: { contiene: "Contient", incluido: "Inclus", sinPlatillos: "Aucun plat disponible pour votre tarif en ce moment." },
};

export function MenuPublico() {
  const { locationCode } = useParams<{ locationCode: string }>();
  const [tarifa, setTarifa] = useState<FareContext>("ninguno");
  const [idioma, setIdioma] = useState<MenuLanguage>("es");
  const [menu, setMenu] = useState<MenuPublicoResponse | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!locationCode || !API_BASE_URL) {
      setCargando(false);
      if (!API_BASE_URL) setError("VITE_API_URL no está configurada en este entorno.");
      return;
    }
    setCargando(true);
    const params = new URLSearchParams({ tarifa, idioma });
    fetch(`${API_BASE_URL}/menu/${locationCode}?${params.toString()}`)
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as (MenuPublicoResponse & { message?: string }) | null;
        if (!res.ok) throw new Error(body?.message ?? "No se pudo cargar el menú.");
        setMenu(body);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "No se pudo cargar el menú."))
      .finally(() => setCargando(false));
  }, [locationCode, tarifa, idioma]);

  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto max-w-2xl px-5 py-10 text-[15px] leading-relaxed text-foreground">
        <div className="mb-8">
          <AtiendeWordmark />
        </div>

        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div className="flex gap-2" role="group" aria-label="Idioma del menú">
            {IDIOMAS.map((l) => (
              <button
                key={l.codigo}
                type="button"
                onClick={() => setIdioma(l.codigo)}
                aria-pressed={idioma === l.codigo}
                className={`rounded-md border px-3 py-1 text-sm ${
                  idioma === l.codigo ? "border-primary bg-primary text-primary-foreground" : "border-border"
                }`}
              >
                {l.etiqueta}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Tu tarifa</span>
            <select
              value={tarifa}
              onChange={(e) => setTarifa(e.target.value as FareContext)}
              className="rounded-md border border-border px-2 py-1"
            >
              {(Object.keys(ETIQUETAS_TARIFA) as FareContext[]).map((f) => (
                <option key={f} value={f}>
                  {ETIQUETAS_TARIFA[f]}
                </option>
              ))}
            </select>
          </label>
        </div>

        {cargando && <p className="text-muted-foreground">Cargando menú…</p>}

        {!cargando && error && (
          <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-5 text-foreground">
            <p>{error}</p>
          </div>
        )}

        {!cargando && menu && (
          <>
            <header className="border-b border-border pb-6">
              <p className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Menú digital</p>
              <h1 className="mt-2 font-display text-2xl font-semibold">
                {ETIQUETAS_UBICACION[menu.tipoUbicacion] ?? menu.tipoUbicacion} {menu.numeroFisico}
              </h1>
              <p className="mt-1 font-mono text-xs text-muted-foreground">{menu.locationCode}</p>
            </header>

            {menu.items.length === 0 && <p className="mt-6 text-muted-foreground">{TEXTOS[menu.idioma].sinPlatillos}</p>}

            <ul className="mt-6 flex flex-col gap-8">
              {menu.items.map((item) => (
                <li key={item.id} className="flex flex-col gap-3 border-b border-border pb-8 last:border-none">
                  {/* Video de preparación del platillo, sin diálogo que subtitular --
                      el nombre accesible ya lo aporta aria-label. */}
                  <video
                    src={item.videoUrl}
                    controls
                    playsInline
                    muted
                    className="w-full rounded-md border border-border"
                    aria-label={`Video de ${item.name}`}
                  />
                  <div className="flex items-start justify-between gap-3">
                    <h2 className="font-display text-lg font-semibold">{item.name}</h2>
                    <span className="whitespace-nowrap font-mono text-sm">
                      {item.incluidoEnPlan ? TEXTOS[menu.idioma].incluido : `$${item.precioAPagar.toFixed(2)}`}
                    </span>
                  </div>
                  {item.description && <p className="text-muted-foreground">{item.description}</p>}
                  {item.alergenos.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {TEXTOS[menu.idioma].contiene}: {item.alergenos.map((a) => a.etiqueta).join(", ")}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </main>
  );
}

export default MenuPublico;
