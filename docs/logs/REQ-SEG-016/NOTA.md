# REQ-SEG-016 — evidencia (2026-09-09)

Criterio (`docs/REQUISITOS.md`): "El registro de huéspedes debe cumplir la normativa
migratoria y ser exportable sin imágenes de documentos, respetando los plazos de
retención definidos por plaza (1-5 años de registro, 30-90 días de audio, 30 días de
IoT, 7-30 días de CCTV, 5 años de CFDI)." Estado previo: `pendiente` (sin razón — no
existía ningún endpoint de exportación bulk del registro).

## Qué se construyó (parte EXPORTABLE)

`GET /hoteles/:hotelId/huespedes/registro-migratorio?desde=&hasta=`
(`apps/api/src/routes/huespedes.ts`, roles `owner/gm/frontdesk/reservations`) — une
`reservation`+`guest`+`identity_ref` (COALESCE: cubre tanto el check-in en línea de
autoservicio, que escribe `guest.document_type`, como el registro manual por MRZ, que
solo escribe `identity_ref`) y devuelve nombre/tipo de documento/últimos 4/nacionalidad/
fechas de estancia por rango de fechas. "Sin imágenes de documentos" es una garantía
ESTRUCTURAL, no un filtro de esta query: ni `guest` (0005) ni `identity_ref` (0051)
tienen ninguna columna de imagen en todo el esquema — no hay de dónde seleccionarla.

## Qué NO se construyó, y por qué (genuinamente pendiente, no forzado)

1. **Retención "por plaza"**: `location`/`hotel` (0002) no tienen ningún campo de país/
   estado/jurisdicción — no hay sobre qué codificar "esta plaza retiene 3 años, esta
   otra 1". Qué plazas existen y el periodo exacto dentro del rango 1-5 años es una
   decisión legal/de negocio reservada (misma clase que REQ-SEG-001/REQ-GOB-012) — no
   se inventa aquí. Ver `docs/BLOQUEOS.md` D-010.
2. **Audio (30-90 días)/IoT (30 días)/CCTV (7-30 días)**: ninguna de las tres tiene hoy
   una fuente de datos real que purgar en este repo — el canal de voz depende de
   telefonía/PBX real (pendiente-hardware, mismo límite que
   `tests/adversarial/disclosure-ia.spec.ts`), las cerraduras/sensores IoT son
   simulados (ADR-011, `packages/mcp-servers/locks`/`energy`), y CCTV es
   `REQ-SEG-006` (pendiente-hardware explícito en `docs/REQUISITOS.md`).
3. **CFDI (5 años)**: cumple por diseño sin cambio — ningún job de este repo purga
   `cfdi_emision`, así que nunca se borra antes de tiempo (no es un hallazgo, es la
   ausencia de un problema).
4. **Hallazgo señalado, NO resuelto unilateralmente**: al leer `apps/api/src/jobs/
   purgeIdentityVault.ts` para construir el export se confirmó que la purga de
   `identity_vault` a 30 días post-checkout (REQ-SEG-004) borra en CASCADA su
   `identity_ref` asociado (`tests/adversarial/boveda-identidad.spec.ts`, caso "cascada:
   identity_ref también desaparece" — comportamiento YA probado y aceptado para
   REQ-SEG-004). Eso significa que, hoy, el registro migratorio de un huésped NO
   sobrevive más de 30 días post-checkout — mucho menos que los "1-5 años" de
   REQ-SEG-016. Es una tensión real entre dos requisitos con dueños de decisión
   distintos (privacidad vs. cumplimiento migratorio); cambiar el `ON DELETE CASCADE`
   de `identity_ref.vault_id` afectaría comportamiento YA probado de REQ-SEG-004 y
   merece su propio análisis deliberado — no se tocó bajo esta tarea. `identity_vault`/
   `identity_ref` quedan exactamente como estaban.

## Evidencia (comandos reales, salida en esta carpeta)

- `vitest-registro-huespedes-*.log` — `tests/adversarial/registro-huespedes-migratorio.spec.ts`
  (5/5): rol correcto (403 para housekeeping), rango inválido (400), exportación real
  con documento+nacionalidad y verificación explícita de ausencia de cualquier campo/
  valor tipo imagen, huésped sin identidad todavía (campos `null` honestos, no
  inventados), rango sin resultados (`[]`, nunca error).
- `typecheck-*.log` — `npm run typecheck` sin errores.
- `tests/adversarial/boveda-identidad.spec.ts` (REQ-SEG-004) se corrió sin
  modificaciones y sigue en verde (10/10) — confirma que no se tocó su comportamiento.
