# Frontend/UX, accesibilidad y móvil — auditoría 2

**Nota: 6/10** (sin ronda anterior — no existe `docs/auditoria-0/frontend.md` ni
`docs/auditoria-1/frontend.md`; ambas rondas previas no auditaron este rubro. Esta
nota es línea base.)

Riesgo mayor hoy: el patrón "nunca inventar una cifra" (REQ-UX-002, P0) está bien
construido como componente (`DataState`/`EstadoVacio`/`EstadoError`/`StatCard`), pero
se rompe en el contenido que cada pantalla le pasa — un costo de mantenimiento en
$0.00 se ve como una medición real, y cuatro pantallas (`Recepción`, `Alimentos y
Bebidas`, `Disponibilidad`, `Huéspedes`) le echan la culpa a una integración externa
(PMS/POS/CRM) que en dos de ellas ni siquiera existe en el backend y en las otras dos
no es la fuente real del dato.

## Hallazgos

### [ALTO] Recepción y Alimentos y Bebidas llaman endpoints que no existen en la API, y el error se atribuye a una integración que no aplica
`apps/web/src/pages/Recepcion.tsx:15` (`listarMovimientosRecepcion` → `GET /hoteles/:hotelId/recepcion`), `apps/web/src/pages/Recepcion.tsx:30-31` (StatCards "Check-ins/Check-outs pendientes"), `apps/web/src/pages/AlimentosBebidas.tsx:13` (`listarPedidosAB` → `GET /hoteles/:hotelId/alimentos-bebidas`), `apps/web/src/pages/AlimentosBebidas.tsx:25-26`.

Verificado contra el backend: `apps/api/src/app.ts:150-177` registra 27 grupos de rutas y ninguno monta `/hoteles/:hotelId/recepcion` ni `/hoteles/:hotelId/alimentos-bebidas` — confirmado también con `grep -rn 'app.get(' apps/api/src/routes/*.ts`, que lista cada `GET` real del backend y no incluye ninguna de las dos.

Escenario: el gerente entra a `/recepcion` esperando ver los check-ins/check-outs del turno; `GET /hoteles/hotel-demo-centro/recepcion` responde 404 siempre (la ruta no existe, no es un problema de credenciales) — confirmado con la captura real `tests/e2e/screenshots/h5-recepcion-folio-1280x800.png`: el folio (que sí tiene backend) carga con datos reales (saldo $297.50), pero justo debajo la sección de movimientos muestra "No se pudo conectar con API de Atiende Hoteles" y las dos `StatCard` de arriba muestran "Pendiente de credenciales del PMS." Lo mismo en `/alimentos-bebidas`, con "Pendiente de conexión con el POS."

Consecuencia: el gerente/GM concluye que basta con conectar el PMS o el POS del hotel para que Recepción o Alimentos y Bebidas empiecen a funcionar. Eso es falso: ningún backend de esas dos pantallas se construyó todavía en este repo (H2/H6b cubrieron reservas/folio/housekeeping/mantenimiento, no estas dos). Conectar una integración real no cambiaría nada porque no existe endpoint que la consuma — riesgo de que el hotel invierta tiempo/dinero en gestionar una credencial que no resuelve el síntoma reportado, y dos secciones completas del panel quedan permanentemente inoperables sin que el mensaje lo diga honestamente.

Causa raíz probable: el texto "pendiente de credenciales de X" (correcto para una integración real que sí está pendiente, ver `EstadoError.tsx`) se copió a dos pantallas cuyo backend simplemente no existe.

### [ALTO] "Estimado: $0.00 MXN" en tickets de mantenimiento se ve como una medición real
`apps/web/src/pages/Mantenimiento.tsx:133` (`Estimado: ${t.costoEstimado.toFixed(2)} MXN`, renderizado sin condición), `apps/web/src/pages/Mantenimiento.tsx:151-195` (el formulario "Reportar" no tiene ningún campo para capturar un costo estimado), `apps/api/src/routes/mantenimiento.ts:32` (`estimatedCost: z.number().nonnegative().max(1_000_000).default(0)`), `packages/db/migrations/0043_maintenance_ticket.sql:25` (`estimated_cost numeric(12,2) not null default 0`).

Escenario: se reporta el ticket "Aire acondicionado no enfría (E2E)", severidad media, desde el formulario que solo pide habitación/título/descripción/severidad — nunca un estimado de costo. La API lo persiste con `estimated_cost = 0` por default y la tarjeta del ticket renderiza "Estimado: $0.00 MXN" incondicionalmente. Confirmado en la captura real `tests/e2e/screenshots/h6-mantenimiento-1280x800.png` y su versión `390x844`.

Consecuencia: el gerente ve un cero que se lee como "ya se cotizó y no cuesta nada" cuando en realidad nadie estimó ningún costo — es exactamente el ejemplo que `docs/auditoria/RUBROS.md` §1 usa para explicar "qué cuenta" en este rubro ("cifras inventadas o ceros que parezcan medición") y viola REQ-UX-002 (P0: "nunca simular una cifra").

Causa raíz probable: `TicketMantenimiento.costoEstimado` es `number`, no `number | null`, así que no hay forma de distinguir "sin estimar" de "estimado en cero" entre frontend y backend.

### [MEDIO] "Pendiente de credenciales del PMS/CRM" en pantallas cuyo dato es 100% interno
`apps/web/src/pages/Disponibilidad.tsx:64`, `apps/web/src/pages/Huespedes.tsx:27`.

`listarDisponibilidad` → `GET /hoteles/:hotelId/disponibilidad` (`apps/api/src/routes/disponibilidad.ts:1-6`, comentario propio del archivo: agrega `room_type`/`availability` del propio hotel, sin PMS). `listarHuespedes` → `GET /hoteles/:hotelId/huespedes` (`apps/api/src/routes/huespedes.ts:30-40`) hace `select ... from public.guest g left join public.reservation r` — tablas propias, sin CRM externo.

Escenario: si la API está caída o el hotel todavía no tiene tipos de habitación/huéspedes cargados, ambas `StatCard` muestran igual "Pendiente de credenciales del PMS[/CRM]." El propio `apps/web/src/pages/Resumen.tsx:9-16` documenta en comentario que este mismo texto era incorrecto ahí y ya se corrigió ("YA NO 'Pendiente de credenciales del PMS'... estas cifras nunca dependieron del PMS, salen de `reservation`/`availability` propias") — la corrección no se replicó en Disponibilidad ni en Huéspedes.

Consecuencia: mismo efecto que el hallazgo anterior pero en pantallas cuyo backend sí existe y sí funciona la mayor parte del tiempo (confirmado: la captura real de Disponibilidad muestra datos reales de Estandar/Suite) — el mensaje solo se ve en el borde (API caída/sin datos), pero cuando aparece manda al gerente a perseguir una integración que no es la causa.

Causa raíz probable: texto de `sinDato` copiado entre pantallas sin verificar la fuente real de datos de cada una.

### [MEDIO] Controles por debajo de 44px en el flujo de folio de recepción
`apps/web/src/components/folio/FolioPanel.tsx:308` (select "Concepto" al agregar cargo), `apps/web/src/components/folio/FolioPanel.tsx:456` (select "Método" al registrar pago), `apps/web/src/components/folio/FolioPanel.tsx:542` (select "Motivo de cierre"), `apps/web/src/pages/Recepcion.tsx:106` (select "Reserva"): los cuatro usan `className="...h-9..."` (36px).

Contraste con el resto del código: `apps/web/src/pages/Reservas.tsx:141` y `apps/web/src/pages/Configuracion.tsx:362` usan `h-11` (44px) para selects equivalentes; `packages/ui/src/components/ui/button.tsx:28-32` fija `h-11` como mínimo en *todas* las variantes de tamaño del `Button` compartido.

Escenario: en recepción (personal de pie, tablet/celular — el mismo contexto que RUBROS.md pide auditar para housekeeping), el selector de concepto de cargo, el de método de pago, el de motivo de cierre de folio y el selector de reserva miden 36px de alto, 8px por debajo del mínimo de 44px que exige REQ-UX-003.

Consecuencia: mayor probabilidad de toque fallido justo en la pantalla donde se cierra dinero (cargos/pagos/cierre de folio), inconsistente con el propio estándar que el resto del proyecto sí sigue.

Nota importante: la suite `tests/e2e/axe-accesibilidad.spec.ts` corre en viewport 390 y 1280 (proyectos `desktop`/`mobile` de `apps/web/playwright.config.ts:25-39`) y pasa sin violaciones serias/críticas (20/20 verde en `docs/logs/post-merge-p0-20260906-1026.log`) — pero **no** cubre `/recepcion` (ver hallazgo siguiente) y, aunque la cubriera, la regla de tamaño de objetivo táctil (`target-size`) es de WCAG 2.2 y la suite solo pide tags `wcag2a`/`wcag2aa` (WCAG 2.0/2.1, línea 29 del spec) — este hallazgo no está cubierto por la evidencia verde existente ni podría estarlo con la config actual.

Causa raíz probable: no hay un componente `<Select>` propio para los `<select>` nativos (solo hay primitivos Radix/shadcn sin usar aquí); cada pantalla repite la clase Tailwind a mano y no todas se actualizaron al mismo mínimo.

### [MEDIO] Columnas del folio ocultas en 390px sin ningún indicio de que hay scroll
`apps/web/src/components/folio/FolioPanel.tsx:108` (tabla de cargos) y `:155` (tabla de pagos), ambas envueltas en `<div className="overflow-x-auto">`.

Escenario: en viewport 390×844 la tabla de cargos (Concepto/Descripción/Monto/Impuesto/Acciones) y la de pagos (Pago/Método/Estado/Monto) son más anchas que la pantalla. Quedan en un contenedor con scroll horizontal propio (no de la página completa, que sí respeta `overflow-x: clip` de `packages/ui/src/index.css:142-149`), pero sin sombra, flecha ni ningún indicador de que hay contenido a la derecha. Confirmado en la captura real `tests/e2e/screenshots/h5-recepcion-folio-pagado-390x844.png`: al cargar, las columnas "Impuesto"/"Acciones" de cargos y el monto completo del pago ($297.50, solo se ve un "3" en el borde) quedan fuera de vista.

Consecuencia: el recepcionista puede no notar que existe el botón "Reversar cargo" o el monto de impuesto sin deslizar deliberadamente dentro de la tabla — se degrada exactamente el flujo que RUBROS.md identifica como el uso real (recepción operando de pie, tablet/celular).

Causa raíz probable: `Table` genérico (`packages/ui/src/components/ui/table.tsx`, shadcn de fábrica) sin una vista de tarjetas apiladas para mobile, a diferencia de `Housekeeping.tsx` que sí usa `<Card>` en vez de `<Table>` precisamente para evitar este problema en la misma familia de pantallas operativas.

### [BAJO] La suite axe no cubre `/recepcion`, la ruta que `ACEPTACION.md` nombra explícitamente
`tests/e2e/axe-accesibilidad.spec.ts:10-21` (arreglo `RUTAS`: login, resumen, reservas, disponibilidad, configuracion, housekeeping, mantenimiento, mensajeria, aprobaciones, agentes — sin `recepcion`).

`docs/ACEPTACION.md:416` exige "Suite `axe-core` sobre las rutas principales (login, reservas, folio, housekeeping)". "Folio" vive en `/recepcion` (`SeccionFolioHuesped`/`FolioPanel`, la pantalla con más diálogos/formularios de todo el rubro: agregar cargo, descuento, pago, cerrar folio, emitir CFDI), pero esa ruta no está en el arreglo.

Consecuencia: no hay evidencia automatizada de que la pantalla de folio pase axe sin violaciones serias — el criterio de aceptación específico para "folio" queda sin cubrir aunque el resto de la suite esté verde.

Causa raíz probable: omisión al armar el arreglo `RUTAS` cuando se agregó H5 (folio) después de escribir el spec original de H3.

### [BAJO] Sin formateador de moneda compartido
`apps/web/src/components/folio/FolioPanel.tsx:99,133,134,180,532` y usos equivalentes en `Resumen.tsx:61,67,94,101`, `Reservas.tsx:199,415`, `BackOffice.tsx:49,73,228`, `AlimentosBebidas.tsx:26,55`, `Mantenimiento.tsx:133-134` (15 ocurrencias totales de `` `$${x.toFixed(2 o 0)}` `` concatenado a mano).

Escenario: ninguna pantalla usa separador de miles — un total de $12,500.00 se lee "$12500.00" en todas partes por igual hoy (no hay divergencia visible entre pantallas todavía), pero `packages/domain-hotel/src/money.ts` solo expone `roundCurrency` (redondeo), no un formateador de despliegue, así que no hay ningún punto único que garantice que se mantenga consistente cuando alguien agregue la pantalla 16.

Consecuencia: legibilidad reducida en montos de 5+ dígitos (fácil confundir "$12500.00" a primera vista); deuda de consistencia, no un error activo hoy.

Causa raíz probable: no existe `formatMoney()` compartido en `packages/domain-hotel` ni en `@atiende/ui`.

## Lo que revisé y está bien

- **Patrón `DataState` (`apps/web/src/components/DataState.tsx`)** aplicado consistentemente en Housekeeping, Mantenimiento, Reservas, Huéspedes, Alimentos y Bebidas, Recepción, Disponibilidad, FolioPanel y Mensajería: `EstadoCargando` (`role="status" aria-busy`), `EstadoError` (`role="alert"`, nombra la integración, botón "Reintentar" conectado a `refetch()`) y `EstadoVacio` (`role="status"`, mensaje textual, nunca un cero) — la arquitectura del patrón es sólida; los hallazgos de arriba son sobre el *contenido* que cada pantalla le pasa, no sobre el componente.
- **`key` estables en todas las tablas de dinero revisadas**: `FolioPanel.tsx` usa `c.id`/`p.id`/`folio.id`; `Housekeeping.tsx` usa `h.roomId`; `Mantenimiento.tsx` usa `t.id`; `Reservas.tsx`/`AlimentosBebidas.tsx`/`Huespedes.tsx` usan el id real de cada fila. No encontré ningún `key={i}` sobre datos mutables/reordenables — el hallazgo de "key inestable" que RUBROS.md pide buscar explícitamente no se materializó en el código leído.
- **Bottom-nav móvil real** (`apps/web/src/layouts/AppShell.tsx:100-123`, `packages/ui/src/components/BottomNav.tsx`): el hueco que `docs/referencia/05-frontend-restaurantes.md §2.5` documenta como no resuelto en el origen (el panel admin de Restaurantes es 100% desktop, solo el flujo de repartidor tiene mobile real) sí está cerrado aquí — confirmado con `grep "hidden md:flex\|hidden md:block"`: los únicos bloques ocultos en mobile son el sidebar/header de escritorio, cada uno con su contraparte (`MobileHeader`+`BottomNav`, `min-h-11` = 44px). El único `hidden lg:flex` sin contraparte es la imagen decorativa del login (`Login.tsx:129`), que no es contenido operativo.
- **Tokens de color**: `packages/ui/src/index.css:16-78` reproduce exactamente los valores HSL de light mode documentados en `docs/referencia/05-frontend-restaurantes.md §1.3` (background/foreground/primary/muted/border/radius/sombras/gradientes), y además **completa el dark mode** para `gold/terracotta/sand/olive/cream/sidebar-*`/sombras/gradientes — cerrando textualmente la deuda que el propio documento de referencia señala del origen ("`.dark` no redefine esos tokens... deuda a tener en cuenta al portar").
- **Prueba de paridad visual real, no solo captura** (`tests/e2e/paridad-visual.spec.ts`): compara valores computados de CSS custom properties, familias tipográficas y un hash canónico de la geometría del SVG del logo contra un fixture extraído del repo real de Restaurantes (`tests/e2e/fixtures/restaurantes-referencia.json`) — corrige explícitamente (según su propio comentario) un hallazgo de `auditoria-1/pruebas.md` de que la prueba anterior "no comparaba nada".
- **`axe-accesibilidad.spec.ts`** corre de verdad en dos viewports (`desktop` 1280×800 y `mobile` 390×844, `apps/web/playwright.config.ts:25-39`) sobre 10 rutas y pasa 20/20 sin violaciones serias/críticas (`docs/logs/post-merge-p0-20260906-1026.log`).
- **`manifest.json`/service worker** (`apps/web/public/manifest.json`, `public/sw.js`, registro en `apps/web/src/main.tsx:13-16`): existen, `start_url`/`scope`/`display: standalone`/iconos están completos; confirma que "hotel-staff-pwa" de REQ-UX-003 es una descripción de `apps/web` (ver `manifest.json:4`), no una app faltante.
- **Cálculo de dinero fuera del cliente**: leí `FolioPanel.tsx` completo — nunca calcula impuesto/total por su cuenta, solo formatea lo que el backend devuelve (`domain-hotel`), consistente con el comentario del propio archivo.
- **`prefers-reduced-motion` respetado de forma global** (`packages/ui/src/index.css:218-242,250-252,267-269`), mismo patrón disciplinado que la referencia de Restaurantes.
- **Login** (`Login.tsx`): estados de error diferenciados (`ApiUnavailableError` con "pendiente de credenciales" vs. error genérico), sin inicio de sesión optimista fingido, `autoComplete`/labels `sr-only` correctos en ambos campos.

## Lo que NO alcancé a revisar

- No levanté yo mismo `api`+`web` con seeds; me apoyé en las capturas ya generadas el mismo día (timestamps `2026-09-06 10:27` en `tests/e2e/screenshots/*`, consistentes con el código leído) y en el log de la corrida P0 más reciente (`docs/logs/post-merge-p0-20260906-1026.log`) en vez de reproducir el arranque por mi cuenta.
- No relancé `npm run test:e2e`; confié en los logs verdes existentes (20/20 axe, 50/50 archivos de test en el gate P0).
- No revisé `Configuracion.tsx`, `Reputacion.tsx`, `BackOffice.tsx`, `Agentes.tsx`, `Aprobaciones.tsx` línea por línea con el mismo detalle que Housekeeping/Mantenimiento/FolioPanel/Recepción/Disponibilidad/Huéspedes — solo sus capturas y sus textos `sinDato` (no encontré el mismo patrón de mislabeling ahí, pero no puedo garantizar que no exista un caso adicional fuera de lo que grepeé).
- No medí contraste con una herramienta aparte; dependí de que `axe-core` con tags `wcag2aa` (que sí incluye `color-contrast`) pasara sin violaciones serias.
- No probé navegación 100% por teclado a mano en un navegador real (tab/enter/escape a través de los diálogos de folio); me apoyé en el `:focus-visible` global de `index.css:161-164` y en que axe no reportó nada, aunque axe no cubre orden de tabulación de forma exhaustiva.
- No tengo captura real en 390px de los diálogos (`Dialog`/`Sheet`) de "Nueva reserva" ni "Cerrar con costo" — solo leí su código; no verifiqué visualmente que quepan sin overflow en pantalla angosta real.
- No corrí Lighthouse formalmente (REQ-UX-003 lo menciona) — solo confirmé la existencia y contenido básico de `manifest.json`/`sw.js`, no un audit completo de instalabilidad.
