import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { AtiendeMark, AtiendeWordmark } from "@atiende/ui";
import { useAuth } from "../hooks/useAuth";
import { ApiUnavailableError } from "../lib/api";
import "./login.css";

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
  const { iniciarSesion } = useAuth();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { desde?: string } };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setEnviando(true);
    try {
      await iniciarSesion(email, password);
      navigate(location.state?.desde ?? "/resumen", { replace: true });
    } catch (err) {
      if (err instanceof ApiUnavailableError) {
        setError(
          err.pendienteCredenciales
            ? `${err.integracion} está pendiente de credenciales en este entorno: no se puede iniciar sesión todavía.`
            : err.message,
        );
      } else {
        setError("No se pudo iniciar sesión. Inténtalo de nuevo.");
      }
    } finally {
      setEnviando(false);
    }
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

              {error && (
                <div role="alert" className="login-entra mt-9 rounded-[18px] p-5 bg-destructive/5 border border-destructive/30" style={{ animationDelay: "180ms" }}>
                  <p className="text-[14px] leading-relaxed text-foreground">{error}</p>
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

              <p className="login-entra mt-7 text-pretty text-[14px] leading-relaxed text-muted-foreground" style={{ animationDelay: "320ms" }}>
                ¿No tienes acceso?{" "}
                <span className="font-semibold text-foreground">Pídele a la gerencia de tu hotel que te dé de alta.</span>
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
