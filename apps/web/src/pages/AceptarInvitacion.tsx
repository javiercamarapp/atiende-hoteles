import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { AtiendeMark, AtiendeWordmark, EstadoCargando, EstadoError } from "@atiende/ui";
import { ApiUnavailableError, aceptarInvitacion } from "../lib/api";
import "./login.css";

type Estado = "comprobando" | "necesita-cuenta" | "error";

/**
 * `/registro/invitacion?token=...` — acepta una invitación de staff
 * (`POST /registro/invitacion/aceptar`). Intenta primero SIN `fullName`/`password`
 * automáticamente al montar (funciona sola si la persona invitada ya tenía cuenta): el
 * backend responde 400 (validation_error, "se requieren fullName y password") solo
 * cuando de verdad hace falta crear la cuenta, y ahí se muestra el formulario mínimo.
 */
export function AceptarInvitacion() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");
  const navigate = useNavigate();

  const [estado, setEstado] = useState<Estado>("comprobando");
  const [mensajeError, setMensajeError] = useState<string>("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [errorFormulario, setErrorFormulario] = useState<string | null>(null);

  // `account_token` es de un solo uso real: StrictMode (dev) invoca los efectos dos
  // veces a propósito -- sin este guard, el segundo intento automático consumiría (o
  // vería consumido) el token del primero y mostraría un rechazo falso.
  const yaIntentado = useRef(false);

  useEffect(() => {
    if (!token) {
      setEstado("error");
      setMensajeError("Este enlace no incluye un token de invitación. Revisa que copiaste la URL completa del correo.");
      return;
    }
    if (yaIntentado.current) return;
    yaIntentado.current = true;

    aceptarInvitacion({ token })
      .then(() => {
        navigate("/login", { replace: true, state: { mensaje: "Invitación aceptada. Ya puedes iniciar sesión." } });
      })
      .catch((err) => {
        if (err instanceof ApiUnavailableError && err.status === 400) {
          // Persona invitada sin cuenta todavía: el backend exige fullName+password.
          setEstado("necesita-cuenta");
          return;
        }
        setEstado("error");
        if (err instanceof ApiUnavailableError) {
          setMensajeError(
            err.pendienteCredenciales
              ? `${err.integracion} está pendiente de credenciales en este entorno: no se pudo aceptar la invitación.`
              : err.message,
          );
        } else {
          setMensajeError("No se pudo aceptar la invitación. Inténtalo de nuevo.");
        }
      });
  }, [token, navigate]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setErrorFormulario(null);
    if (fullName.trim().length < 2) {
      setErrorFormulario("Escribe tu nombre completo.");
      return;
    }
    if (password.length < 10 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
      setErrorFormulario("La contraseña debe tener al menos 10 caracteres, con una letra y un número.");
      return;
    }
    setEnviando(true);
    aceptarInvitacion({ token: token as string, fullName: fullName.trim(), password })
      .then(() => {
        navigate("/login", { replace: true, state: { mensaje: "Invitación aceptada. Ya puedes iniciar sesión." } });
      })
      .catch((err) => {
        if (err instanceof ApiUnavailableError) {
          if (err.status === 404 || err.status === 409) {
            setEstado("error");
            setMensajeError(err.message);
            return;
          }
          setErrorFormulario(err.message);
        } else {
          setErrorFormulario("No se pudo aceptar la invitación. Inténtalo de nuevo.");
        }
      })
      .finally(() => setEnviando(false));
  };

  return (
    <main className="login flex min-h-screen flex-col items-center justify-center px-6 py-10">
      <div className="mb-10">
        <AtiendeWordmark />
      </div>
      <div className="w-full max-w-[420px]">
        {estado === "comprobando" && <EstadoCargando etiqueta="Comprobando tu invitación…" lineas={1} />}

        {estado === "error" && <EstadoError titulo="Esta invitación no es válida" mensaje={mensajeError} />}

        {estado === "necesita-cuenta" && (
          <>
            <p className="login-kicker">Invitación de equipo</p>
            <h1 className="login-serif mt-4 text-[30px] text-foreground">Crea tu cuenta</h1>
            <p className="mt-3 text-[14px] leading-relaxed text-muted-foreground">
              Todavía no tienes cuenta en Atiende Hoteles: crea una contraseña para poder entrar.
            </p>

            {errorFormulario && (
              <div role="alert" className="mt-6 rounded-[18px] p-5 bg-destructive/5 border border-destructive/30">
                <p className="text-[14px] leading-relaxed text-foreground">{errorFormulario}</p>
              </div>
            )}

            <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-3">
              <label htmlFor="inv-nombre" className="sr-only">
                Tu nombre completo
              </label>
              <input
                id="inv-nombre"
                type="text"
                required
                placeholder="Tu nombre completo"
                autoComplete="name"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="login-campo"
              />
              <label htmlFor="inv-password" className="sr-only">
                Contraseña
              </label>
              <input
                id="inv-password"
                type="password"
                required
                placeholder="Contraseña (mínimo 10 caracteres, una letra y un número)"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="login-campo"
              />
              <button type="submit" disabled={enviando} className="login-btn login-btn-tinta">
                <span aria-hidden className="login-glifo">
                  <AtiendeMark className="h-[17px] w-auto brightness-0 invert" />
                </span>
                <span>{enviando ? "Creando tu cuenta…" : "Aceptar invitación"}</span>
              </button>
            </form>
          </>
        )}

        <p className="mt-6 text-center text-[14px]">
          <Link to="/login" className="underline underline-offset-2 text-foreground">
            Ir a iniciar sesión
          </Link>
        </p>
      </div>
    </main>
  );
}

export default AceptarInvitacion;
