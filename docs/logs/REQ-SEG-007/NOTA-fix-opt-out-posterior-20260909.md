---
fecha: 2026-09-09
relacionado: REQ-SEG-007, REQ-HUE-021, REQ-HUE-024
---

# Corrección: opt-out posterior a un opt-in no bloqueaba el envío

Al construir REQ-HUE-024 (`packages/domain-hotel/src/consentLedger.ts` +
`apps/api/src/routes/consentimiento.ts`) se ejercitó por primera vez, de punta a punta y
por rutas HTTP reales (no el cliente admin), la secuencia: **opt-in → envío → opt-out →
envío**. Esa secuencia reveló que `isMarketingSendBlocked()`
(`packages/agent-core/src/tools/messagingTools.ts`) decidía con:

```sql
select exists (
  select 1 from public.consent
  where ... and granted = true
) as opted_in;
```

es decir, "¿ALGUNA VEZ este huésped otorgó consentimiento de marketing?" — no "¿la
decisión MÁS RECIENTE fue otorgar?". Un huésped que otorgó opt-in una vez y luego se dio
de BAJA (exactamente lo que REQ-HUE-020 exige poder registrar) seguía recibiendo
marketing indefinidamente: la fila antigua `granted=true` seguía satisfaciendo el
`EXISTS`, sin importar cuántas filas `granted=false` vinieran después.

Ningún test existente (`tests/adversarial/opt-in-marketing.spec.ts`, caso "(d)
deny-by-default") ejercitaba esa secuencia — probaba un opt-out como ÚNICA fila, nunca
un opt-out posterior a un opt-in previo.

## Fix

`order by created_at desc limit 1` en vez de `exists(...)`: la fila más reciente es la
única que cuenta.

## Verificación

- `tests/adversarial/consent-ledger.spec.ts` (caso "un opt-out posterior... vuelve a
  bloquear el envío") — reproduce el fix con Postgres real, sin el fix falla con
  `expected 409 to be 201` (ver commit de este fix).
- Regresión: `tests/adversarial/opt-in-marketing.spec.ts` (11/11) sigue verde sin
  cambios — ningún caso existente dependía del comportamiento anterior.
