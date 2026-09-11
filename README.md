<p align="center"><img src="docs/brand/atiende-wordmark.svg" width="240" alt="atiende" /></p>

<h3 align="center">La plataforma agéntica que opera front-desk, PMS y folios de hoteles boutique en México.</h3>

---

> *Antes: la recepción concilia folios y tarifas a mano, hoja por hoja, hasta el
> corte de la noche. Ahora: un agente registra el check-in, cobra el cargo
> correcto, cierra el night-audit y sincroniza tarifas con el PMS — sin que
> nadie tenga que capturarlo dos veces.*

**El front-desk deja de ser trabajo manual.**

---

## El problema

Un hotel boutique en México suele operar con un equipo pequeño — a veces una
sola persona cubre recepción, night-audit y housekeeping en el mismo turno —
y con procesos que viven repartidos entre un PMS básico, hojas de cálculo y
WhatsApp. Cada reserva, cada cargo de folio y cada tarifa se captura a mano
en más de un lugar, el cierre de noche depende de que alguien no se olvide
de un paso, y no hay ningún sistema central que junte reservas, cobros,
housekeeping, mantenimiento y reputación en un solo lugar. El resultado es
tiempo de staff quemado en captura de datos en vez de en atender al huésped,
y decisiones de tarifa que se toman tarde o a ciegas porque nadie tiene el
panorama completo a tiempo.

## Mercado

México tiene cerca de 25,000 establecimientos de hospedaje registrados y más
de 900,000 cuartos (SECTUR/DATATUR, comunicado 2024) — un promedio de
alrededor de 36 cuartos por establecimiento. Es una cifra sobre el universo
completo de hospedaje, no exclusiva de hoteles boutique (no existe una
categoría oficial "boutique" en la estadística pública), pero es consistente
con un mercado dominado por propiedades pequeñas e independientes, muy
distinto del negocio de las grandes cadenas para las que se construye la
mayoría del software hotelero disponible hoy.

## Qué hace hoy

Este es un monorepo grande y activamente probado, no un prototipo. Lo que ya
está construido y con pruebas automatizadas:

- **Front-desk y check-in**: registro de huéspedes, check-in en línea,
  recepción, mensajería de WhatsApp con aprobación humana configurable para
  las acciones que lo requieren, y disclosure legal del uso de IA en el
  primer contacto.
- **Folios y cierre de noche**: motor de folios (cargos, pagos, ajustes),
  cálculo fiscal de hospedaje (impuestos, CFDI) y un endpoint de night-audit
  idempotente — correrlo dos veces para el mismo día siempre devuelve el
  mismo resumen ya cerrado, nunca lo duplica.
- **Motor de tarifas (revenue)**: pronóstico de pickup y de series de tiempo,
  un explicador de recomendaciones de precio (nunca una caja negra: cada
  recomendación cita por qué), un guardrail sobre el compset y un backtest
  walk-forward para validar el motor contra datos históricos antes de
  confiar en él.
- **PMS (Cloudbeds)**: el conector completo está construido y probado —
  mapeo de estados de reserva y housekeeping, reintentos con backoff,
  idempotencia real en cargos, concurrencia optimista en actualizaciones de
  reserva — pero sigue sin activarse en producción porque falta la
  credencial OAuth de un hotel piloto real (documentado como
  `[PENDIENTE DE CREDENCIALES]` en el propio código, no como "terminado").
- **Housekeeping y mantenimiento**: tickets, checador de asistencia del
  personal con cálculo de horas extra no autorizadas conforme al artículo
  132 fracción XXXIV de la LFT, y un conector genérico de salida hacia el
  sistema de una cadena (tipo HotSOS/Optii).
- **Identidad y privacidad**: bóveda de identidad de huéspedes con purga
  automática, consentimiento y aviso de privacidad (LFPDPPP) con el hook
  técnico de disclosure ya conectado en el primer contacto de WhatsApp.
- **Reputación y ROI**: monitoreo de reseñas y un panel de retorno de
  inversión con una línea base auditable.
- **Multi-tenant real**: 94 migraciones versionadas, con Row Level Security
  aplicada por fila desde la primera migración — el aislamiento entre
  hoteles no es una capa de aplicación, vive en la base de datos.
- **Agentes con gobierno**: cada acción de IA pasa por un núcleo compartido
  de presupuesto, aprobación y auditoría (`agent-core`) — ninguna acción de
  un agente queda sin rastro ni sin límite de gasto.

Lo que está construido pero deliberadamente pausado por decisión de negocio
(no por falta de código): la facturación SaaS del hotel corre hoy sobre un
adaptador simulado (sin cobro real) porque los precios de lista de los
planes siguen marcados como propuesta, no como definitivos. El detalle
completo de cada decisión pendiente vive en `docs/BLOQUEOS.md`.

## Stack

- **Backend**: [Hono](https://hono.dev) + TypeScript sobre Node ≥22, JWT
  propio (`jose`), Postgres con RLS real (Supabase gestionado en producción;
  Postgres embebido para desarrollo y pruebas), outbox con reintentos y
  rate limiting.
- **Frontend**: Vite + React 18 + TypeScript + Tailwind + React Router v7 +
  TanStack Query v5, con un paquete de UI compartido (`packages/ui`).
- **Monorepo**: npm workspaces + Turborepo.
- **Pruebas**: Vitest (unit, integración, adversarial) + Playwright (e2e) —
  239 archivos de prueba corriendo contra Postgres real y efímero, sin mocks
  en el camino del dinero.
- **Integraciones**: Cloudbeds (PMS), CFDI/SAT (fiscal), WhatsApp Business,
  Google OAuth, ElevenLabs (voz), correo transaccional.

## Estado

CI en verde en `main` (lint, typecheck, y la suite completa contra un
Postgres real efímero en cada corrida). 94 migraciones con RLS, 239 archivos
de prueba (114 unit, 71 integración, 41 adversarial, 13 e2e).

Antes de operar con un hotel real en producción faltan, en orden de lo
técnico a lo de negocio:

- Credenciales OAuth de un hotel piloto en Cloudbeds para activar el
  conector de PMS ya construido.
- Decisiones reservadas al fundador (detalle en `docs/BLOQUEOS.md`):
  proveedor de despliegue de `apps/api` (Vercel vs. Docker/Fly.io), precios
  de lista definitivos de los planes SaaS, uso o no de un motor de OCR
  autoalojado de origen chino en la bóveda de identidad, y el texto legal
  final del aviso de privacidad.
- Proyecto de Supabase, dominio y proveedor de cobro (Stripe/Conekta) de
  producción — hoy la facturación corre sobre un adaptador simulado.

## Desarrollo local

```bash
npm install                                          # una vez, desde la raíz

# Terminal 1 — backend (Postgres embebido real, migra + siembra datos si está vacío):
npm run dev --workspace=@atiende-hoteles/api         # http://localhost:3001

# Terminal 2 — panel (necesita VITE_API_URL para ver datos reales, ver apps/web/README.md):
npm run dev --workspace apps/web                     # http://localhost:5173
```

Detalle completo (variables de entorno, credenciales de desarrollo sembradas,
pruebas, build) en `apps/api/README.md` y `apps/web/README.md`.
