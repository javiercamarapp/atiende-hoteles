import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { EstadoCargando, EstadoError, AtiendeWordmark } from "@atiende/ui";
import { ApiUnavailableError, reenviarVerificacion, verificarCorreo } from "../lib/api";
import "./login.css";

type Estado = "cargando" | "exito" | "error";

/**
 * `/registro/verificar?token=...` — confirma el correo de una cuenta recién dada de
 * alta (`POST /registro/verificar`). Llama a la API automáticamente al montar: no hay
 * ninguna acción manual que pedirle al usuario, el enlace del correo ya trae el token.
 */
export function VerificarCorreo() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");

  const [estado, setEstado] = useState<Estado>("cargando");
  const [mensaje, setMensaje] = useState<string>("");

  const [email, setEmail] = useState("");
  const [reenviando, setReenviando] = useState(false);
  const [reenviado, setReenviado] = useState(false);

  // `account_token` es de un solo uso real (backend): React 18 StrictMode (dev)
  // invoca los efectos dos veces a propósito para detectar side-effects impuros -- sin
  // este guard, la segunda invocación consumiría un token ya usado por la primera y
  // mostraría "ya se usó" incluso en un enlace legítimo.
  const yaLlamado = useRef(false);

  useEffect(() => {
    if (!token) {
      setEstado("error");
      setMensaje("Este enlace no incluye un token de verificación. Revisa que copiaste la URL completa del correo.");
      return;
    }
    // Guard SOLO para evitar una segunda llamada real (React 18 StrictMode en dev
    // invoca los efectos dos veces) -- a propósito NO se descarta el resultado con un
    // flag de "cleanup" tipo `vivo`: `account_token` es de un solo uso real, así que la
    // ÚNICA llamada que de verdad sale a la red debe poder actualizar el estado cuando
    // responda, incluso si el efecto que la disparó ya se "limpió" en el remount falso
    // de StrictMode (un descarte aquí dejaría la pantalla en "Confirmando…" para
    // siempre pese a que el backend sí confirmó el correo).
    if (yaLlamado.current) return;
    yaLlamado.current = true;
    verificarCorreo(token)
      .then(() => {
        setEstado("exito");
      })
      .catch((err) => {
        setEstado("error");
        if (err instanceof ApiUnavailableError) {
          setMensaje(
            err.pendienteCredenciales
              ? `${err.integracion} está pendiente de credenciales en este entorno: no se pudo confirmar tu correo.`
              : err.message,
          );
        } else {
          setMensaje("No se pudo confirmar tu correo. Inténtalo de nuevo.");
        }
      });
  }, [token]);

  const handleReenviar = async () => {
    setReenviando(true);
    try {
      await reenviarVerificacion(email.trim());
      setReenviado(true);
    } finally {
      setReenviando(false);
    }
  };

  return (
    <main className="login flex min-h-screen flex-col items-center justify-center px-6 py-10">
      <div className="mb-10">
        <AtiendeWordmark />
      </div>
      <div className="w-full max-w-[440px]">
        {estado === "cargando" && <EstadoCargando etiqueta="Confirmando tu correo…" />}

        {estado === "exito" && (
          <div role="status" className="rounded-[18px] p-6 bg-muted border border-border text-center">
            <p className="text-[16px] font-semibold text-foreground">Correo confirmado.</p>
            <p className="mt-2 text-[14px] leading-relaxed text-muted-foreground">Ya puedes iniciar sesión con tu cuenta.</p>
            <Link to="/login" className="login-btn login-btn-tinta mt-6 inline-flex">
              Ir a iniciar sesión
            </Link>
          </div>
        )}

        {estado === "error" && (
          <div>
            <EstadoError titulo="No se pudo confirmar tu correo" mensaje={mensaje} />
            <div className="mt-6 rounded-[18px] p-5 bg-card border border-border">
              <p className="text-[13px] text-muted-foreground">
                Si tu enlace venció o ya se usó, pide que te reenvíen uno nuevo con tu correo.
              </p>
              {reenviado ? (
                <p className="mt-3 text-[13px] text-emerald-600 dark:text-emerald-400">
                  Si existe una cuenta pendiente de verificar con ese correo, te reenviamos el enlace.
                </p>
              ) : (
                <form
                  className="mt-3 flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void handleReenviar();
                  }}
                >
                  <label htmlFor="reenviar-email" className="sr-only">
                    Tu correo
                  </label>
                  <input
                    id="reenviar-email"
                    type="email"
                    required
                    placeholder="tu@hotel.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="login-campo"
                  />
                  <button type="submit" disabled={reenviando} className="login-btn login-btn-borde whitespace-nowrap">
                    {reenviando ? "Enviando…" : "Reenviar"}
                  </button>
                </form>
              )}
            </div>
            <p className="mt-6 text-center text-[14px]">
              <Link to="/login" className="underline underline-offset-2 text-foreground">
                Ir a iniciar sesión
              </Link>
            </p>
          </div>
        )}
      </div>
    </main>
  );
}

export default VerificarCorreo;
