# Atiende Hoteles — repo PROVISIONAL (staging)

**Ubicación provisional.** El encargo pide crear el repo dentro de la "carpeta existente de empresas agénticas",
cuya ruta NO se pudo verificar localmente (ver `docs/BLOQUEOS.md`, B-001). Este directorio NO pretende ser esa carpeta;
existe para no perder trabajo de requisitos/investigación mientras el usuario confirma la ruta. Al confirmarla,
se mueve completo (`git mv` / `mv`) sin reescribir historia.

Orquestación: Fable (claude-fable-5-1) solo coordina; toda ejecución delegada corre con `model=sonnet` explícito (ver `docs/AGENTES.md`).

## Cómo correr (dos terminales)

**auditoria-2/operabilidad [BAJO]**: este README no tenía ninguna sección de "cómo
correr" — solo el aviso de arriba. Seguirlo literalmente no decía que existen
`apps/api/README.md`/`apps/web/README.md`, cada uno con su propio quickstart.

```bash
npm install                                          # una vez, desde la raíz

# Terminal 1 — backend (Postgres embebido real, migra + siembra datos si está vacío):
npm run dev --workspace=@atiende-hoteles/api         # http://localhost:3001

# Terminal 2 — panel (necesita VITE_API_URL para ver datos reales, ver apps/web/README.md):
npm run dev --workspace apps/web                     # http://localhost:5173
```

Detalle completo (variables de entorno, credenciales de desarrollo sembradas, pruebas,
build) en `apps/api/README.md` y `apps/web/README.md`.
