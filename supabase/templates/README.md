# Plantillas de correo de Supabase Auth — pendientes de `packages/email`

Estos 5 archivos (`invite.html`, `confirmation.html`, `recovery.html`,
`email_change.html`, `magic_link.html`) son el **fallback de marca mínimo** que
`supabase/config.toml` referencia (`[auth.email.template.*].content_path`).

**Por qué existen como HTML estático aquí y no como funciones en `packages/email`:**
al momento de esta entrega, `packages/email` (H12a, en paralelo) todavía no existe en
este worktree — LAUNCH-004/LAUNCH-014 (correo transaccional, magic link) son trabajo de
otro agente. Bloquear la preparación de Supabase hasta que ese paquete exista habría
dejado `supabase/config.toml` sin plantillas válidas; en vez de eso, estos 5 archivos
son un shell de marca **suficiente y honesto** (paleta `#1D4ED8`, wordmark "atiende",
sin prometer nada que el producto no hace) que Supabase Auth puede servir tal cual hoy.

**Qué hacer cuando `packages/email` exista** (ver
`docs/runbooks/migracion-a-supabase.md` paso "Plantillas de correo"):
1. Si `packages/email` expone un renderer de shell (`renderCorreo()`/`plantilla.ts`,
   mismo patrón que `atiende-restaurantes/supabase/functions/_shared/emails/plantilla.ts`
   y `likida/src/lib/correo/plantilla.ts`), regenerar estos 5 archivos con ese shell en
   vez de editarlos a mano — mismo criterio de "un solo lugar de verdad para el shell"
   que ya sigue el resto del repo.
2. Cada plantilla usa la sintaxis de variables de Supabase (`{{ .ConfirmationURL }}`,
   etc.) documentada en
   https://supabase.com/docs/guides/auth/auth-email-templates — conservar esas
   variables exactas al regenerar.
3. Confirmar visualmente en Supabase Studio (`Authentication → Email Templates`) tras
   `supabase link`, nunca solo por lectura del HTML.
