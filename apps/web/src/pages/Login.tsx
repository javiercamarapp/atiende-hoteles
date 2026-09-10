import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { AtiendeMark, AtiendeWordmark } from "@atiende/ui";
import { useAuth } from "../hooks/useAuth";
import { ApiUnavailableError, reenviarVerificacion, verificarGoogleConfigurado } from "../lib/api";
import "./login.css";

// H12a · mensaje humano por cada `google_error` que `routes/auth-google.ts` puede
// mandar en la redirección de vuelta a `/login?google_error=...` -- nunca se muestra
// el código crudo al usuario.
const MENSAJES_GOOGLE_ERROR: Record<string, string> = {
  parametros_faltantes: "Google no envió los datos esperados. Vuelve a intentarlo.",
  state_invalido: "Tu sesión de Google inició en otra pestaña o expiró. Vuelve a intentarlo desde aquí.",
  state_ya_usado: "Ese enlace de Google ya se usó. Vuelve a intentarlo desde aquí.",
  state_expirado: "Tu sesión de Google venció antes de completarse. Vuelve a intentarlo.",
  nonce_invalido: "No pudimos confirmar tu identidad de Google de forma segura. Vuelve a intentarlo.",
  correo_no_verificado: "Tu cuenta de Google no tiene el correo verificado. Verifícalo en Google e inténtalo de nuevo.",
  cuenta_no_invitada: "No existe ninguna cuenta de staff con ese correo de Google. Pide que te inviten, o regístrate como hotel nuevo.",
  error_desconocido: "No se pudo completar el inicio de sesión con Google. Inténtalo de nuevo.",
};

function mensajeGoogleError(codigo: string): string {
  return MENSAJES_GOOGLE_ERROR[codigo] ?? MENSAJES_GOOGLE_ERROR.error_desconocido!;
}

/**
 * Login del panel hotelero — misma estética que AdminLogin/login.css de
 * atiende-restaurantes (kicker mono, titular serif, píldoras, lámina con
 * gradiente) pero con JWT propio (ADR-004) en vez de Supabase Auth: un
 * formulario de correo+contraseña contra `POST /auth/login` de la API real.
 * Sin backend disponible, el error se declara honestamente (REQ-UX-002),
 * nunca se finge un inicio de sesión exitoso.
 */
export function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [correoSinVerificar, setCorreoSinVerificar] = useState(false);
  const [reenviando, setReenviando] = useState(false);
  const [reenviado, setReenviado] = useState(false);
  const { iniciarSesion } = useAuth();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { desde?: string } };
  const [searchParams] = useSearchParams();

  const [googleConfigurado, setGoogleConfigurado] = useState(false);
  const [comprobandoGoogle, setComprobandoGoogle] = useState(true);

  useEffect(() => {
    let vivo = true;
    verificarGoogleConfigurado().then((ok) => {
      if (vivo) {
        setGoogleConfigurado(ok);
        setComprobandoGoogle(false);
      }
    });
    return () => {
      vivo = false;
    };
  }, []);

  const googleError = searchParams.get("google_error");

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setCorreoSinVerificar(false);
    setReenviado(false);
    setEnviando(true);
    try {
      await iniciarSesion(email, password);
      navigate(location.state?.desde ?? "/resumen", { replace: true });
    } catch (err) {
      if (err instanceof ApiUnavailableError) {
        if (err.status === 403) {
          // H12a: correo de alta autoservicio todavía sin confirmar (ver
          // routes/auth.ts) -- caso distinto del 401 genérico, con su propio botón de
          // reenvío en vez del mensaje de credenciales inválidas.
          setCorreoSinVerificar(true);
          setError(err.message);
        } else {
          setError(
            err.pendienteCredenciales
              ? `${err.integracion} está pendiente de credenciales en este entorno: no se puede iniciar sesión todavía.`
              : err.message,
          );
        }
      } else {
        setError("No se pudo iniciar sesión. Inténtalo de nuevo.");
      }
    } finally {
      setEnviando(false);
    }
  };

  const handleReenviarVerificacion = async () => {
    setReenviando(true);
    try {
      await reenviarVerificacion(email);
      setReenviado(true);
    } finally {
      setReenviando(false);
    }
  };

  const googleHabilitado = googleConfigurado && !comprobandoGoogle;

  const irAGoogle = () => {
    if (!googleHabilitado) return;
    const apiBase = (import.meta.env.VITE_API_URL as string).replace(/\/$/, "");
    window.location.href = `${apiBase}/auth/google/iniciar?purpose=login`;
  };

  return (
    <main className="login min-h-screen lg:grid lg:grid-cols-2">
      <section className="flex min-h-screen flex-col px-6 py-7 sm:px-10 lg:px-14 lg:py-10">
        <div className="mx-auto flex w-full max-w-[392px] flex-1 flex-col">
          <header className="login-entra flex items-center">
            <AtiendeWordmark />
          </header>

          <div className="flex flex-1 items-center py-12">
            <div className="w-full">
              <p className="login-entra login-kicker" style={{ animationDelay: "40ms" }}>
                Acceso al panel
              </p>
              <h1 className="login-entra login-serif mt-5 text-[38px] sm:text-[44px] text-foreground" style={{ animationDelay: "90ms" }}>
                Bienvenido a atiende hoteles
              </h1>
              <p className="login-entra mt-4 text-[15px] leading-[1.6] text-muted-foreground" style={{ animationDelay: "140ms" }}>
                El panel de operación de tu hotel.
              </p>

              {googleError && !error && (
                <div role="alert" className="login-entra mt-9 rounded-[18px] p-5 bg-destructive/5 border border-destructive/30" style={{ animationDelay: "180ms" }}>
                  <p className="text-[14px] leading-relaxed text-foreground">{mensajeGoogleError(googleError)}</p>
                </div>
              )}

              {error && (
                <div role="alert" className="login-entra mt-9 rounded-[18px] p-5 bg-destructive/5 border border-destructive/30" style={{ animationDelay: "180ms" }}>
                  <p className="text-[14px] leading-relaxed text-foreground">{error}</p>
                  {correoSinVerificar && (
                    <p className="mt-2.5 text-[13px] leading-relaxed">
                      {reenviado ? (
                        <span className="text-emerald-600 dark:text-emerald-400">
                          Si tu cuenta seguía pendiente de verificar, te reenviamos el enlace.
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={handleReenviarVerificacion}
                          disabled={reenviando}
                          className="underline underline-offset-2 text-foreground disabled:opacity-60"
                        >
                          {reenviando ? "Reenviando…" : "Reenviar correo de verificación"}
                        </button>
                      )}
                    </p>
                  )}
                </div>
              )}

              <form onSubmit={handleSubmit} className="login-entra mt-9 flex flex-col gap-3" style={{ animationDelay: "220ms" }}>
                <label htmlFor="login-email" className="sr-only">
                  Tu correo
                </label>
                <input
                  id="login-email"
                  type="email"
                  required
                  placeholder="tu@hotel.com"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="login-campo"
                />
                <label htmlFor="login-password" className="sr-only">
                  Contraseña
                </label>
                <input
                  id="login-password"
                  type="password"
                  required
                  placeholder="Contraseña"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="login-campo"
                />
                <button type="submit" disabled={enviando} className="login-btn login-btn-tinta mt-1">
                  <span aria-hidden className="login-glifo">
                    <AtiendeMark className="h-[17px] w-auto brightness-0 invert" />
                  </span>
                  <span>{enviando ? "Entrando…" : "Entrar"}</span>
                </button>
              </form>

              <div className="login-entra my-6 flex items-center gap-4" style={{ animationDelay: "250ms" }}>
                <span className="h-px flex-1 bg-border" />
                <span className="text-[13px] lowercase text-muted-foreground">o</span>
                <span className="h-px flex-1 bg-border" />
              </div>

              <button
                type="button"
                onClick={irAGoogle}
                disabled={!googleHabilitado}
                title={!googleHabilitado ? (comprobandoGoogle ? "Comprobando Google…" : "Google: pendiente de configurar en este entorno.") : undefined}
                className="login-entra login-btn login-btn-borde"
                style={{ animationDelay: "280ms" }}
              >
                <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden="true">
                  <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.71-1.57 2.68-3.89 2.68-6.62z" />
                  <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z" />
                  <path fill="#FBBC05" d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z" />
                  <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.47.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
                </svg>
                Continuar con Google
              </button>
              {!googleHabilitado && (
                <p className="login-entra mt-2 text-[12px] leading-relaxed text-muted-foreground" style={{ animationDelay: "300ms" }}>
                  {comprobandoGoogle ? "Comprobando Google…" : "Google: pendiente de configurar en este entorno."}
                </p>
              )}

              <p className="login-entra mt-7 text-pretty text-[14px] leading-relaxed text-muted-foreground" style={{ animationDelay: "320ms" }}>
                ¿No tienes acceso?{" "}
                <span className="font-semibold text-foreground">Pídele a la gerencia de tu hotel que te dé de alta.</span>
              </p>
              <p className="login-entra mt-2 text-pretty text-[14px] leading-relaxed text-muted-foreground" style={{ animationDelay: "330ms" }}>
                ¿No tienes cuenta?{" "}
                <Link to="/registro" className="font-semibold text-foreground underline underline-offset-2">
                  Registra tu hotel
                </Link>
              </p>

              <p className="login-entra mt-10 text-pretty text-[12px] leading-[1.7] text-muted-foreground" style={{ animationDelay: "360ms" }}>
                Al continuar, aceptas los{" "}
                <Link to="/terminos" className="underline underline-offset-2 text-foreground hover:opacity-70 transition-opacity">
                  Términos de Servicio
                </Link>{" "}
                y el{" "}
                <Link to="/privacidad" className="underline underline-offset-2 text-foreground hover:opacity-70 transition-opacity">
                  Aviso de Privacidad
                </Link>{" "}
                de atiende.ai.
              </p>
            </div>
          </div>
        </div>
      </section>

      <aside className="hidden lg:flex lg:flex-col lg:py-10 lg:pl-6 lg:pr-10">
        <figure className="login-lamina min-h-0 flex-1 flex items-end">
          <img
            src={`${import.meta.env.BASE_URL}images/login-hero.png`}
            alt="Recepción de un hotel boutique vacía en la hora azul."
            className="login-foto-marca absolute inset-0 w-full h-full object-cover"
          />
          <div className="login-velo" />
          <figcaption className="p-9 z-10">
            <p className="login-kicker" style={{ color: "color-mix(in srgb, white 78%, transparent)" }}>
              Reservas y operación por WhatsApp
            </p>
            <p className="login-serif mt-3.5 text-white" style={{ fontSize: "clamp(20px, 1.9vw, 27px)" }}>
              Hoteles boutique en México.
              <br />
              El cierre del turno, solo.
            </p>
          </figcaption>
        </figure>
      </aside>
    </main>
  );
}
