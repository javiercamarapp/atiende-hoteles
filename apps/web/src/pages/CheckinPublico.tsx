// auditoria-2/legal [ALTO] "El check-in online captura el documento de identidad del
// huésped sin registrar ningún consentimiento" + "no existe página /checkin-publico/:token
// en apps/web/src/App.tsx". Formulario público de UN SOLO USO (REQ-RES-016) sobre
// POST /checkin-publico/:token (apps/api/src/routes/checkinOnline.ts) -- sin sesión de
// staff (el huésped nunca inicia sesión en el panel), con el checkbox de aceptación del
// aviso de privacidad como campo OBLIGATORIO antes de poder enviar (la API ya lo exige
// también del lado del servidor, esto es la superficie visible que faltaba).
import { useEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { AtiendeWordmark } from "@atiende/ui";

const API_BASE_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "");

interface EnlacePublico {
  hotel: string;
  huesped: string | null;
  checkIn: string;
  checkOut: string;
  expiraEn: string;
}

function useSignaturePad() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const [tieneTrazo, setTieneTrazo] = useState(false);

  function posicion(e: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onPointerDown(e: ReactPointerEvent<HTMLCanvasElement>) {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    drawingRef.current = true;
    const { x, y } = posicion(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  }

  function onPointerMove(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const { x, y } = posicion(e);
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#111827";
    ctx.lineTo(x, y);
    ctx.stroke();
    setTieneTrazo(true);
  }

  function onPointerUp() {
    drawingRef.current = false;
  }

  function limpiar() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    setTieneTrazo(false);
  }

  function dataUrl(): string | null {
    if (!tieneTrazo || !canvasRef.current) return null;
    return canvasRef.current.toDataURL("image/png");
  }

  return { canvasRef, onPointerDown, onPointerMove, onPointerUp, limpiar, dataUrl, tieneTrazo };
}

export function CheckinPublico() {
  const { token } = useParams<{ token: string }>();
  const [enlace, setEnlace] = useState<EnlacePublico | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [enviado, setEnviado] = useState(false);
  const [enviando, setEnviando] = useState(false);

  const [nombreCompleto, setNombreCompleto] = useState("");
  const [email, setEmail] = useState("");
  const [telefono, setTelefono] = useState("");
  const [rfc, setRfc] = useState("");
  const [mrzLine1, setMrzLine1] = useState("");
  const [mrzLine2, setMrzLine2] = useState("");
  const [aceptaAviso, setAceptaAviso] = useState(false);

  const firma = useSignaturePad();

  useEffect(() => {
    if (!token || !API_BASE_URL) {
      setCargando(false);
      if (!API_BASE_URL) setError("VITE_API_URL no está configurada en este entorno.");
      return;
    }
    fetch(`${API_BASE_URL}/checkin-publico/${token}`)
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as (EnlacePublico & { message?: string }) | null;
        if (!res.ok) throw new Error(body?.message ?? "No se pudo cargar el enlace de check-in.");
        setEnlace(body);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "No se pudo cargar el enlace de check-in."))
      .finally(() => setCargando(false));
  }, [token]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!token || !API_BASE_URL) return;
    setError(null);

    const firmaDataUrl = firma.dataUrl();
    if (!firmaDataUrl) {
      setError("Falta tu firma de registro.");
      return;
    }
    if (!aceptaAviso) {
      setError("Debes aceptar el aviso de privacidad para continuar.");
      return;
    }

    setEnviando(true);
    try {
      const res = await fetch(`${API_BASE_URL}/checkin-publico/${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          nombreCompleto,
          email: email || undefined,
          telefono: telefono || undefined,
          rfc: rfc || undefined,
          firmaDataUrl,
          mrzLine1,
          mrzLine2,
          consentimientoAvisoPrivacidad: true,
        }),
      });
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      if (!res.ok) throw new Error(body?.message ?? "No se pudo completar el check-in.");
      setEnviado(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo completar el check-in.");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto max-w-xl px-5 py-10 text-[15px] leading-relaxed text-foreground">
        <div className="mb-8">
          <AtiendeWordmark />
        </div>

        {cargando && <p className="text-muted-foreground">Cargando tu enlace de check-in…</p>}

        {!cargando && error && !enlace && (
          <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-5 text-foreground">
            <p>{error}</p>
          </div>
        )}

        {enlace && !enviado && (
          <>
            <header className="pb-6 border-b border-border">
              <p className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                Check-in en línea
              </p>
              <h1 className="mt-2 font-display text-2xl font-semibold">{enlace.hotel}</h1>
              <p className="mt-1 text-muted-foreground">
                {enlace.checkIn} → {enlace.checkOut}
                {enlace.huesped ? ` · ${enlace.huesped}` : ""}
              </p>
            </header>

            <form onSubmit={handleSubmit} className="mt-8 flex flex-col gap-4">
              {error && (
                <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-foreground">
                  {error}
                </div>
              )}

              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium">Nombre completo</span>
                <input
                  required
                  value={nombreCompleto}
                  onChange={(e) => setNombreCompleto(e.target.value)}
                  className="rounded-md border border-border px-3 py-2"
                />
              </label>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <label className="flex flex-col gap-1">
                  <span className="text-sm font-medium">Correo (opcional)</span>
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="rounded-md border border-border px-3 py-2" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-sm font-medium">Teléfono (opcional)</span>
                  <input value={telefono} onChange={(e) => setTelefono(e.target.value)} className="rounded-md border border-border px-3 py-2" />
                </label>
              </div>

              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium">RFC (opcional, para tu factura)</span>
                <input value={rfc} onChange={(e) => setRfc(e.target.value.toUpperCase())} className="rounded-md border border-border px-3 py-2" />
              </label>

              <fieldset className="rounded-md border border-border p-4">
                <legend className="px-1 text-sm font-medium">Documento de identidad (pasaporte, zona MRZ)</legend>
                <p className="mb-2 text-xs text-muted-foreground">
                  Ingresa las dos líneas de la zona legible por máquina (MRZ) de tu pasaporte, exactamente como aparecen impresas.
                </p>
                <div className="flex flex-col gap-2">
                  <input
                    required
                    placeholder="Línea 1 de la MRZ"
                    value={mrzLine1}
                    onChange={(e) => setMrzLine1(e.target.value.toUpperCase())}
                    className="rounded-md border border-border px-3 py-2 font-mono text-sm"
                    maxLength={44}
                  />
                  <input
                    required
                    placeholder="Línea 2 de la MRZ"
                    value={mrzLine2}
                    onChange={(e) => setMrzLine2(e.target.value.toUpperCase())}
                    className="rounded-md border border-border px-3 py-2 font-mono text-sm"
                    maxLength={44}
                  />
                </div>
              </fieldset>

              <fieldset className="rounded-md border border-border p-4">
                <legend className="px-1 text-sm font-medium">Firma de registro</legend>
                <canvas
                  ref={firma.canvasRef}
                  width={480}
                  height={140}
                  className="w-full touch-none rounded-md border border-dashed border-border bg-white"
                  onPointerDown={firma.onPointerDown}
                  onPointerMove={firma.onPointerMove}
                  onPointerUp={firma.onPointerUp}
                  onPointerLeave={firma.onPointerUp}
                />
                <button type="button" onClick={firma.limpiar} className="mt-2 text-xs text-muted-foreground underline">
                  Borrar firma
                </button>
              </fieldset>

              {/* auditoria-2/legal [ALTO]: consentimiento EXPRESO, visible, obligatorio
                 -- ver PRIVACY_NOTICE_VERSION en apps/api/src/routes/checkinOnline.ts. */}
              <label className="flex items-start gap-2 rounded-md border border-border p-4 text-sm">
                <input
                  type="checkbox"
                  required
                  checked={aceptaAviso}
                  onChange={(e) => setAceptaAviso(e.target.checked)}
                  className="mt-1"
                />
                <span>
                  He leído y acepto el{" "}
                  <Link to="/privacidad" target="_blank" rel="noreferrer" className="underline">
                    Aviso de Privacidad
                  </Link>
                  , incluida la transferencia de mi conversación al proveedor de inteligencia artificial y el tratamiento de mi
                  documento de identidad para el registro de mi estancia.
                </span>
              </label>

              <button
                type="submit"
                disabled={enviando || !aceptaAviso}
                className="mt-2 rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-50"
              >
                {enviando ? "Enviando…" : "Completar check-in"}
              </button>
            </form>
          </>
        )}

        {enviado && (
          <div className="rounded-md border border-border p-6">
            <h1 className="font-display text-xl font-semibold">Check-in completado</h1>
            <p className="mt-2 text-muted-foreground">
              Gracias, tu registro quedó completo. Te esperamos en tu fecha de llegada.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}

export default CheckinPublico;
