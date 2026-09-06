# Cumplimiento fiscal (CFDI 4.0 hospedaje / ISH / IVA) — auditoría 2

**Nota: 2/10** (sin ronda anterior — primera auditoría de este rubro, nota línea base).

El riesgo mayor hoy: un empleado con rol de dinero (frontdesk/reservations/fnb, no solo owner/gm) puede fijar a mano el IVA/ISH de cualquier cargo real vía `impuesto` en el body de la API — y, aparte de eso, el motor "determinista" que sí calcula el impuesto aplica ISH (impuesto que la ley excluye de alimentos) sobre A&B/extras por diseño, comportamiento que un test unitario fija explícitamente como correcto.

No existe una ficha de norma versionada (`normas/*.yaml` o equivalente) en el repo para ISH/CFDI — toda comparación de esta ronda se hizo contra `docs/referencia/03-investigacion-H12-H21.md` (tabla H16-007/010/011/012, trazada a H16 p.12-17) y, para el texto exacto, contra el PDF fuente `H16-finanzas-fiscal-conciliacion-hotel.pdf` páginas 12-17 leídas directamente. Se anota explícitamente: **sin ficha de norma versionada — no verificable contra fuente primaria estructurada en esta ronda**, solo contra el PDF de investigación.

## Hallazgos

### [CRÍTICO] El impuesto que manda el cliente sobrescribe el cálculo fiscal determinista, no lo valida
`apps/api/src/routes/folios.ts:251-252`
```
const calc = computeChargeAmounts({ concept: body.concepto, netAmount: body.monto, taxConfig });
const taxAmount = body.impuesto != null && body.concepto !== "propina" ? body.impuesto : calc.taxAmount;
```
Escenario: un usuario con rol `frontdesk` (incluido en `MONEY_ROLES`, `apps/api/src/domain/roles.ts:20`, junto con `reservations`/`fnb` — no solo `owner`/`gm`) hace `POST /hoteles/:hotelId/folios/:folioId/cargos` con `{concepto:"hospedaje", monto:1000, impuesto:0}` sobre un hotel con `ivaRate=0.16`/`ishRate=0.05`. `computeChargeAmounts` calcula correctamente `calc.taxAmount = 210` (160 IVA + 50 ISH), pero la línea 252 evalúa la condición `body.impuesto != null && concepto !== "propina"` como verdadera y usa el `0` que mandó el cliente en vez de los `210` calculados. El cargo se inserta con `amount=1000, tax_amount=0`.
Consecuencia: el saldo del folio (`computeBalance`, línea 129, suma `amount + tax_amount`) le cobra al huésped MXN 210 menos de lo que la ley exige, y si después se timbra un CFDI de ese folio, `cfdi.ts` recalcula el IVA/ISH desde cero sobre `amount` (ignora `tax_amount` almacenado) — el CFDI declarará un total distinto (mayor) al que el folio realmente le cobró al huésped. Es también la puerta exacta para el patrón de fraude interno que el propio H16-014 pide detectar ("descuentos/cortesías fuera de política"): un cajero puede poner `impuesto:0` en efectivo y quedarse con la diferencia sin que el sistema lo marque.
Causa raíz probable: la línea 252 invierte la lógica que su propio comentario (líneas 247-250) describe — dice "SIEMPRE se recalcula... nunca se confía en un impuesto que venga del cliente sin verificar", pero el código hace exactamente lo contrario cuando `body.impuesto` viene presente.

### [CRÍTICO] ISH aplicado sobre A&B/extras/ajuste, no solo sobre hospedaje — fijado como comportamiento correcto en un test
`packages/domain-hotel/src/folioEngine.ts:23,40-53`
```
const UNTAXED_CONCEPTS: ReadonlySet<ChargeConcept> = new Set(["propina", "descuento", "reverso"]);
...
export function computeChargeAmounts(input: ChargeCalcInput): ChargeCalcResult {
  ...
  if (UNTAXED_CONCEPTS.has(input.concept)) { ... }
  const breakdown = applyTaxes(input.netAmount, input.taxConfig);   // aplica IVA + ISH juntos
```
`taxConfig` es un único `hotel_tax_config` por hotel (`apps/api/src/pms/taxConfig.ts:35-61`) sin distinción por concepto, usado tal cual para cualquier `concepto` del enum `["hospedaje","ab","extras","ajuste","propina","otro"]` (`apps/api/src/routes/folios.ts:31,246-252`) y también en la suma que arma el CFDI (`apps/api/src/routes/cfdi.ts:210-225`, ver abajo).

Norma (H16-010, `docs/referencia/03-investigacion-H12-H21.md` línea 99, y PDF H16 p.16, tabla "ISH – Impuesto al Hospedaje"): *"5% [DATO] ... valor de la contraprestación por hospedaje (sin IVA); **excluye alimentos y otros servicios si se desglosan**"*. El propio PDF, p.12, sección "Cargos a habitación desde F&B/spa", lo repite para el caso de folio consolidado: *"al check-out el folio consolidado va a un solo CFDI con conceptos por ClaveProdServ (hospedaje 90111500, alimentos 90101500, spa 91111500) e IVA 16 %; **ISH solo sobre hospedaje**"*.

Escenario: un huésped desayuna MXN 250 cargados a la habitación. `POST /cargos {concepto:"ab", monto:250}` sin `impuesto` explícito → `computeChargeAmounts` no encuentra `"ab"` en `UNTAXED_CONCEPTS`, llama `applyTaxes(250, {ivaRate:0.16, ishRate:0.03})` → `taxAmount = 47.50` (40 IVA + **7.50 ISH sobre alimentos**). Esto está probado y aceptado como correcto en `tests/unit/domain-hotel/folio-engine.spec.ts:21-25`: *"A&B/extras/ajuste llevan IVA + ISH igual que hospedaje (mismo motor único)"*, `expect(ab.taxAmount).toBe(47.5)`.
Consecuencia: el huésped paga ISH sobre su desayuno, que la ley excluye explícitamente; y cuando se timbra el CFDI de hospedaje del folio, `cfdi.ts:210-225` suma `amount` de **todos** los cargos con `concept <> 'propina'` (hospedaje + ab + extras + ajuste + otro) en un solo `subtotalBase` y le aplica `applyTaxes` completo — el ISH declarado a la SATQ el día 17 (H16-009) queda sobre-declarado por el total de A&B/extras del mes, no solo por hospedaje. Esto es harina de otro costal contable: corregirlo mes a mes requiere reclamar saldo a favor ante SATQ.
Causa raíz probable: `TimbrarInput` (`packages/mcp-servers/cfdi/src/port.ts:57-69`) no modela conceptos por `ClaveProdServ` (solo un `subtotal`/`iva`/`impuestosLocales` agregados), así que no hay forma de que el motor separe la base de ISH de la de A&B ni a nivel de folio ni a nivel de CFDI.

### [CRÍTICO] El CFDI de una penalización de no-show declara un total distinto al que el folio le cobró al huésped
`apps/api/src/jobs/noShow.ts:100-105` + `apps/api/src/routes/cfdi.ts:210-227`
```
// noShow.ts — inserta el cargo con impuesto fijo en 0, sin pasar por computeChargeAmounts:
insert into public.charge (..., amount, tax_amount, concept)
values ($1, $2, $3, 'Penalización por no-show', $4, 0, 'hospedaje');
```
```
// cfdi.ts — recalcula IVA+ISH desde cero sobre la suma de `amount` de todos los cargos:
const subtotalBase = Number(sumRows[0]?.total_amount ?? 0);  // solo suma `amount`, ignora tax_amount ya guardado
const breakdown = applyTaxes(subtotalBase, { ivaRate: moneyConfig.ivaRate, ishRate: moneyConfig.ishRate });
```
Norma (PDF H16 p.14, tabla "No-show/cancelación con penalidad"): *"IVA e ImpuestosLocales: IVA 16 % ⚠ (criterio SAT: las penas convencionales por servicios están gravadas); **ISH: no, no hubo hospedaje** ⚠"* — es decir, IVA **sí** debe aplicarse a la penalidad, ISH no. `tests/integration/contracts/cfdi/hospedaje.spec.ts:133-162` (caso 5) confirma que el sistema postea la penalidad como concepto `'hospedaje'` y que "ENTRA al CFDI", pero solo verifica `subtotal > 0`, nunca que el `total` coincida con lo que el folio le cobró al huésped.
Escenario: reserva con `total_amount=1000` y política default (`noShowPct:100`, `DEFAULT_POLICY` en `noShow.ts:20-25`) se marca no-show. `evaluateNoShow` calcula `chargeAmount=1000`; el `INSERT` de `noShow.ts:101-104` guarda `amount=1000, tax_amount=0` — el folio queda con saldo `1000` (sin IVA, contradiciendo la norma que exige 16 % IVA sobre la penalidad). Cuando el GM emite el CFDI de ese folio (`esNoShow:true`), `cfdi.ts` suma `subtotalBase=1000` (la columna `amount`, ignora que `tax_amount` ya es 0) y aplica `applyTaxes(1000, {ivaRate:0.16, ishRate:0.05})` → `total = 1000 + 160 + 50 = 1210`, más DSA si aplica.
Consecuencia: el folio le "cobró" (o cargó a la tarjeta en archivo) MXN 1000 al huésped, pero el CFDI timbrado y entregado dice MXN 1210 — un documento fiscal que no coincide con la transacción real, además de que la ISH sí se le cobra a una penalidad que la norma dice que no debe llevarla (mismo defecto que el hallazgo anterior, aplicado aquí a no-show).
Causa raíz probable: dos rutas de cálculo de impuesto independientes (el `INSERT` manual de `noShow.ts` y el recálculo agregado de `cfdi.ts`) que nunca se validan entre sí — ninguna usa `computeChargeAmounts` de forma consistente para este caso.

### [ALTO] El nodo `CfdiRelacionados` tipo 07 (anticipos), exigido por REQ-BO-001, nunca llega al PAC
`packages/mcp-servers/cfdi/src/port.ts:57-69` + `apps/api/src/routes/cfdi.ts:30-38`
`TimbrarInput` (el esquema que de verdad se manda a `deps.cfdi.timbrar(...)`) no tiene ningún campo para relación de CFDI. `relacionadoCfdiId` solo se guarda en la columna local `cfdi_emision.related_cfdi_id` (`apps/api/src/routes/cfdi.ts:261-269`); el propio comentario del código lo admite: *"El `CfdiPort` actual ... no expone un campo `CfdiRelacionados` en su esquema `TimbrarInput` -- la relación se registra en ESTA tabla como el mejor esfuerzo disponible"*. `tests/integration/contracts/cfdi/hospedaje.spec.ts:164-185` (caso 6) solo comprueba que `related_cfdi_id` quedó en nuestra propia tabla, nunca que el XML/timbrado real declare la relación tipo 07 exigida por el Anexo 20/Apéndice 6 que el propio PDF cita (p.13).
Consecuencia: cuando exista un PAC real (ADR-007, pendiente de credenciales), cualquier CFDI de estancia que cierre un anticipo se timbrará SIN la relación fiscal que la norma exige — un CFDI estructuralmente incompleto para ese caso, aunque el propio sistema muestre "timbrado" con éxito porque el fixture/PAC no lo valida (el patrón que el propio rubro pide buscar).
Causa raíz probable: el contrato `CfdiPort`/`TimbrarInput` nunca se extendió para llevar `CfdiRelacionados`, y quedó documentado como pendiente sin bloquear el flujo de emisión.

### [ALTO] El contrato `CfdiPort` no tiene campo de Forma de Pago (catálogo SAT `c_FormaPago`)
`packages/mcp-servers/cfdi/src/port.ts:57-69`
`TimbrarInput` solo tiene `metodoPago: "PUE" | "PPD"` (Método de Pago, catálogo `c_MetodoPago`) — no existe ningún campo para la Forma de Pago (efectivo=01, transferencia=03, tarjeta de crédito=04, tarjeta de débito=28, etc.), que es un nodo obligatorio de cualquier CFDI 4.0 y que además condiciona cuándo corresponde el complemento de pago (`apps/api/src/routes/cfdi.ts:297-391` ya modela el complemento de pago separado, pero el CFDI original nunca declaró con qué se pagó ni cuándo debe ir "99 - Por definir").
Consecuencia: ni el `FakeGenericPacAdapter` ni los adaptadores reales (`finkok-adapter.ts`, `sw-sapien-adapter.ts`, ambos stubs honestos que solo tiran `PortUnavailableError` sin credenciales) tienen dónde recibir este dato — cuando haya credenciales reales, el timbrado fallaría o se tendría que inventar un valor fijo fuera de este código, sin trazabilidad de cuál método real usó el huésped.
Causa raíz probable: el diseño de `TimbrarInput` se centró en el desglose de impuestos (ISH/DSA) y omitió el nodo de forma de pago del comprobante.

### [ALTO] El calendario fiscal (REQ-BO-008) no tiene ningún mecanismo real de alerta — solo la tabla y una consulta de prueba
`packages/db/migrations/0033_calendario_fiscal.sql` + `tests/integration/fiscal/calendario-fiscal.spec.ts:1-5`
La migración crea `fiscal_obligation`/`sat_filing_approval` con RLS y el trigger de aprobación (bien hecho, ver "lo que revisé y está bien"), pero no hay ninguna ruta de API ni job que lea `fiscal_obligation` y dispare una alerta real (WhatsApp/Daily Flash/dashboard). El propio comentario del test lo admite: *"Sin una ruta de API dedicada todavía (ver README de apps/api), este chequeo corre directamente contra `fiscal_obligation` bajo RLS real"* — el test solo verifica que una consulta SQL directa filtra bien por `due_date - current_date <= 5`, nunca que alguien reciba la alerta.
Consecuencia: REQ-BO-008 exige "alertas anticipadas (≥5 días)" para IVA/ISR/DIOT/ISH/balanza/predial/licencias/IMSS — hoy, aunque la obligación exista en la tabla con fecha vencida, nadie se entera hasta que el gerente entre manualmente a consultarla. Es la definición de "falla silenciosa" de la escala del rubro.
Causa raíz probable: se construyó el modelo de datos y su aislamiento (RLS/aprobación) antes que el job de notificación; el job nunca se conectó al Daily Flash (H16-015) ni a ningún canal.

### [MEDIO] La tasa de ISH sembrada por defecto (3%) no corresponde a la tasa citada por la fuente para Quintana Roo (5%)
`packages/db/src/seed.ts:138-141`
```
insert into public.hotel_tax_config (hotel_id, tenant_id, iva_rate, ish_rate, rfc_emisor)
values ($1, $2, 0.16, 0.03, $3);
```
El PDF H16 (p.16) cita el ISH de Quintana Roo como *"5 % [DATO]"*; el seed usa `0.03`. El endpoint real de configuración (`PUT /hoteles/:hotelId/impuestos`, `apps/api/src/routes/tarifas.ts:197-216`) exige que `owner`/`gm` lo fijen explícitamente y no tiene ningún default de producción visible en el código de aplicación — el `0.03` solo vive en el seed de desarrollo/demo y en el `default` de la columna (`packages/db/migrations/0013_tarifas_avanzadas_y_politicas.sql:54`). No verificable en esta ronda si algún flujo de onboarding real deja ese default sin que el hotel lo corrija explícitamente (no encontré una ruta de "alta de hotel" que dependa de ese default fuera del seed).
Consecuencia: si un hotel nuevo queda operando aunque sea un día con el default de la columna (`0.03`) antes de que alguien configure el valor real, todos los cargos de esa ventana llevan ISH al 3 % en vez del que corresponda a su estado — un valor que nadie decidió a propósito.
Causa raíz probable: el `default` de la columna en la migración 0013 fue puesto como valor de arranque razonable, sin ligarlo a `state_code` (que sí existe en `hotel_tax_config` desde la migración 0030) para que el propio esquema sugiriera/forzara el valor correcto por estado.

## Lo que revisé y está bien

- **Idempotencia de timbrado (REQ-BO-002):** `apps/api/src/routes/cfdi.ts:173-183` revisa si ya existe un CFDI `tipo='hospedaje'` para el folio ANTES de tocar `withIdempotency`, y `packages/db/migrations/0032_cfdi_emision.sql:37-40` respalda esto con un índice único parcial (`cfdi_emision_folio_hospedaje_unq`/`cfdi_emision_payment_unq`) como última línea de defensa contra una carrera — dos intentos de timbrar el mismo folio devuelven el mismo UUID, verificado también por `tests/integration/cfdi/idempotencia-timbrado.spec.ts`.
- **Night audit no postea hospedaje dos veces (REQ-REV-013):** `packages/db/migrations/0031_night_audit.sql:38-68` usa `pg_advisory_xact_lock` + `unique(hotel_id, business_date)` para serializar dos corridas concurrentes del mismo día, y `apps/api/src/jobs/nightAudit.ts:77-84` además usa un índice único parcial sobre `(folio_id, stay_date) where concept='hospedaje'` para que el `INSERT` del cargo de la noche sea idempotente por sí mismo, no solo por el `run` — dos ejecuciones no duplican el cargo de hospedaje.
- **Aprobación humana antes de presentar al SAT con e.firma (REQ-BO-006):** `packages/db/migrations/0033_calendario_fiscal.sql:34-52` tiene un trigger `fiscal_obligation_requires_approval_trg` que bloquea marcar una obligación `'presentada'` si no existe una fila en `sat_filing_approval`, y la política RLS (`sat_filing_approval_owner_gm_insert`) solo deja insertar esa aprobación a `owner`/`gm`, nunca a `accountant` que la prepara — defensa en profundidad real (BD, no solo API).
- **Propina excluida del CFDI y sin impuesto (REQ-BO-001):** `UNTAXED_CONCEPTS` en `folioEngine.ts:23` y la consulta `where folio_id = $1 and concept <> 'propina'` en `cfdi.ts:215` coinciden; probado explícitamente por `tests/integration/contracts/cfdi/hospedaje.spec.ts:103-131` (caso 4).
- **RFC genérico extranjero y factura global (REQ-BO-001):** `apps/api/src/routes/cfdi.ts:196-208` fuerza `XEXX010101000`/`S01` y `XAXX010101000`/`S01` como constantes de catálogo SAT (correctamente NO parametrizadas, son claves oficiales fijas) **ignorando lo que el body pida** — probado por `tests/integration/contracts/cfdi/hospedaje.spec.ts:50-84` (casos 1 y 2, incluyendo un intento deliberado de mandar otro RFC/uso).
- **Tasas de IVA/ISH nunca hardcodeadas como "verdad" del sistema:** `packages/domain-hotel/src/taxes.ts` y `fiscalHospedaje.ts` reciben la tasa siempre como parámetro (documentado explícitamente en los comentarios de cabecera de ambos archivos), y `loadTaxConfig`/`loadHotelMoneyConfig` (`apps/api/src/pms/taxConfig.ts`) fallan con 400 explícito si el hotel no tiene fila configurada, en vez de asumir 16/0 % en silencio — el defecto real está en cómo se **aplica** por concepto (hallazgo CRÍTICO arriba), no en dónde vive la tasa.
- **Cotización pre-reserva no mezcla A&B con hospedaje:** `packages/domain-hotel/src/quote.ts:132-143` solo suma tarifas de `rate_plan` (habitación) antes de aplicar impuestos — el motor de cotización en sí no tiene el defecto de ISH-sobre-A&B, que aparece después, en el motor de folio (`folioEngine.ts`).
- **UI no maquilla el PAC simulado como real:** `apps/web/src/components/folio/FolioPanel.tsx:604-605` muestra explícitamente "Timbrado vía PAC simulado (real pendiente de credenciales -- ver README de apps/api)" antes de que el usuario timbre — no encontré ningún texto que afirme un timbrado real cuando es el fixture.
- **DSA calculado sobre cuartos-noche reales, no una cifra fija:** `apps/api/src/routes/cfdi.ts:213,219,226` cuenta cargos `concept='hospedaje' and stay_date is not null` (una fila real por noche posteada por night audit) y multiplica por `dsaPerNight` configurado por hotel — coincide con la norma citada (H16-011, MXN 20/cuarto-noche, parametrizado por municipio).

## Lo que NO alcancé a revisar

- No existe una ficha de norma versionada (`normas/*.yaml` o equivalente) para ISH por estado ni para el complemento de hospedaje del CFDI 4.0 — toda esta auditoría se hizo contra `docs/referencia/03-investigacion-H12-H21.md` y el PDF de investigación H16, nunca contra una fuente primaria SAT/SATQ estructurada dentro del repo. Se recomienda crear esa ficha antes de la próxima ronda para que la comparación deje de depender de releer el PDF cada vez.
- No pude (ni debía, ADR-007) probar contra un PAC real ni contra el SAT: toda la revisión de CFDI corrió contra `FakeGenericPacAdapter`/`DualPacCfdiPort`. Cualquier validación de esquema XSD/Anexo 20 que un PAC real haría (y que aquí no existe) queda sin verificar.
- No revisé DIOT/ISR provisional/retención a plataformas digitales (`packages/domain-hotel/src/fiscalHospedaje.ts` funciones `computeDiotTotal`, `computeIsrProvisional`, `computeRetencionPlataformasDigitales`) más allá de leer el cálculo puro — no encontré ninguna ruta de `apps/api` que las invoque todavía, así que no pude verificar la base real que les llega en producción ni si sufren el mismo problema de mezcla de conceptos que el ISH.
- No revisé H16-005/006/013 (conciliación OTA, disputa de contracargos) ni H16-019 (Open Banking) — están fuera de `packages/domain-hotel`/`packages/mcp-servers/cfdi`/night audit, que fue el alcance que se me dio.
- No revisé el módulo de nómina/ISN/IMSS (H13/H16-009 columna ISN) más allá de `computeIsn` en `fiscalHospedaje.ts` — no encontré una ruta de aplicación que lo consuma.
- No verifiqué si existe (fuera del alcance dado) una ruta de "alta de hotel" en onboarding que dependa del default `ish_rate=0.03` de la migración 0013 más allá del seed de desarrollo — lo marco como hallazgo MEDIO con esa salvedad explícita.
