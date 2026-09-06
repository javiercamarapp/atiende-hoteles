#!/usr/bin/env bash
# H8 · ADR-008 "Backups: pg_dump programado contra el Postgres real". Wrapper delgado
# sobre scripts/backup.ts (Node) -- la lógica real vive ahí porque necesita arrancar/
# detener el mismo embedded-postgres persistente que usa el resto del repo
# (packages/db/src/cli.ts) usando la librería ya probada `@atiende-hoteles/db`, en vez
# de reimplementar esa orquestación en bash.
#
# Uso local (embedded-postgres, ADR-003):
#   ./scripts/backup.sh [directorio_de_salida]
#
# Uso en producción (Supabase, ADR-003 "producción sigue siendo Supabase"): NO se usa
# este script contra el cluster embebido -- se apunta pg_dump directo a Supabase:
#   PGPASSWORD="$SUPABASE_DB_PASSWORD" pg_dump -h "$SUPABASE_DB_HOST" -p 5432 \
#     -U postgres -d postgres -Fc -f "backups/supabase-$(date -u +%Y%m%dT%H%M%SZ).dump"
#   (ver docs/runbooks/backups-restauracion.md "Producción (Supabase)").
set -euo pipefail
cd "$(dirname "$0")/.."

# auditoria-2/arquitectura [ALTO]: --experimental-strip-types (borra sintaxis de tipos,
# no la transforma) es correcto aquí -- scripts/backup.ts no importa nada con
# "parameter properties" de TypeScript, a diferencia de apps/api (que sí necesita
# --experimental-transform-types desde H5, ver apps/api/package.json). Ver el
# comentario completo en scripts/backup.ts.
OUT_DIR="${1:-backups}"
exec node --experimental-strip-types scripts/backup.ts --out-dir "$OUT_DIR"
