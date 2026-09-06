#!/usr/bin/env bash
# H8 · ADR-008 "Backups". Wrapper delgado sobre scripts/restore.ts (Node) -- restaura
# un .dump (hecho por scripts/backup.sh) en una BASE DE DATOS NUEVA del mismo cluster
# embedded-postgres (nunca sobre la original) y verifica que el conteo de filas de cada
# tabla coincide exacto entre el origen y la base restaurada.
#
# Uso local (embedded-postgres, ADR-003):
#   ./scripts/restore.sh backups/atiende-hoteles-postgres-<timestamp>.dump [nombre_bd]
#
# Uso en producción (Supabase, ADR-003): se restaura en un proyecto Supabase NUEVO
# (nunca sobre el de producción) con:
#   pg_restore -h <host-proyecto-nuevo> -p 5432 -U postgres -d postgres \
#     --no-owner --no-privileges backups/supabase-<timestamp>.dump
#   (ver docs/runbooks/backups-restauracion.md "Producción (Supabase)").
set -euo pipefail
cd "$(dirname "$0")/.."

if [ $# -lt 1 ]; then
  echo "Uso: $0 <archivo .dump> [nombre_bd_nueva]" >&2
  exit 1
fi

exec node --experimental-strip-types scripts/restore.ts "$@"
