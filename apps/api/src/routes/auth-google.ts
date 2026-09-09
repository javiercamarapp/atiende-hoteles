// H12a · REQ-LAUNCH: Google OAuth (Authorization Code + PKCE, ADR-004 "JWT propio" --
// Google es SOLO un proveedor de identidad, nunca reemplaza el JWT propio ni Supabase
// Auth). Dos rutas:
//   - GET /auth/google/iniciar   -- arma el `state`/`nonce`/PKCE, redirige a Google (o
//     al servidor OAuth falso de pruebas, ver env.googleOAuthBaseUrl).
//   - GET /auth/google/callback  -- intercambia el código, verifica el id_token
//     (iss/aud/exp por `jose`, nonce/email_verified aquí mismo, ver lib/googleOAuth.ts),
//     vincula/crea la cuenta y emite el JWT propio -- redirige de vuelta al panel.
//
// Sin `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REDIRECT_URI` configuradas,
// AMBAS rutas responden 503 `no_configurado` -- el botón "Continuar con Google" en
// apps/web se declara honestamente deshabilitado en ese caso (ver Login.tsx/Registro.tsx),
// nunca se finge un flujo que no puede completarse.
import { Hono } from "hono";
import { z } from "zod";
import { signAccessToken, signRefreshToken } from "../lib/jwt.ts";
import {
  buildAuthorizationUrl,
  computeCodeChallenge,
  exchangeAuthorizationCode,
  generateCodeVerifier,
  generateNonce,
  generateState,
  verifyGoogleIdToken,
  GoogleOAuthError,
} from "../lib/googleOAuth.ts";
import { crearHotelAutoservicio, existeCuentaConCorreo } from "../lib/registroHotel.ts";
import { renderBienvenidaHotel } from "@atiende-hoteles/email";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import type { HonoEnvBindings, ResolvedAppDeps } from "../types.ts";

const iniciarQuerySchema = z.object({
  purpose: z.enum(["login", "registro"]),
  hotelName: z.string().trim().min(2).max(200).optional(),
  city: z.string().trim().min(2).max(120).optional(),
  stateName: z.string().trim().min(2).max(120).optional(),
});

interface OAuthStateRow {
  id: string;
  purpose: "login" | "registro";
  state: string;
  nonce: string;
  code_verifier: string;
  redirect_uri: string;
  registro_payload: { hotelName: string; city: string; stateName: string } | null;
}

interface StaffRow {
  id: string;
  email: string;
  full_name: string;
}

interface MembershipRow {
  org_id: string;
  hotel_id: string;
  role: string;
  hotel_name: string;
}

/** Duplicado mínimo (a propósito) de la emisión de sesión de routes/auth.ts: ese
 *  archivo es de convivencia compartida entre correctores en paralelo (no está en
 *  ningún lote de exclusión, pero tampoco es de este agente) -- para no arriesgar un
 *  choque de merge se prefiere esta pequeña duplicación en vez de exportar/tocar
 *  routes/auth.ts. Si en un pase futuro se decide unificar, este es el único lugar a
 *  actualizar de este lado. */
async function issueSession(deps: ResolvedAppDeps, staff: StaffRow) {
  const { rows: memberships } = await deps.engine.admin.query<MembershipRow>(
    `select hs.org_id, hs.hotel_id, hs.role, l.name as hotel_name
     from public.hotel_staff hs
     join public.location l on l.id = hs.hotel_id
     where hs.user_id = $1
     order by l.name asc;`,
    [staff.id],
  );

  const orgId = memberships[0]?.org_id ?? "";
  const hotelIds = memberships.map((m) => m.hotel_id);
  const role = memberships[0]?.role ?? null;

  const token = await signAccessToken(
    { sub: staff.id, org_id: orgId, hotel_ids: hotelIds, email: staff.email },
    deps.env.jwtSecret,
    deps.env.accessTokenTtlSeconds,
  );
  const refreshToken = await signRefreshToken(staff.id, deps.env.jwtSecret, deps.env.refreshTokenTtlSeconds);

  return {
    token,
    refreshToken,
    email: staff.email,
    rol: role ?? "sin_rol",
    hoteles: memberships.map((m) => ({ id: m.hotel_id, nombre: m.hotel_name, rol: m.role })),
  };
}

function googleConfigured(deps: ResolvedAppDeps): boolean {
  return Boolean(deps.env.googleClientId && deps.env.googleClientSecret && deps.env.googleRedirectUri);
}

function noConfigurado() {
  return Errors.validation("Google: pendiente de configurar en este entorno (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REDIRECT_URI).");
}

export function authGoogleRoutes(deps: ResolvedAppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.get("/auth/google/iniciar", async (c) => {
    if (!googleConfigured(deps)) {
      const err = noConfigurado();
      return c.json({ code: "no_configurado", message: err.message, request_id: c.get("requestId") ?? "sin-id" }, 503);
    }

    const query = parseBody(iniciarQuerySchema, {
      purpose: c.req.query("purpose"),
      hotelName: c.req.query("hotelName") || undefined,
      city: c.req.query("city") || undefined,
      stateName: c.req.query("stateName") || undefined,
    });

    if (query.purpose === "registro" && (!query.hotelName || !query.city || !query.stateName)) {
      throw Errors.validation("Para registrar un hotel nuevo con Google se requieren hotelName, city y stateName.");
    }

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = computeCodeChallenge(codeVerifier);
    const state = generateState();
    const nonce = generateNonce();

    await deps.engine.admin.query(
      `insert into public.oauth_state
         (provider, purpose, state, nonce, code_verifier, redirect_uri, registro_payload, expires_at)
       values ('google', $1, $2, $3, $4, $5, $6, now() + interval '10 minutes');`,
      [
        query.purpose,
        state,
        nonce,
        codeVerifier,
        deps.env.googleRedirectUri,
        query.purpose === "registro" ? JSON.stringify({ hotelName: query.hotelName, city: query.city, stateName: query.stateName }) : null,
      ],
    );

    const authorizationUrl = buildAuthorizationUrl({
      authBaseUrl: deps.env.googleOAuthBaseUrl,
      clientId: deps.env.googleClientId!,
      redirectUri: deps.env.googleRedirectUri!,
      state,
      nonce,
      codeChallenge,
    });

    return c.redirect(authorizationUrl, 302);
  });

  app.get("/auth/google/callback", async (c) => {
    if (!googleConfigured(deps)) {
      const err = noConfigurado();
      return c.json({ code: "no_configurado", message: err.message, request_id: c.get("requestId") ?? "sin-id" }, 503);
    }

    const code = c.req.query("code");
    const state = c.req.query("state");
    const loginUrl = () => new URL("/login", deps.env.frontendUrl);

    if (!code || !state) {
      const url = loginUrl();
      url.searchParams.set("google_error", "parametros_faltantes");
      return c.redirect(url.toString(), 302);
    }

    // Consumo atómico de un solo uso: la fila solo se marca 'usado' si TODAVÍA estaba
    // 'pendiente' y no venció -- un `state` repetido (replay) o vencido nunca pasa de
    // aquí, sin ventana de carrera entre "leer" y "marcar usado".
    const { rows: consumedRows } = await deps.engine.admin.query<OAuthStateRow>(
      `update public.oauth_state
       set status = 'usado', used_at = now()
       where state = $1 and status = 'pendiente' and expires_at > now()
       returning id, purpose, state, nonce, code_verifier, redirect_uri, registro_payload;`,
      [state],
    );

    if (consumedRows.length === 0) {
      const { rows: existing } = await deps.engine.admin.query<{ status: string; expires_at: string }>(
        "select status, expires_at from public.oauth_state where state = $1;",
        [state],
      );
      const reason = existing.length === 0 ? "state_invalido" : existing[0]!.status === "usado" ? "state_ya_usado" : "state_expirado";
      // Marca expirada explícitamente la fila si esa fue la causa (higiene, no afecta el resultado).
      if (reason === "state_expirado") {
        await deps.engine.admin.query("update public.oauth_state set status = 'expirado' where state = $1 and status = 'pendiente';", [state]);
      }
      const url = loginUrl();
      url.searchParams.set("google_error", reason);
      return c.redirect(url.toString(), 302);
    }

    const oauthState = consumedRows[0]!;

    try {
      const { idToken } = await exchangeAuthorizationCode({
        tokenUrl: deps.env.googleTokenUrl,
        clientId: deps.env.googleClientId!,
        clientSecret: deps.env.googleClientSecret!,
        code,
        redirectUri: oauthState.redirect_uri,
        codeVerifier: oauthState.code_verifier,
      });

      const claims = await verifyGoogleIdToken(idToken, {
        jwksUrl: deps.env.googleJwksUrl,
        issuer: deps.env.googleIssuer,
        audience: deps.env.googleClientId!,
        expectedNonce: oauthState.nonce,
      });

      // 1) ¿Ya existe una identidad Google vinculada a este `sub`? -- caso más común
      //    tras el primer login exitoso.
      const { rows: identityRows } = await deps.engine.admin.query<{ staff_user_id: string }>(
        "select staff_user_id from public.hotel_staff_identity where provider = 'google' and provider_sub = $1;",
        [claims.sub],
      );

      let staffId: string;

      if (identityRows.length > 0) {
        staffId = identityRows[0]!.staff_user_id;
      } else {
        // 2) ¿Existe ya una cuenta de staff con este correo (invitada por contraseña,
        //    o dada de alta antes)? -- se vincula la identidad de Google a ELLA, nunca
        //    se crea una cuenta duplicada.
        const yaExiste = await existeCuentaConCorreo(deps.engine.admin, claims.email.toLowerCase());

        if (yaExiste) {
          const { rows: staffRows } = await deps.engine.admin.query<StaffRow>(
            "select id, email, full_name from public.staff_user where email = $1;",
            [claims.email.toLowerCase()],
          );
          staffId = staffRows[0]!.id;
          await deps.engine.admin.query(
            "update public.staff_user set email_verified_at = coalesce(email_verified_at, now()) where id = $1;",
            [staffId],
          );
        } else if (oauthState.purpose === "registro" && oauthState.registro_payload) {
          const created = await crearHotelAutoservicio(deps.engine.admin, {
            hotelName: oauthState.registro_payload.hotelName,
            city: oauthState.registro_payload.city,
            stateName: oauthState.registro_payload.stateName,
            ownerEmail: claims.email.toLowerCase(),
            ownerFullName: claims.name ?? claims.email,
            passwordHash: null,
            createdVia: "google",
            emailAlreadyVerified: true,
          });
          staffId = created.staffUserId;

          const panelUrl = new URL("/login", deps.env.frontendUrl).toString();
          const ownerName = claims.name ?? claims.email;
          const rendered = renderBienvenidaHotel({
            nombreHotel: oauthState.registro_payload.hotelName,
            nombreOwner: ownerName,
            panelUrl,
            pasosOnboarding: [
              "Configura tus tipos de habitación y tarifas base.",
              "Confirma la zona horaria de tu hotel.",
              "Invita a tu equipo con el rol que le corresponde.",
            ],
          });
          await deps.emailPort.send({
            ...rendered,
            to: { email: claims.email, name: ownerName },
            template: "bienvenida-hotel",
            dedupeKey: `bienvenida-hotel:${created.staffUserId}`,
            tenantId: created.orgId,
            hotelId: created.hotelId,
          });
        } else {
          // REQ-LAUNCH: "cuenta no invitada -> rechazo" -- iniciar sesión con Google
          // NUNCA da de alta una cuenta nueva por sí solo; solo `purpose=registro`
          // (con su propio formulario de nombre de hotel) puede crear una.
          const url = loginUrl();
          url.searchParams.set("google_error", "cuenta_no_invitada");
          return c.redirect(url.toString(), 302);
        }

        await deps.engine.admin.query(
          `insert into public.hotel_staff_identity (staff_user_id, provider, provider_sub, email, email_verified)
           values ($1, 'google', $2, $3, true)
           on conflict (provider, provider_sub)
           do update set email = excluded.email, email_verified = excluded.email_verified;`,
          [staffId, claims.sub, claims.email.toLowerCase()],
        );
      }

      const { rows: staffRows } = await deps.engine.admin.query<StaffRow>(
        "select id, email, full_name from public.staff_user where id = $1;",
        [staffId],
      );
      const staff = staffRows[0]!;
      const session = await issueSession(deps, staff);

      const url = new URL("/auth/google/callback", deps.env.frontendUrl);
      url.searchParams.set("token", session.token);
      url.searchParams.set("refreshToken", session.refreshToken);
      url.searchParams.set("email", session.email);
      url.searchParams.set("rol", session.rol);
      return c.redirect(url.toString(), 302);
    } catch (err) {
      const code_ = err instanceof GoogleOAuthError ? err.code : "error_desconocido";
      deps.logger.error({ err: err instanceof Error ? err.message : String(err), code: code_ }, "auth_google_callback_error");
      const url = loginUrl();
      url.searchParams.set("google_error", code_);
      return c.redirect(url.toString(), 302);
    }
  });

  return app;
}
