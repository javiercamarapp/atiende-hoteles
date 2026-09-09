# REQ-SEG-001 — evidencia (2026-09-09)

Criterio (`docs/REQUISITOS.md`): "Aviso de Privacidad conforme a LFPDPPP vigente,
accesible desde el primer contacto por WhatsApp/voz/web...". Estado previo:
`pendiente-decisión` (texto legal reservado al fundador, REQ-GOB-012).

## Qué se cerró en este pase (hook técnico, NO el texto legal)

Hallazgo real de `docs/auditoria-2/legal.md` [ALTO]: "el primer contacto solo disclosea
que es un bot, no da al huésped ninguna vía de un clic hacia el aviso de privacidad".
El texto de `apps/web/src/pages/Privacidad.tsx` ya existía de un pase anterior (con su
banner honesto `FaltaDato`), pero WhatsApp nunca lo enlazaba.

- `packages/agent-core/src/disclosure.ts`: `AVISO_PRIVACIDAD_PATH` +
  `buildDisclosureMessageConAvisoPrivacidad(url)` — compone el disclosure de IA de
  siempre + una frase con la URL real del aviso. NO se tocó `WHATSAPP_DISCLOSURE_MESSAGE`
  (sigue siendo la única fuente de verdad del texto de GOB-034).
- `apps/api/src/routes/mensajeria.ts`: el webhook real de WhatsApp (único punto de
  "primer contacto" real de este repo) ahora construye `avisoPrivacidadUrl =
  new URL(AVISO_PRIVACIDAD_PATH, deps.env.frontendUrl)` y guarda/envía el disclosure
  compuesto.
- `apps/api/src/routes/agentes.ts`: mismo criterio para el endpoint de simulación de
  agentes (cubre `canal:"voz"` de ESE endpoint — no existe todavía un canal de voz real,
  ver límite abajo).

## Por qué NO es "hecho" (sigue `pendiente-decisión`)

- El TEXTO legal definitivo del aviso (fecha de vigencia, domicilio del responsable,
  DPO, plazo de brecha) sigue reservado al fundador/equipo legal — no se redactó nada
  nuevo, ver `docs/BLOQUEOS.md` D-009.
- VOZ: no existe ningún canal de telefonía/PBX real en este repo (Telnyx, pendiente
  hardware/credenciales) — mismo límite que ya documentaba
  `tests/adversarial/disclosure-ia.spec.ts` antes de este pase. El texto ya está listo
  para cuando ese canal exista.

## Evidencia (comandos reales, salida en esta carpeta)

- `vitest-disclosure-unit-*.log` — `tests/unit/agent-core/disclosure.spec.ts` (7/7).
- `vitest-disclosure-ia-adversarial-*.log` — `tests/adversarial/disclosure-ia.spec.ts`
  (7/7) contra `embedded-postgres` real vía `FakeWhatsappAdapter`; el `body` guardado del
  mensaje `disclosure_ia` incluye ahora la URL real del aviso.
- `playwright-aviso-privacidad-*.log` — `tests/e2e/aviso-privacidad-primer-contacto.spec.ts`
  (4/4, desktop+mobile): la landing enlaza `/privacidad` desde el footer, y esa página
  renderiza sus secciones reales + el banner de pendiente de redacción legal.
- `typecheck-*.log` — `npm run typecheck` (raíz + `apps/api`) sin errores.
- Suite completa de regresión corrida aparte (no en esta carpeta, ver reporte final de
  la tarea): 300/300 adversariales, 305/306 integración (1 falla preexistente ajena a
  este cambio, confirmada contra el commit base sin mis ediciones).
