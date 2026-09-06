import { useEffect } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { EstadoCargando, AtiendeWordmark } from "@atiende/ui";
import { useAuth } from "../hooks/useAuth";
import "./login.css";

/**
 * `/auth/google/callback` — a donde `routes/auth-google.ts` redirige tras un login/alta
 * exitosos por Google, con `token`/`refreshToken`/`email`/`rol` ya emitidos en la query
 * string (nunca se llama a esta ruta por `fetch`, solo por navegación de página
 * completa). El caso de ERROR (`google_error=...`) lo maneja Login.tsx, no esta
 * página: el backend redirige los errores directo a `/login?google_error=...`.
 */
export function GoogleCallback() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { establecerSesion } = useAuth();

  const token = searchParams.get("token");
  const email = searchParams.get("email");
  const rol = searchParams.get("rol");

  useEffect(() => {
    if (token && email && rol) {
      establecerSesion({ token, email, rol });
      navigate("/resumen", { replace: true });
    }
    // Si por algún motivo llegamos aquí sin `token` (nunca debería pasar en el flujo
    // real: los errores van a /login), no navegamos a ningún lado — se muestra el
    // aviso de abajo en vez de un panel a medio autenticar.
  }, [token, email, rol, establecerSesion, navigate]);

  return (
    <main className="login flex min-h-screen flex-col items-center justify-center px-6 py-10">
      <div className="mb-10">
        <AtiendeWordmark />
      </div>
      <div className="w-full max-w-[360px] text-center">
        {token ? (
          <EstadoCargando etiqueta="Entrando con Google…" lineas={1} />
        ) : (
          <div role="alert" className="rounded-[18px] p-5 bg-destructive/5 border border-destructive/30">
            <p className="text-[14px] leading-relaxed text-foreground">
              No recibimos los datos de sesión de Google. Vuelve a intentarlo desde el inicio de sesión.
            </p>
            <Link to="/login" className="mt-4 inline-block underline underline-offset-2 text-foreground">
              Ir a iniciar sesión
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}

export default GoogleCallback;
