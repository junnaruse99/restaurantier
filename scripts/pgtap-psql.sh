#!/usr/bin/env bash
# Ejecuta las pruebas pgTAP de supabase/tests/database con psql, sin el contenedor de pg_prove.
# Útil cuando no se puede descargar la imagen supabase/pg_prove. En CI se usa `supabase test db`.
#
#   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres scripts/pgtap-psql.sh [archivo...]
set -euo pipefail

DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
DIR="$(cd "$(dirname "$0")/../supabase/tests/database" && pwd)"

psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -c "set client_min_messages = warning; create extension if not exists pgtap with schema extensions" >/dev/null

if [ "$#" -gt 0 ]; then
  ARCHIVOS=("$@")
else
  mapfile -t ARCHIVOS < <(find "$DIR" -name '*.test.sql' | sort)
fi

fallas=0
for archivo in "${ARCHIVOS[@]}"; do
  nombre="$(basename "$archivo")"
  if ! salida="$(cd "$(dirname "$archivo")" && psql "$DATABASE_URL" -X -q -t -A -v ON_ERROR_STOP=1 -f "$(basename "$archivo")" 2>&1)"; then
    echo "✗ $nombre (error de SQL)"
    echo "$salida" | grep -v '^$' | tail -20
    fallas=$((fallas + 1))
    continue
  fi
  tap="$(echo "$salida" | grep -E '^(ok|not ok|1\.\.|#)' || true)"
  if echo "$tap" | grep -qE '^not ok|^# Looks like'; then
    echo "✗ $nombre"
    echo "$tap" | grep -E '^not ok|^#' | head -40
    fallas=$((fallas + 1))
  else
    echo "✓ $nombre ($(echo "$tap" | grep -cE '^ok') pruebas)"
  fi
done

if [ "$fallas" -gt 0 ]; then
  echo "$fallas archivo(s) con fallas"
  exit 1
fi
