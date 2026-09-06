# Seguridad y aislamiento multi-tenant — auditoría 2

**Nota: 2/10** (antes 3/10). Razón del movimiento: **deuda que cobró factura**. El
arreglo de auditoría-1 para `record_audit_log()` (migración `0016`) instauró el patrón
correcto — "toda función `SECURITY DEFINER` valida `_tenant_id`/`_hotel_id` contra
`current_tenant_ids()`/`current_hotel_ids()` del actor real cuando `auth.uid()` no es
nulo" — y ese patrón sí se aplicó correctamente en código nuevo de esta ronda
(`register_identity_document`/`read_identity_vault_document`, migración `0051`). Pero
nunca se convirtió en una regla exigida (no hay lint, no hay test de arquitectura, no
hay checklist de PR) para *toda* función `SECURITY DEFINER` nueva — y en la misma
tanda de migraciones (H5/H6b) reaparece exactamente el defecto que costó el crítico de
la ronda anterior, esta vez en cuatro lugares distintos: reverso de cargos de folio,
cierre de caja (night audit), aprobación de presentación SAT, y reloj de retención de
la bóveda de identidad. Además, el mismo patrón de "el esquema confía en que la
aplicación mande el hotel correcto" que auditoría-1 cerró para `room_type_id`
(`0018_room_type_id_fk_compuesta_por_hotel.sql`) nunca se generalizó a `guest_id`, y ese
vacío es la puerta por la que un huésped de un hotel termina con su documento de
identidad depositado en la bóveda de OTRO hotel.

El riesgo mayor hoy: `apps/api/src/routes/checkinOnline.ts:55-79` (RPC
`complete_checkin_public`, migración `0054`) permite a cualquier `owner/gm/frontdesk/
reservations` de **cualquier hotel A** emitir un enlace de check-in online válido para
una `reservation_id` que en realidad pertenece a **otro hotel B** de la plataforma —
`checkin_link.reservation_id` no está scoped a `hotel_id` (ni por FK compuesta ni por
policy) — y cuando el huésped legítimo de Hotel B completa ese check-in, su documento
de identidad (pasaporte/INE, cifrado) termina archivado en la bóveda de identidad de
Hotel A, y su ficha real de `guest` es sobrescrita con los datos que Hotel A capturó.

## Alcance verificado

Snapshot auditado: `.claude/worktrees/auditoria-2-snapshot`. Cubrí las migraciones
`0001`–`0054` completas de `packages/db` (con foco adversarial en las nuevas de
H5/H6b/H7/P0: `charge`/`payment`/`night_audit_run`/`cfdi_emision`/`fiscal_obligation`/
`sat_filing_approval`/`housekeeping_task`/`maintenance_ticket`/`agent_approval`/
`conversation`/`message`/`agent_run`/`agent_config`/`roi_event`/`identity_vault`/
`identity_ref`/`checkin_link`/`checkin_submission`/`experience_catalog`/
`experience_order`/`local_knowledge_entry`), las rutas nuevas de `apps/api/src/routes/`
(folios, night-audit, cfdi, checkinOnline, identidad, mensajeria, aprobacionesWhatsapp,
housekeeping, mantenimiento, experienciasPublicas, roi, backOffice), el cifrado de la
bóveda (`apps/api/src/lib/identityEncryption.ts`), los adaptadores de webhook/HMAC
(`packages/mcp-servers/shared/src/hmac.ts`, `whatsapp/src/adapters/
fake-whatsapp-adapter.ts`) y `packages/mcp-servers/energy`/`locks` (ADR-011). **Antes**
de reportar nada, verifiqué contra el código actual (no de memoria del informe previo)
los cuatro hallazgos de `docs/auditoria-1/seguridad.md`: los dos CRÍTICOS
(`record_audit_log`, `outbox`/`idempotency_key`) están genuinamente **cerrados**
(migraciones `0016`/`0017`, leídas línea por línea) y probados
(`tests/adversarial/auditoria-1-bd-criticos.spec.ts`); el MEDIO (CORS) y el BAJO
(`Retry-After`) también están **cerrados** (`apps/api/src/app.ts:59-65`,
`apps/api/src/env.ts:40-55`) — ver "Hallazgos de auditoría-1 verificados" abajo. Ninguno
es reincidente tal cual; lo que reincide es la **clase** de defecto.

Corrí `npm audit` (0 vulnerabilidades — mejoró frente a la 1 alta de auditoría-1) y
verifiqué por lectura, sin poder ejecutar la suite completa dentro del snapshot: el
directorio vive bajo `.claude/worktrees/...` y `vitest.config.ts` excluye
deliberadamente `**/.claude/**` (línea del propio archivo: "checkouts de otros agentes
trabajando en paralelo"), así que ni siquiera con un `--config` alternativo pude aislar
una corrida estable — el snapshot demostró estar siendo modificado concurrentemente por
otro proceso mientras yo lo leía (dos archivos de prueba temporales
`tests/adversarial/_tmp_audit2_*` aparecieron y cambiaron de nombre entre una lectura y
otra). No usé el contenido de esos archivos temporales como evidencia — cada hallazgo de
abajo lo verifiqué yo mismo leyendo la migración y la ruta real, con cita de línea.

## Hallazgos

### [CRÍTICO] El check-in online cruza de hotel: el documento de identidad de un huésped de Hotel B termina en la bóveda de Hotel A
`packages/db/migrations/0054_checkin_online.sql:17-30` (tabla `checkin_link`, sin FK ni policy que ligue `reservation_id` a `hotel_id`), `:44-48` (policy `checkin_link_tenant_insert`), `apps/api/src/routes/checkinOnline.ts:55-79` (handler que confía en el `reservationId` del path)

`checkin_link.reservation_id` es una FK simple a `reservation(id)` (línea 21) —a
diferencia de `room_type_id`, que auditoría-1 (D-C1) obligó a scoping compuesto por
`hotel_id` en `0018`—, y la policy de INSERT (`0054:44-48`) solo valida que el actor
tenga rol `owner/gm/frontdesk/reservations` **en el `hotel_id` que él mismo declara**,
nunca que ese `hotel_id` coincida con el hotel real dueño de `reservation_id`. El
handler de `apps/api` (`checkinOnline.ts:55-79`) toma `hotelId` y `reservationId` como
parámetros de ruta/URL y los inserta tal cual, sin cargar la reserva primero para
comparar su `hotel_id`.

Escenario: `reservations@hotel-A.demo` (rol `reservations`, sin ninguna membresía en
Hotel B) conoce el UUID de una reserva confirmada de Hotel B — algo plausible en
cualquier grupo hotelero real, porque `accountant`/`gm` de un grupo cubren varios
hoteles de la misma `org` (ADR-004, "alcance: un hotel (o grupo)") y comparten
credenciales o turnos con recepción. Ejecuta:

```
POST /hoteles/{hotelA}/reservas/{reservationIdDeHotelB}/checkin-link
```

`requireHotelMembership("hotelId")` (`middleware.ts:90-126`) solo valida que el actor
pertenezca a **Hotel A** (el de la URL) — nunca que `reservationId` pertenezca a Hotel
A también. La `INSERT` en `checkin_link` (`checkinOnline.ts:70-76`) queda con
`tenant_id=orgA, hotel_id=hotelA, reservation_id=<reserva real de Hotel B>`. El índice
único parcial `checkin_link_reservation_pendiente_idx` (`0054:36`) incluso permite que
esta operación **invalide** (vía el `UPDATE ... set status='expirado'` de
`checkinOnline.ts:65-68`) un enlace legítimo que Hotel B ya le hubiera mandado a su
propio huésped.

El huésped real de Hotel B (o el propio atacante, usando el `token` que Hotel A generó)
completa `POST /checkin-publico/{token}` con una MRZ válida y sus datos. Dentro de
`complete_checkin_public()` (`0054`, líneas ~95-165): `select * into v_res from
reservation where id = v_link.reservation_id` resuelve la reserva **real de Hotel B**;
`update public.guest set full_name=..., email=..., phone=... where id = v_res.guest_id`
sobreescribe el nombre/correo/teléfono del **guest real de Hotel B** con lo que se
capturó en el flujo de Hotel A; y `register_identity_document(v_link.tenant_id,
v_link.hotel_id, ...)` (0054, invocando 0051) archiva el documento de identidad cifrado
(pasaporte/INE) con `tenant_id=orgA`/`hotel_id=hotelA` — es decir, en la bóveda de
**Hotel A**, aunque la reserva y el huésped son de Hotel B.

Consecuencia: el documento de identidad de un huésped de Hotel B (dato personal
sensible, REQ-SEG-014/REQ-REC-011) queda alojado y legible por `owner/gm` de Hotel A
vía `read_identity_vault_document()`, un hotel con el que ese huésped nunca tuvo
relación; el registro real de huésped de Hotel B queda corrompido (correo/teléfono
sustituidos) sin que Hotel B se entere, hasta que intente contactar a su propio
huésped; y el enlace legítimo de Hotel B para su propio huésped puede quedar invalidado
por el ataque. Es exactamente la categoría "un dato de huésped sale de la bóveda... o
cruza de un hotel a otro" que este rubro pondera como CRÍTICO máximo.

Causa raíz probable: `checkin_link`/`checkin_submission` repiten, en H6b/P0, el mismo
patrón de FK sin scope compuesto que auditoría-1 encontró en `room_type_id` (D-C1) y que
solo se corrigió ahí, no como regla general para toda tabla nueva con una referencia a
otra entidad "propietaria de hotel".

### [CRÍTICO] `mark_charge_reversed()` (SECURITY DEFINER) no valida que el actor pertenezca al hotel del cargo: cualquier staff autenticado reversa un cargo de cualquier hotel
`packages/db/migrations/0030_folio_engine.sql:29-46` (función), `:48-49` (grant)

La función es `security definer`, no compara `_charge_id` contra ninguna membresía del
actor, y solo verifica que el cargo exista y no esté ya reversado:

```sql
create or replace function public.mark_charge_reversed(_charge_id uuid, _reversal_charge_id uuid)
...
security definer
as $$
  update public.charge set reversed_by = _reversal_charge_id
  where id = _charge_id and reversed_by is null
  returning * into v_row;
```

y se otorga sin restricción: `grant execute on function public.mark_charge_reversed(uuid, uuid) to atiende_app, authenticated;` (línea 41). El comentario del propio archivo (líneas 24-28) admite explícitamente el mismo razonamiento que auditoría-1 marcó como defecto en `record_audit_log`: *"la autorización real ya ocurrió en la capa de aplicación... antes de llamarla"*.

Escenario: `housekeeping@hotel-A.demo` (rol sin acceso a dinero, ni membresía en Hotel
B) abre una sesión real (`set local role authenticated` + `set_config` del propio
`auth.uid()`, el mismo mecanismo de `apps/api/src/db.ts`/`withAppSession`) y, sin pasar
por `apps/api` en absoluto, ejecuta directamente:

```sql
select public.mark_charge_reversed('<charge-id-real-de-hotel-B, ej. cargo de hospedaje de $18,500>', gen_random_uuid());
```

La función no comprueba `current_hotel_ids()` ni `can_access_money()`: el cargo de
Hotel B queda marcado `reversed_by = <uuid arbitrario que ni siquiera es un cargo
real>`, sin que exista una fila de reverso trazable en `charge` (a diferencia del flujo
real de `apps/api`, que primero inserta el cargo de signo contrario) y sin
`record_audit_log` (esa llamada la hace la ruta, no la función). El folio de Hotel B
queda con un cargo "reversado" fantasma, sin el correspondiente crédito, y sin rastro
en `audit_log`.

Consecuencia: un empleado de un hotel sin ningún rol de dinero puede alterar el saldo
de folio de **otro hotel de la plataforma**, sin dejar auditoría, y sin que la ruta
`POST /hoteles/:hotelId/folios/:folioId/cargos/:chargeId/reverso` (que sí valida
`hotelId`/`folioId` correctamente, `folios.ts:340-355`) sea necesaria para explotarlo —
el defecto vive en la función, no en la ruta.

Causa raíz probable: mismo patrón que `record_audit_log` antes de `0016` — la función
confía en que solo `apps/api` la invoca con parámetros ya verificados.

### [CRÍTICO] `night_audit_claim()`/`night_audit_finish()` (SECURITY DEFINER) filtran y permiten falsificar el cierre de caja de cualquier hotel
`packages/db/migrations/0031_night_audit.sql:29-58` (`night_audit_claim`), `:76-92` (`night_audit_finish`), `:59` y `:93` (grants)

Ninguna de las dos funciones compara `_tenant_id`/`_hotel_id`/`_run_id` contra
`current_tenant_ids()`/`current_hotel_ids()`, y ambas se otorgan a `authenticated` sin
restricción de rol (ni siquiera `can_access_money`, que sí protege la tabla
`night_audit_run` por policy de SELECT — la función la evita por completo al ser
`security definer`).

**Fuga**: `night_audit_claim(_tenant_id, _hotel_id, _business_date)` primero intenta
reclamar la corrida (`insert ... on conflict do nothing`); si ya existe una corrida
completada para ese `(hotel_id, business_date)`, la devuelve tal cual — incluyendo
`summary`, que contiene (`apps/api/src/jobs/nightAudit.ts:28-29,111-116`)
`postedCharges` (`reservationId`, `folioId`, `amount`, `taxAmount` por cada cargo de
hospedaje posteado esa noche) y `noShows` (`reservationId`, `chargeAmount`). Escenario:
`maintenance@hotel-A.demo` (rol sin acceso a dinero) ejecuta, con sesión real pero sin
pasar por `apps/api`:

```sql
select * from public.night_audit_claim('<org-de-hotel-B>', '<hotel-B-id>', '2026-09-05');
```

Si Hotel B ya cerró esa fecha, la respuesta incluye el desglose financiero completo de
ese cierre — montos, `reservationId`/`folioId` reales — de un hotel con el que el actor
no tiene ninguna relación.

**Falsificación**: `night_audit_finish(_run_id, _summary)` hace `update
night_audit_run set status='completado', summary=_summary, completed_at=now() where
id=_run_id` sin validar propiedad del `_run_id` **ni que la corrida siga
`en_progreso`** — puede invocarse una segunda vez sobre un `run_id` ya `completado`
(de cualquier hotel) para **reemplazar** el resumen de un cierre de caja ya cerrado y
presumiblemente ya reportado a gerencia, con un `_summary` jsonb arbitrario.

Consecuencia: fuga de datos financieros por-reserva de cualquier hotel de la plataforma
hacia cualquier rol sin acceso a dinero, y una vía para que un actor externo al hotel
reescriba el cierre de caja ya firmado de otro hotel — el mismo tipo de "evidencia
forense de la plataforma completa es falsificable" que auditoría-1 marcó como el
hallazgo más grave del ciclo anterior, ahora sobre el cierre contable diario en vez del
`audit_log`.

Causa raíz probable: mismo patrón de confiar en el llamador; agravado porque ni
siquiera hay guarda de "no re-terminar una corrida ya completada".

### [CRÍTICO] `sat_filing_approval` no valida que su `hotel_id`/`tenant_id` correspondan a la `fiscal_obligation` que aprueba: la aprobación humana exigida por e.firma se puede forjar desde cualquier hotel
`packages/db/migrations/0033_calendario_fiscal.sql:33-45` (trigger `fiscal_obligation_requires_approval`), `:63-68` (policy `sat_filing_approval_owner_gm_insert`)

El trigger que exige aprobación humana antes de marcar una obligación fiscal
`'presentada'` solo comprueba **existencia** de alguna fila en `sat_filing_approval`
para ese `obligation_id`, sin comparar su `hotel_id`/`tenant_id`:

```sql
if not exists (select 1 from public.sat_filing_approval where obligation_id = new.id) then
  raise exception 'presentacion_no_autorizada: ...';
end if;
```

y la policy de INSERT de `sat_filing_approval` solo exige que el actor tenga rol
`owner`/`gm` **en el `hotel_id` que la propia fila declara** — nunca que ese `hotel_id`
sea el mismo que el de la `fiscal_obligation` referenciada por `obligation_id`:

```sql
create policy "sat_filing_approval_owner_gm_insert" on public.sat_filing_approval for insert to authenticated
  with check (tenant_id = any (current_tenant_ids()) and has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
```

Escenario: `accountant@hotel-B.demo` (rol `accountant`, incluido en
`fiscal_obligation_admin_update` pero **no** en `sat_filing_approval_owner_gm_insert`,
precisamente porque el diseño exige que sea un `owner`/`gm` — nunca el mismo
`accountant` — quien autorice) es también `owner` de un hotel-C propio, sin relación
con la obligación de Hotel B (multi-propiedad, patrón real de ADR-004). Primero, con su
sesión de `owner` de Hotel C, inserta:

```sql
insert into public.sat_filing_approval (tenant_id, hotel_id, obligation_id, approved_by, nota)
values ('<org-de-hotel-C>', '<hotel-C-id>', '<obligation-id-real-de-hotel-B, ej. DIOT con e.firma>', auth.uid(), 'aprobado');
```

La policy lo acepta: `tenant_id`/`hotel_id` coinciden con su propia membresía de
`owner` en Hotel C; nada compara `obligation_id` contra el `hotel_id` real de esa
obligación (Hotel B). Después, con su sesión de `accountant` en Hotel B (rol que sí
tiene UPDATE sobre `fiscal_obligation` vía `fiscal_obligation_admin_update`), ejecuta
`update fiscal_obligation set status='presentada' where id='<esa obligación>'`: el
trigger encuentra la fila de "aprobación" (la de Hotel C, ajena) y la deja pasar.

Consecuencia: la obligación fiscal de Hotel B que requiere e.firma (DIOT/IVA-ISR) queda
marcada `presentada` sin que ningún `owner`/`gm` de **Hotel B** la haya autorizado
jamás — exactamente el control que REQ-BO-006/GOB-041 y el propio comentario de la
migración (`0033:1-4`) dicen garantizar ("ninguna presentación al SAT ocurre sin una
fila de aprobación registrada"). Nota: no hay todavía ninguna ruta en `apps/api` que
exponga `fiscal_obligation`/`sat_filing_approval` (verificado por `grep`, 0 resultados
en `apps/api/src/routes/`), así que hoy el vector requiere sesión SQL directa, no un
bug de ruta — mismo criterio de reachability que los dos hallazgos anteriores, y mismo
umbral que auditoría-1 usó para `record_audit_log`.

### [ALTO] `reservation.guest_id` no está scoped a `hotel_id`: una reserva puede referenciar al huésped de otro hotel
`packages/db/migrations/0006_reservation.sql:19` (`guest_id uuid references public.guest(id)`, FK simple), `apps/api/src/routes/reservas.ts:222-224,262-275` (INSERT que usa `body.guestId` sin validar propiedad)

`createReservationSchema` (`reservas.ts:73-82`) solo exige que `guestId` sea un UUID
válido; el INSERT (`reservas.ts:262-275`) lo persiste tal cual. Ni la policy de INSERT
de `reservation` (`0006:129-133`, solo valida `tenant_id`/`hotel_id`/rol de quien
escribe) ni ninguna FK compuesta impiden que `guest_id` apunte a un `guest` de otro
`hotel_id` (o incluso de otro `org`). Es la misma clase de hallazgo que auditoría-1
cerró para `room_type_id` (D-C1, migración `0018`) pero nunca se generalizó a
`guest_id`. Es la causa raíz que hace posible el CRÍTICO de `checkin_link` de arriba:
sin este vacío, una reserva de Hotel A jamás podría, siquiera en teoría, resolver a un
`guest` de Hotel B.

Escenario: `reservations@hotel-A.demo` ejecuta `POST /hoteles/{hotelA}/reservas` con
`{roomTypeId, checkInDate, checkOutDate, guestId: '<guest real de Hotel B>'}` — la
reserva se crea con `hotel_id=hotelA`, `guest_id=<guest de Hotel B>`, sin ningún
rechazo. El listado `GET /hoteles/{hotelA}/reservas` no expone el nombre (el `LEFT
JOIN` a `guest` queda filtrado por la RLS de `guest`, que exige `hotel_id = any
(current_hotel_ids())` del propio Hotel A — devuelve `NULL`, mostrado como "Sin huésped
registrado"), así que esta vía sola no filtra el nombre; pero cualquier función
`SECURITY DEFINER` que resuelva `guest_id` sin pasar por RLS (como
`complete_checkin_public`, arriba) sí lo hace.

Consecuencia: además de habilitar el CRÍTICO de arriba, deja el propio `reservation` en
un estado que la base debería impedir estructuralmente (mismo criterio que "overbooking
es un hallazgo de esquema, no de aplicación" que este rubro exige) — cualquier código
futuro que confíe en `reservation.guest_id ⇒ guest.hotel_id = reservation.hotel_id`
(una asunción razonable) hereda la fuga sin saberlo.

Causa raíz probable: `0006_reservation.sql` no adoptó el mismo criterio de
`(hotel_id, id)` único + FK compuesta que `0018` sí aplicó a `room_type_id`.

### [ALTO] `set_identity_checkout()` (SECURITY DEFINER) permite alterar el reloj de retención de la bóveda de identidad de otro hotel
`packages/db/migrations/0051_identity_vault.sql:158-166` (función), `:167` (grant)

A diferencia de `register_identity_document`/`read_identity_vault_document` (mismo
archivo, líneas 84-96 y 130-136), que sí validan membresía real del actor cuando
`auth.uid()` no es nulo, `set_identity_checkout` no valida nada:

```sql
create or replace function public.set_identity_checkout(_reservation_id uuid, _checkout_at timestamptz default now())
...
as $$
  update public.identity_vault set checkout_at = _checkout_at
  where reservation_id = _reservation_id and checkout_at is null;
  ...
$$;
```

otorgada sin restricción a `authenticated`. Escenario: `frontdesk@hotel-A.demo`, con
sesión real pero sin membresía en Hotel B, ejecuta directamente `select
public.set_identity_checkout('<reservation-id-real-de-hotel-B>', now() - interval '31
days')`. El job de purga (`apps/api/src/jobs/purgeIdentityVault.ts`,
`identity_vault_checkout_idx`) toma esa fecha como real y, en su siguiente corrida,
**borra físicamente** el documento de identidad de Hotel B aunque el huésped siga
hospedado (checkout real todavía no ocurrido) — destruyendo evidencia de verificación
de identidad que Hotel B podría necesitar para una disputa/reclamo, sin que Hotel B lo
haya autorizado ni se entere.

Consecuencia: pérdida de evidencia de cumplimiento (REQ-REC-011/REQ-SEG-014) de un
hotel por acción de un actor de otro hotel, sin rastro (la purga no registra quién
adelantó el `checkout_at`).

Causa raíz probable: la misma migración institucionalizó el patrón correcto dos
funciones antes (líneas 84-96) y lo omitió aquí — refuerza que el patrón nunca se volvió
una regla mecánica, sino una decisión caso por caso del autor de cada función.

## Hallazgos de auditoría-1 verificados (cerrados, no reincidentes)

- **[CRÍTICO] `record_audit_log()` falsificable entre organizaciones** — cerrado.
  Verifiqué `packages/db/migrations/0016_record_audit_log_valida_actor.sql:24-42`: la
  función ahora valida `_tenant_id`/`_hotel_id` contra `current_tenant_ids()`/
  `current_hotel_ids()` cuando `auth.uid()` no es nulo, con `errcode = '42501'`.
- **[CRÍTICO] `outbox`/`idempotency_key` solo aislaban por organización** — cerrado.
  Verifiqué `packages/db/migrations/0017_outbox_idempotency_scope_hotel_y_rol.sql`:
  las policies de `outbox` ahora exigen `hotel_id = any(current_hotel_ids())` **y**
  `can_access_money(hotel_id)`; `idempotency_key` exige rol de dinero en el org.
- **[MEDIO] CORS sin restricción de origen** — cerrado. Verifiqué
  `apps/api/src/app.ts:59-65` (`cors({ origin: deps.env.corsAllowedOrigins, ... })`) y
  `apps/api/src/env.ts:40-55` (obligatorio y sin `*` en producción).
- **[BAJO] Rate limit sin `Retry-After`** — cerrado. Verifiqué
  `apps/api/src/lib/errors.ts` (`Errors.rateLimited` adjunta `Retry-After`) y
  `apps/api/src/middleware.ts:33-49`. La limitación de fondo (contador en memoria de
  proceso, sin compartir entre instancias) sigue como deuda ya declarada, sin escalar a
  hallazgo nuevo porque no cambió.

## Lo que revisé y está bien

- **`packages/mcp-servers/whatsapp/src/adapters/fake-whatsapp-adapter.ts:114-124`** +
  **`packages/mcp-servers/shared/src/hmac.ts:24-36`**: verificación HMAC con
  `timingSafeEqual`, fail-closed ante firma ausente/secreto ausente/longitud distinta.
  `apps/api/src/routes/mensajeria.ts:102-135` y `aprobacionesWhatsapp.ts:26-68` dedupe
  el replay por `event_id` vía `idempotency_key` **persistente** (no solo el
  `InMemoryReplayGuard` del adaptador, que por diseño se reinicia en cada request al
  instanciarse un adaptador nuevo — el propio comentario del archivo lo documenta y la
  defensa real es la tabla).
- **`apps/api/src/routes/checkinOnline.ts:100-144`** (una vez descontado el defecto de
  scoping de arriba): el enlace es de un solo uso REAL — `complete_checkin_public()`
  (`0054`) usa `select ... for update` sobre `checkin_link` y marca `completado` solo al
  final de una transacción exitosa; un segundo intento con el mismo token siempre
  encuentra `status='completado'` y es rechazado. Token de 256 bits
  (`randomBytes(32)`), no adivinable.
- **`packages/db/migrations/0050_experience_catalog_and_public_order.sql`**
  (`order_experience_public`): el precio SIEMPRE se lee de `experience_catalog.price`
  en servidor — la función no declara ningún parámetro de precio/total. Verificado
  también por `tests/adversarial/rpc-security-definer.spec.ts` (precio alterado en el
  body es ignorado). Mensaje de error genérico ante código/apellido incorrectos
  (sin distinguir cuál falló), igual que `cancel_reservation_public` (`0013`).
- **`packages/db/migrations/0013_tarifas_avanzadas_y_politicas.sql:193-280`**
  (`cancel_reservation_public`): confirmación aleatoria de 8 hex (derivada de
  `gen_random_uuid()`/`sha256`, no secuencial ni adivinable), mensaje de error genérico,
  protegida además por el rate limit global por IP (`apps/api/src/app.ts:76`).
- **`packages/db/migrations/0051_identity_vault.sql`**: `identity_vault` sin GRANT
  alguno a `authenticated` (ni RLS "vacía" — "permission denied" real, verificado
  también por `tests/adversarial/boveda-identidad.spec.ts`, caso "consulta directa...
  es RECHAZADA"); sin columna de imagen en el esquema (estructuralmente no hay dónde
  guardar la foto del documento); `register_identity_document`/
  `read_identity_vault_document` sí validan membresía real del actor.
- **`apps/api/src/lib/identityEncryption.ts`**: AES-256-GCM con IV aleatorio de 12
  bytes por campo, `authTag` verificado al descifrar; `IDENTITY_VAULT_ENCRYPTION_KEY`
  sin default silencioso en producción (mismo patrón que `JWT_SECRET`, ya elogiado en
  auditoría-1) — no es un "fallback derivado de otro secreto", es la ausencia de
  fallback en producción.
- **`packages/mcp-servers/locks/src/port.ts`** y **`.../simulated-lock-adapter.ts`**:
  `LockCommandOrigin` excluye `"voz"`/`"regla_automatica_energia"` a nivel de tipo;
  `issueKey`/`revokeKey` exigen doble confirmación de actores distintos +
  `pmsEvidence.checkInPaid && identityVerified`, fail-closed, verificado en el
  adaptador simulado. Sin ningún import de `mcp-locks` desde `packages/mcp-servers/
  energy` (verificado por `grep` recursivo, 0 resultados) — el aislamiento estructural
  de ADR-011 se sostiene, aunque el script de análisis estático dedicado que ADR-011
  promete (`scripts/checks/lockport-inalcanzable-desde-energia-y-voz.ts`) todavía no
  existe (ver "no alcancé").
- **`packages/mcp-servers/energy/src/port.ts:19-20,82-90`**: guarda física 20-27°C
  (`HVAC_MIN_CELSIUS`/`HVAC_MAX_CELSIUS`) rechaza el setpoint fuera de rango "incluso
  con aprobación válida" (comentario explícito, verificado en el tipo del error
  `HvacGuardViolationError`) — nunca hace *clamp* silencioso.
- **`apps/api/src/middleware.ts:90-126`** (`requireHotelMembership`): sigue siendo
  segunda capa real (re-resuelve `orgId`/`hotelRole` en vivo contra `hotel_staff`,
  ignora el claim del JWT), y **48** rutas de `apps/api/src/routes/*.ts` la usan; las 5
  que no (`auth`, `cancelacionPublica`, `health`, `hoteles`, `metrics`) están
  correctamente exentas por diseño (sin sesión de staff o RLS-scoped por su cuenta).
- **`npm audit`**: 0 vulnerabilidades (mejoró frente a 1 alta en auditoría-1).
- **`packages/mcp-servers/energy/src/adapters/simulated-energy-adapter.ts:1`** y
  **`locks/src/adapters/simulated-lock-adapter.ts:1`**: ambos etiquetados `// SIMULADO`
  explícitamente en la cabecera y en `status().simulated === true` — nunca presentados
  como integración real.

## Lo que NO alcancé a revisar

- **Ejecución real de la suite** (`npm test`/`tsc`/`lint`) dentro de este snapshot: el
  propio `vitest.config.ts` excluye `**/.claude/**` (deliberado, para no duplicar
  corridas de otros agentes en paralelo) y el directorio demostró estar siendo escrito
  concurrentemente por otro proceso mientras yo auditaba (archivos `_tmp_audit2_*`
  aparecieron/cambiaron de nombre entre lecturas). No pude aislar una corrida estable
  con un config alternativo en el tiempo de esta ronda; todo lo reportado arriba lo
  verifiqué por lectura directa de migración + ruta + policy, no por ejecución.
- **Explotación de `sat_filing_approval` de punta a punta vía HTTP**: no existe
  todavía ninguna ruta en `apps/api` que exponga `fiscal_obligation`/
  `sat_filing_approval` (confirmado por `grep`, 0 resultados) — el hallazgo es real a
  nivel de esquema/RLS (alcanzable por sesión SQL directa) pero no lo pude encadenar
  hoy con un endpoint HTTP real porque ese endpoint no existe en este snapshot.
- **`packages/agent-core`**: no repetí la auditoría de aislamiento de contexto de
  prompt (`context.ts`/`tool.ts`) porque auditoría-1 la cubrió a fondo y el mandato de
  esta ronda pedía foco en las tablas/rutas nuevas de H5/H6b/H7/P0; no verifiqué si
  algún tool nuevo (`housekeepingTools.ts`, `messagingTools.ts`, `roiTools.ts`) rompe el
  patrón `properties: {}` — eso corresponde al rubro de tool calling.
- **`apps/web`**: no repetí la revisión de `localStorage`/CSP de auditoría-1 (sin
  hallazgo nuevo que reportar, sin cambios visibles en `apps/web/src/lib/api.ts`) ni
  audité las pantallas nuevas de housekeeping/mantenimiento/mensajería en el frontend
  (corresponde al rubro de frontend).
- **PMS/pagos reales (`packages/mcp-servers/pms`, `payments`)**: seguimos sin
  credenciales (ADR-007, "PENDIENTE DE CREDENCIALES"); no auditado contra un proveedor
  real, solo contra el contrato/fixture, y así se declara — no se probó ninguna
  integración con credenciales reales.
- **`scripts/checks/lockport-inalcanzable-desde-energia-y-voz.ts`**: ADR-011 lo exige
  como verificación de análisis estático; no existe en este snapshot (confirmé la
  ausencia del archivo, no solo que no lo revisé) — el aislamiento hoy se sostiene por
  ausencia de imports, no por un chequeo automatizado que lo impida a futuro. No lo
  elevé a hallazgo propio porque no hay violación activa, solo ausencia de la red de
  seguridad prometida.
