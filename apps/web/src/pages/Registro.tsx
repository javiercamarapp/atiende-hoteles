import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { AtiendeMark, AtiendeWordmark } from "@atiende/ui";
import { ApiUnavailableError, registrarHotel, reenviarVerificacion, verificarGoogleConfigurado } from "../lib/api";
import "./login.css";

// H12a · REQ-LAUNCH: alta autoservicio de un hotel nuevo. Lista simple y hardcodeada de
// los 32 estados de México (nunca hace falta un catálogo del backend para esto, es
// dato estático).
const ESTADOS_MEXICO = [
  "Aguascalientes",
  "Baja California",
  "Baja California Sur",
  "Campeche",
  "Chiapas",
  "Chihuahua",
  "Ciudad de México",
  "Coahuila",
  "Colima",
  "Durango",
  "Estado de México",
  "Guanajuato",
  "Guerrero",
  "Hidalgo",
  "Jalisco",
  "Michoacán",
  "Morelos",
  "Nayarit",
  "Nuevo León",
  "Oaxaca",
  "Puebla",
  "Querétaro",
  "Quintana Roo",
  "San Luis Potosí",
  "Sinaloa",
  "Sonora",
  "Tabasco",
  "Tamaulipas",
  "Tlaxcala",
  "Veracruz",
  "Yucatán",
  "Zacatecas",
];

function validarPassword(password: string): string | null {
  if (password.length < 10) return "La contraseña debe tener al menos 10 caracteres.";
  if (!/[A-Za-z]/.test(password)) return "La contraseña debe incluir al menos una letra.";
  if (!/[0-9]/.test(password)) return "La contraseña debe incluir al menos un número.";
  return null;
}

/**
 * Alta autoservicio de un hotel nuevo (`POST /registro`) — mismo sistema visual que
 * Login.tsx (login.css). El backend es la autoridad real de validación; el cliente
 * valida ANTES de enviar solo para dar retroalimentación inmediata (mismas reglas
 * exactas que apps/api/src/routes/registro.ts, `registroSchema`).
 */
export function Registro() {
  const [hotelName, setHotelName] = useState("");
  const [city, setCity] = useState("");
  const [stateName, setStateName] = useState("");
  const [ownerFullName, setOwnerFullName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revisaCorreo, setRevisaCorreo] = useState(false);

  const [reenviando, setReenviando] = useState(false);
  const [reenviado, setReenviado] = useState(false);

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

  const camposHotelListos = hotelName.trim().length >= 2 && city.trim().length >= 2 && stateName.trim().length >= 2;
  const googleHabilitado = googleConfigurado && camposHotelListos && !comprobandoGoogle;

  function textoGoogleDeshabilitado(): string {
    if (comprobandoGoogle) return "Comprobando Google…";
    if (!googleConfigurado) return "Google: pendiente de configurar en este entorno.";
    return "Completa nombre del hotel, ciudad y estado para continuar con Google.";
  }

  function irAGoogle() {
    if (!googleHabilitado) return;
    const params = new URLSearchParams({
      purpose: "registro",
      hotelName: hotelName.trim(),
      city: city.trim(),
      stateName: stateName.trim(),
    });
    window.location.href = `${(import.meta.env.VITE_API_URL as string).replace(/\/$/, "")}/auth/google/iniciar?${params.toString()}`;
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!camposHotelListos) {
      setError("El nombre del hotel, la ciudad y el estado deben tener al menos 2 caracteres.");
      return;
    }
    if (ownerFullName.trim().length < 2) {
      setError("Escribe tu nombre completo.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Las contraseñas no coinciden.");
      return;
    }
    const errorPassword = validarPassword(password);
    if (errorPassword) {
      setError(errorPassword);
      return;
    }

    setEnviando(true);
    try {
      await registrarHotel({
        hotelName: hotelName.trim(),
        city: city.trim(),
        stateName: stateName.trim(),
        ownerFullName: ownerFullName.trim(),
        ownerEmail: ownerEmail.trim(),
        password,
      });
      setRevisaCorreo(true);
    } catch (err) {
      if (err instanceof ApiUnavailableError) {
        setError(
          err.pendienteCredenciales
            ? `${err.integracion} está pendiente de credenciales en este entorno: no se puede crear tu cuenta todavía.`
            : err.message,
        );
      } else {
        setError("No se pudo crear tu cuenta. Inténtalo de nuevo.");
      }
    } finally {
      setEnviando(false);
    }
  };

  const handleReenviar = async () => {
    setReenviando(true);
    try {
      await reenviarVerificacion(ownerEmail.trim());
      setReenviado(true);
    } catch {
      // El endpoint es genérico (nunca revela si el correo existe) — un fallo de red
      // aquí se declara honestamente en vez de fingir éxito.
      setError("No se pudo reenviar el correo. Verifica tu conexión e inténtalo de nuevo.");
    } finally {
      setReenviando(false);
    }
  };

  return (
    <main className="login min-h-screen lg:grid lg:grid-cols-2">
      <section className="flex min-h-screen flex-col px-6 py-7 sm:px-10 lg:px-14 lg:py-10">
        <div className="mx-auto flex w-full max-w-[440px] flex-1 flex-col">
          <header className="login-entra flex items-center">
            <AtiendeWordmark />
          </header>

          <div className="flex flex-1 items-center py-12">
            <div className="w-full">
              <p className="login-entra login-kicker" style={{ animationDelay: "40ms" }}>
                Alta de un hotel nuevo
              </p>
              <h1 className="login-entra login-serif mt-5 text-[34px] sm:text-[40px] text-foreground" style={{ animationDelay: "90ms" }}>
                Registra tu hotel
              </h1>
              <p className="login-entra mt-4 text-[15px] leading-[1.6] text-muted-foreground" style={{ animationDelay: "140ms" }}>
                Da de alta tu cuenta y la de tu hotel en unos minutos. Después podrás invitar a tu equipo.
              </p>

              {revisaCorreo ? (
                <div role="status" className="login-entra mt-9 rounded-[18px] p-5 bg-muted border border-border" style={{ animationDelay: "190ms" }}>
                  <p className="text-[15px] font-semibold text-foreground">Revisa tu correo.</p>
                  <p className="mt-1.5 text-[14px] leading-relaxed text-muted-foreground">
                    Te mandamos un enlace a <span className="font-medium text-foreground">{ownerEmail}</span> para confirmar tu cuenta antes de
                    poder iniciar sesión.
                  </p>
                  {reenviado ? (
                    <p className="mt-3 text-[13px] leading-relaxed text-emerald-600 dark:text-emerald-400">
                      Si tu cuenta seguía pendiente de verificar, te reenviamos el enlace.
                    </p>
                  ) : (
                    <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">
                      ¿No llega?{" "}
                      <button type="button" onClick={handleReenviar} disabled={reenviando} className="underline underline-offset-2 disabled:opacity-60">
                        {reenviando ? "Reenviando…" : "Reenviar correo"}
                      </button>
                    </p>
                  )}
                  <p className="mt-4 text-[13px] leading-relaxed">
                    <Link to="/login" className="underline underline-offset-2 text-foreground">
                      Ir a iniciar sesión
                    </Link>
                  </p>
                </div>
              ) : (
                <>
                  {error && (
                    <div role="alert" className="login-entra mt-9 rounded-[18px] p-5 bg-destructive/5 border border-destructive/30" style={{ animationDelay: "180ms" }}>
                      <p className="text-[14px] leading-relaxed text-foreground">{error}</p>
                    </div>
                  )}

                  <form onSubmit={handleSubmit} className="login-entra mt-9 flex flex-col gap-3" style={{ animationDelay: "220ms" }}>
                    <label htmlFor="reg-hotel" className="sr-only">
                      Nombre del hotel
                    </label>
                    <input
                      id="reg-hotel"
                      type="text"
                      required
                      placeholder="Nombre del hotel"
                      value={hotelName}
                      onChange={(e) => setHotelName(e.target.value)}
                      className="login-campo"
                    />
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label htmlFor="reg-ciudad" className="sr-only">
                          Ciudad
                        </label>
                        <input
                          id="reg-ciudad"
                          type="text"
                          required
                          placeholder="Ciudad"
                          value={city}
                          onChange={(e) => setCity(e.target.value)}
                          className="login-campo"
                        />
                      </div>
                      <div>
                        <label htmlFor="reg-estado" className="sr-only">
                          Estado
                        </label>
                        <select
                          id="reg-estado"
                          required
                          value={stateName}
                          onChange={(e) => setStateName(e.target.value)}
                          className="login-campo"
                        >
                          <option value="" disabled>
                            Estado
                          </option>
                          {ESTADOS_MEXICO.map((estado) => (
                            <option key={estado} value={estado}>
                              {estado}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <label htmlFor="reg-nombre" className="sr-only">
                      Tu nombre completo
                    </label>
                    <input
                      id="reg-nombre"
                      type="text"
                      required
                      placeholder="Tu nombre completo"
                      autoComplete="name"
                      value={ownerFullName}
                      onChange={(e) => setOwnerFullName(e.target.value)}
                      className="login-campo"
                    />
                    <label htmlFor="reg-email" className="sr-only">
                      Tu correo
                    </label>
                    <input
                      id="reg-email"
                      type="email"
                      required
                      placeholder="tu@hotel.com"
                      autoComplete="email"
                      value={ownerEmail}
                      onChange={(e) => setOwnerEmail(e.target.value)}
                      className="login-campo"
                    />
                    <label htmlFor="reg-password" className="sr-only">
                      Contraseña
                    </label>
                    <input
                      id="reg-password"
                      type="password"
                      required
                      placeholder="Contraseña (mínimo 10 caracteres, una letra y un número)"
                      autoComplete="new-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="login-campo"
                    />
                    <label htmlFor="reg-password-confirm" className="sr-only">
                      Confirma tu contraseña
                    </label>
                    <input
                      id="reg-password-confirm"
                      type="password"
                      required
                      placeholder="Confirma tu contraseña"
                      autoComplete="new-password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      className="login-campo"
                    />
                    <button type="submit" disabled={enviando} className="login-btn login-btn-tinta mt-1">
                      <span aria-hidden className="login-glifo">
                        <AtiendeMark className="h-[17px] w-auto brightness-0 invert" />
                      </span>
                      <span>{enviando ? "Creando tu cuenta…" : "Crear mi cuenta"}</span>
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
                    title={!googleHabilitado ? textoGoogleDeshabilitado() : undefined}
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
                      {textoGoogleDeshabilitado()}
                    </p>
                  )}

                  <p className="login-entra mt-7 text-pretty text-[14px] leading-relaxed text-muted-foreground" style={{ animationDelay: "320ms" }}>
                    ¿Ya tienes cuenta? <Link to="/login" className="font-semibold text-foreground underline underline-offset-2">Inicia sesión</Link>
                  </p>
                </>
              )}

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
              Da de alta tu hotel hoy.
              <br />
              Invita a tu equipo en minutos.
            </p>
          </figcaption>
        </figure>
      </aside>
    </main>
  );
}

export default Registro;
