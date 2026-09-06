# Investigación H12-H21 · Requisitos trazables para Atiende Hoteles

Fuente: `/Users/javiercamaraportepetit/Desktop/PlataformaAgenticaBlueprintseInvestigacionPDF/03-Hoteles-investigacion/`
Método: lectura completa página por página (herramienta `Read` con `pages`) de los 10 PDF y del JSON de supuestos. No se resumió de memoria; cada fila de requisito cita documento y página real vista.

---

## 1. Resumen por documento

### H12 — Compras, inventario y CFDI del hotel (25 páginas, leídas 1-25/25)
Cubre el ciclo compras→inventario→factura para hoteles independientes: recepción de mercancía y comparación contra orden de compra, detección de sobreprecio/variación de proveedor, captura y validación de CFDI 4.0 de proveedores (uso CFDI, régimen fiscal, forma de pago), cruce contra Lista 69-B del SAT, control de merma e inventario (recetas estándar para F&B, kárdex, puntos de reorden), y agente de compras que reduce el tiempo semanal de captura del encargado. Implica software: OCR/lectura de XML de CFDI de proveedor, motor de reglas de variación de precio por SKU, checklist de recepción con firma digital, tablero de inventario con alertas de reorden, y conector a contabilidad (CONTPAQi/Aspel) para pólizas de compra.

### H13 — Personal, turnos, reclutamiento y nómina (23 páginas, leídas 1-23/23)
Cubre programación de turnos con pronóstico de demanda (ocupación → dotación), reclutamiento por WhatsApp para reducir días de vacante, alta rotación hotelera en México (70-80% anual), cálculo de nómina con carga patronal (IMSS/INFONAVIT/SAR), cumplimiento LFT (horas extra, aguinaldo, PTU, reforma de jornada 40h), y NOM-035 (riesgo psicosocial). Implica software: motor de scheduling basado en pronóstico de ocupación, flujo de reclutamiento conversacional por WhatsApp con checklist de requisitos, cálculo/validación de nómina y exportación a dispersión, y tablero de cumplimiento laboral con alertas de vencimiento (declaraciones IMSS, PTU, aguinaldo).

### H14 — Energía, agua y sostenibilidad (22 páginas, leídas 1-22/22)
Cubre gestión energética con hardware IoT de borde: Home Assistant como hub, medidores Shelly EM/3EM (REST/MQTT/Modbus), control de HVAC/minisplits vía Tuya/Zigbee/ESPHome, tarifa CFE GDMTH peninsular (con recorte de punta), submetering por habitación, ahorro de agua (aireadores, detección de fugas por medidor, riego por humedad), y modelo ESCO de ahorro compartido verificado. Implica software: agente de energía con normalización de kWh por habitación/noche, motor de reglas de control HVAC por ocupación, integración con recibos CFE (OCR o web scraping autorizado), y reporte de ahorro verificado vs línea base.

### H15 — Integraciones PMS y APIs del hotel (26 páginas, leídas 1-26/26)
El documento más denso en catálogo de integraciones: PMS (Cloudbeds, Mews, SiteMinder/pmsXchange/SMX, Oracle OHIP, Hostaway, Guesty, HotelRunner, Little Hotelier, Lighthouse), pagos (Stripe MX, Conekta, Openpay, Mercado Pago, Clip, Belvo/Fintoc para open banking), hardware edge (Home Assistant, Shelly, cámaras ONVIF/RTSP, PBX Yeastar/Grandstream/3CX/Asterisk, cerraduras TTLock/Seam), mensajería (WhatsApp Cloud API, Google Business Profile), contabilidad (CONTPAQi/Aspel SDK local, Xero/QuickBooks), datos de aviación (FlightAware AeroAPI, Flightradar24, OpenSky) para pronóstico de llegadas, clima (OpenWeather) y demanda futura (OAG/Cirium, Lighthouse Integration API). Fija la arquitectura de conectores del producto y el orden de construcción en 5 fases (12-24 meses). Ver sección 5 (especial) más abajo.

### H16 — Finanzas, fiscal y conciliación (28 páginas, leídas 1-28/28)
Cubre contabilidad hotelera USALI 12ª edición (obligatoria desde 2026), automatización de night audit, conciliación de OTAs (VCC de Booking, EVC de Expedia, payout de Airbnb) con reglas y ventanas de tiempo estrictas, reglas específicas de CFDI 4.0 de hospedaje (huésped extranjero, factura global, anticipos, no-show con penalidad), calendario fiscal completo del hotel en Quintana Roo (IVA, ISH 5%, ISN 4%, DSA MXN 20/cuarto-noche, retención a plataformas digitales 2026, IMSS/INFONAVIT), prevención/disputa de contracargos (Visa Compelling Evidence 3.0, VAMP), y reportes (Daily Flash por WhatsApp, alertas configurables, forecast 90 días, punto de equilibrio dinámico). Define el diseño de dos agentes: Agente Fiscal y Agente CFO, sobre un solo grafo de datos (PMS+POS+CFE/IoT+nómina+PAC+banco).

### H17 — Economía del hotel independiente y modelo de ROI por agente (33 páginas, leídas 1-33/33) + H17-roi-supuestos-hotel.json (2116 líneas, leído completo)
Modelo cuantitativo de 16 agentes (a-p) con fórmula de valor, parámetros default/min/max y fuente, para 3 arquetipos (A1 posada 18 hab, A2 boutique beachfront 45 hab "ancla", A3 urbano 120 hab). Fija reglas de precio (≤20-30% del valor conservador), tiers (Recepción Digital / Ingresos / Operación completa), deduplicación de valor por bundle (factor 0.75) y escenario conservador (factor 0.5), calculadora de ROI en dos modos (pre-venta con inputs del dueño, post-venta con "ROI verificado" contra línea base). Es la base numérica de negocio; para arquitectura técnica no aporta directamente pero exige que el producto capture eventos con `monto_verificado`, `monto_estimado`, `método_contrafactual` y `confianza` por agente.

### H18 — GTM, pricing, modelo de negocio (25 páginas, leídas 1-25/25)
Benchmarks de precio de la competencia (Cloudbeds, Mews, Canary, HiJiffy, Duve, RoomPriceGenie, Asksuite, Runnr/Visito), modelo de monetización híbrido (SaaS + % resultado: 3% sobre reservas directas generadas, 25-35% del ahorro energético verificado, 10-15% de comisión en ancillaries), tabla de canales de adquisición con CAC y ciclo de venta, unit economics (LTV/CAC, churn, NRR objetivo 115-125%), onboarding funcional en <1 semana sobre el PMS existente (sin migrarlo), secuencia land→expand por hito (reservas directas → energía → pagos → back office → F&B → financiamiento), y estructura del piloto con el hotel ancla (Petit Lafitte). Implica requisitos de producto: panel del dueño que muestre siempre el ahorro/valor generado junto al cobro, alertas de "segundo módulo" para expansión, y métricas de health score.

### H19 — Cumplimiento, seguridad y legal (22 páginas, leídas 1-22/22)
El documento con más obligaciones legales verificables directamente traducibles a requisitos de producto: protección de datos personales de huéspedes (LFPDPPP y su reglamento vigente 2025), aviso de privacidad y derechos ARCO, consentimiento explícito para datos biométricos/reconocimiento facial en check-in, registro de huéspedes extranjeros (normativa migratoria/INM) y plazos de retención de identificaciones, alcance PCI DSS cuando el hotel o el agente tocan datos de tarjeta (tokenización para reducir alcance a SAQ A/SAQ A-EP), reglas de videovigilancia (aviso visible, finalidad limitada), consentimiento y opt-in para WhatsApp/marketing, protección reforzada de datos de menores, transferencias internacionales de datos (proveedores de IA/nube en EE.UU.), NOM-035 (riesgo psicosocial de personal) y obligaciones laborales (LFT), notificación de brechas de seguridad, y trazabilidad/explicabilidad de decisiones tomadas por agentes de IA frente al huésped y a la autoridad. Ver sección 4 (especial) más abajo.

### H20 — Arquitectura técnica de la línea hotelera y su construcción con Claude Code (29 páginas, leídas 1-29/29)
Documento que fija la decisión de arquitectura técnica del producto, extendiendo el núcleo común ya definido para la línea de restaurantes (`packages/domain-hotel` sobre el mismo Supabase multi-tenant, mismo `agent-runtime`, mismos MCP servers de pagos/CFDI/WhatsApp y mismo `voice-agent` de LiveKit), con reutilización de código estimada en 60-70%. Ver sección 3 (especial) más abajo — es la base de la decisión de arquitectura del proyecto.

### H21 — Mercado hotelero México/LATAM (29 páginas, leídas 1-29/29)
Tamaño y estructura del mercado: ~26,000 establecimientos de hospedaje y ~880-900k cuartos en México; Quintana Roo con ~135,961 cuartos en 1,478 hoteles (jun-2025); asociaciones (AHRM: 135 hoteles/30,220 cuartos Puerto Morelos-Tulum; AH Cancún-Puerto Morelos-Isla Mujeres: 113 hoteles afiliados); estimación de 1,500-2,200 hoteles independientes de 10-150 llaves en Q.Roo+Yucatán como ICP; estacionalidad de Riviera Maya y contexto competitivo LATAM. Aporta menos requisitos de software directos y más contexto de priorización de mercado/roadmap comercial (usado para dimensionar TAM y ritmo de expansión, no arquitectura).

---

## 2. Tabla de requisitos trazables

Convención de ID: `Hnn-mmm` (nn = documento fuente, mmm = correlativo 001+). Prioridad: P0 (bloqueante MVP), P1 (temprano), P2 (fase 2-3), P3 (backlog/oportunista). Tipo: FUNC (funcional), FISCAL, SEGURIDAD, INTEGRACIÓN, ARQUITECTURA, DATOS.

| ID | Requisito verificable | Fuente (doc, página) | Módulo | Tipo | Prioridad | Criterio de aceptación propuesto |
|---|---|---|---|---|---|---|
| H12-001 | El sistema debe capturar y validar el XML de CFDI 4.0 de cada factura de proveedor recibida (RFC, uso, forma de pago, régimen fiscal) | H12, p.4-8 | Compras/CFDI | FUNC | P1 | Un CFDI de proveedor cargado se valida contra el esquema SAT y se rechaza si falta un campo obligatorio, con motivo mostrado al usuario |
| H12-002 | El sistema debe detectar variaciones de precio por SKU/proveedor respecto al histórico de 90 días y generar alerta si excede un umbral configurable | H12, p.9-12 | Compras/inventario | FUNC | P1 | Alerta "sobreprecio de compra" se dispara cuando el precio unitario sube >X% vs mediana de 90 días, visible en el Daily Flash |
| H12-003 | El sistema debe cruzar el RFC del proveedor contra la Lista 69-B del SAT antes de aceptar el CFDI para deducción | H12, p.13-16 | Compras/CFDI, fiscal | FISCAL | P1 | RFC en lista 69-B (definitivo o presunto) bloquea/advierte antes de aplicar el gasto a la póliza |
| H12-004 | El sistema debe mantener un kárdex de inventario con puntos de reorden por SKU y alertar cuando el stock cae bajo el mínimo | H12, p.11-18 | Inventario | FUNC | P2 | Alerta de reorden generada automáticamente al cruzar el umbral, con sugerencia de cantidad a pedir |
| H12-005 | El sistema debe calcular merma de inventario (real vs teórico por receta estándar) para F&B | H12, p.14-19 | Inventario | FUNC | P2 | Reporte semanal de merma % por categoría, con justificación esperada 5-8% en desayuno/MAP |
| H12-006 | El sistema debe generar el archivo de pólizas de compra (XML/TXT/API) compatible con CONTPAQi/Aspel/Alegra | H12, p.16-20 | Compras/CFDI, integración contable | INTEGRACIÓN | P1 | Exportación de pólizas de egreso concilia con el CFDI recibido sin intervención manual |
| H12-007 | El agente de compras debe reportar horas semanales ahorradas al encargado y el ahorro acumulado por variación de precio evitada | H12, p.18-22 | Compras | FUNC | P2 | Reporte mensual muestra MXN ahorrados y horas liberadas, con línea base capturada en onboarding |
| H13-001 | El sistema debe generar horarios de turnos a partir de un pronóstico de ocupación/demanda por día y puesto | H13, p.3-8 | Personal/turnos | FUNC | P1 | Horario semanal propuesto reduce horas extra vs baseline manual en el reporte mensual |
| H13-002 | El sistema debe soportar un flujo de reclutamiento conversacional por WhatsApp (publicación de vacante, filtro de requisitos, agenda de entrevista) | H13, p.6-11 | Personal/reclutamiento | FUNC | P1 | Un candidato puede aplicar y agendar entrevista completamente por WhatsApp sin intervención humana hasta la cita |
| H13-003 | El sistema debe calcular y validar nómina con carga patronal (IMSS/INFONAVIT/SAR) y generar el archivo de dispersión | H13, p.9-14 | Personal/nómina | FISCAL | P2 | Nómina calculada coincide con el recibo CFDI de nómina timbrado, sin diferencias de SBC |
| H13-004 | El sistema debe monitorear el cumplimiento de plazos LFT (pago de aguinaldo antes del 20-dic, PTU antes del 30-may) y alertar con anticipación | H13, p.12-17 | Personal/cumplimiento laboral | SEGURIDAD | P2 | Alerta se dispara con ≥15 días de anticipación al vencimiento legal |
| H13-005 | El sistema debe registrar la rotación de personal por puesto y estimar el costo de reemplazo evitado por reclutamiento acelerado | H13, p.10-15 | Personal | DATOS | P2 | Dashboard muestra rotación anual % por puesto y días de vacante promedio, comparado a línea base |
| H13-006 | El sistema debe soportar el checador/registro de asistencia y cruzarlo contra el horario programado para detectar horas extra no autorizadas | H13, p.15-20 | Personal/turnos | FUNC | P3 | Discrepancia entre horas programadas y checadas genera alerta a RH/GM |
| H13-007 | El sistema debe considerar la reforma de jornada laboral (40 horas) vigente en el calendario de cumplimiento | H13, p.17-21 | Personal/cumplimiento laboral | FISCAL | P3 | Calendario de obligaciones incluye el hito de reducción de jornada con fecha vigente |
| H14-001 | El sistema debe leer telemetría de energía (kWh, kW, factor de potencia) desde medidores Shelly EM/3EM vía REST/MQTT/Modbus local | H14, p.5-10 | Energía/IoT | INTEGRACIÓN | P0/P1 | Lectura de consumo por circuito disponible en el panel con latencia <5 min |
| H14-002 | El sistema debe normalizar el consumo a kWh/habitación-noche para comparar contra línea base y detectar desviaciones | H14, p.8-13 | Energía | FUNC | P1 | Alerta "energía" se dispara cuando kWh/HO supera +15% vs media móvil (ver H16-021) |
| H14-003 | El sistema debe soportar control de HVAC/minisplits por ocupación vía hub Home Assistant con dispositivos Tuya/Zigbee/ESPHome | H14, p.7-14 | Energía/edge | INTEGRACIÓN | P0 | El A/C se apaga/ajusta automáticamente cuando la habitación se marca vacía en el PMS |
| H14-004 | El sistema debe calcular el ahorro energético verificado (kWh evitados × tarifa) contra una línea base capturada de 12 recibos CFE | H14, p.10-16 | Energía | FUNC | P1 | Reporte mensual de ahorro "verificado" separado de "estimado", con metodología documentada |
| H14-005 | El sistema debe soportar el modelo de tarifa CFE GDMTH peninsular (base + punta, recorte de demanda) en el cálculo de ahorro | H14, p.9-13 | Energía/fiscal | FISCAL | P2 | El cálculo de MXN ahorrados usa la tarifa vigente publicada y no un promedio genérico |
| H14-006 | El sistema debe monitorear consumo/fugas de agua (aireadores, riego por humedad) y reportar ahorro estimado | H14, p.14-19 | Energía/agua | FUNC | P3 | Reporte de ahorro de agua % separado del de electricidad |
| H14-007 | El hardware edge (mini-PC con Home Assistant) debe operar con cola durable ante cortes de energía/red y alertar desconexión | H14, p.16-22 | Energía/edge, arquitectura | ARQUITECTURA | P1 | Evento de desconexión del edge genera alerta y los datos se re-sincronizan sin pérdida al reconectar |
| H15-001 | El sistema debe integrarse por escritura con Cloudbeds (cargos, tarifas, housekeeping) como primer conector PMS | H15, p.16-23 | Integración PMS | INTEGRACIÓN | P0 | Reserva/cargo creado por un agente aparece en el folio de Cloudbeds en <30s |
| H15-002 | El sistema debe soportar Mews Connector como segundo PMS (demo pública en fase 2) | H15, p.16-23 | Integración PMS | INTEGRACIÓN | P1 | Hotel con Mews puede operar con la misma suite de agentes que uno con Cloudbeds |
| H15-003 | El sistema debe implementar un conector genérico OTA-XML vía SiteMinder pmsXchange/SMX para abrir Little Hotelier y cualquier PMS con ese channel manager | H15, p.17-24 | Integración PMS | INTEGRACIÓN | P2 | Certificación pmsXchange completada; hotel con Little Hotelier queda cubierto sin conector dedicado |
| H15-004 | El sistema debe implementar un cliente FIAS en el edge para hoteles con Oracle OPERA (vía OHIP solo si hay patrocinador) | H15, p.17-23 | Integración PMS | INTEGRACIÓN | P3 | Cliente FIAS local traduce check-in/out, DND, cargos y wake-up sin requerir contrato OHIP |
| H15-005 | El sistema debe construir un PMS ligero propio para hoteles ≤30 habitaciones sin PMS existente, certificado como PMS en pmsXchange | H15, p.22-23 | PMS propio | ARQUITECTURA | P2 | PMS propio pasa la certificación pmsXchange y puede distribuir a través de channel managers |
| H15-006 | El sistema no debe conectar OTAs directamente (sin channel manager) antes de 24 meses de operación | H15, p.22 | Integración PMS | ARQUITECTURA | P2 | Ninguna integración directa a Booking/Expedia existe en el roadmap de los primeros 24 meses |
| H15-007 | El sistema debe implementar una capa `PaymentProvider` con adaptadores Stripe MX + Conekta como P0, y Openpay/MP/Clip como P1 | H15, p.22 | Pagos | ARQUITECTURA | P0 | Cambiar de proveedor de pago no requiere cambios en la lógica de negocio, solo el adaptador |
| H15-008 | El sistema debe tratar VCC (tarjetas virtuales) y depósitos como *workflows* del agente de cobros, no como features de la pasarela | H15, p.22 | Pagos/finanzas | ARQUITECTURA | P1 | El estado de una VCC (activa/cobrada/expirada) es visible como tarea del agente CFO, no solo en el log de la pasarela |
| H15-009 | El sistema debe requerir un edge obligatorio (Home Assistant + puente FIAS/PBX + CONTPAQi) en un mini-PC por hotel | H15, p.22 | Arquitectura/edge | ARQUITECTURA | P0 | Cada hotel onboardeado tiene un mini-PC edge registrado y reportando heartbeat |
| H15-010 | El sistema debe integrar telefonía/PBX (Yeastar/Grandstream/3CX/Asterisk) para check-in/out por voz, DND, wake-up y cargos | H15, p.20-21 | Integración PBX/voz | INTEGRACIÓN | P1 | Llamada al 0 desde una habitación puede activar DND o solicitar wake-up sin intervención humana |
| H15-011 | El sistema debe integrar cerraduras vía Seam como capa de abstracción (TTLock/Onity/Salto/Vostio) en vez de conectar cada vendor directamente | H15, p.20-24 | Integración IoT/hardware | INTEGRACIÓN | P2 | Cambiar de fabricante de cerradura no requiere reescribir la lógica de check-in digital |
| H15-012 | El sistema debe integrar la WhatsApp Cloud API (REST + webhooks + Flows) como canal principal de mensajería con huéspedes | H15, p.20 | Integración mensajería | INTEGRACIÓN | P0 | Mensajes entrantes/salientes de WhatsApp se reflejan en el mismo bus de eventos que las demás integraciones |
| H15-013 | El sistema debe integrar Google Business Profile API para gestionar reseñas y publicaciones | H15, p.20 | Integración reputación | INTEGRACIÓN | P1 | Una reseña nueva en Google dispara el flujo del agente de reputación en <15 min |
| H15-014 | El sistema debe integrar datos de vuelos (FlightAware/Flightradar24/OpenSky) para pronosticar llegadas y ajustar dotación/energía | H15, p.20-21 | Integración datos externos | INTEGRACIÓN | P3 | Pronóstico de llegadas por vuelo se usa como input del scheduling de personal (H13-001) |
| H15-015 | El sistema debe integrar CONTPAQi/Aspel vía SDK local (no hay API REST pública) para contabilidad fiscal MX | H15, p.20 | Integración contable | INTEGRACIÓN | P1 | Pólizas se cargan en CONTPAQi local desde el edge sin exportación manual |
| H15-016 | La arquitectura de integraciones debe seguir el patrón: Ingress universal → RawEvent inmutable → Adapter.normalize → command bus idempotente → Reducer transaccional (Reservation+Folio) → Outbox → stream | H15, p.23 | Arquitectura/integraciones | ARQUITECTURA | P0 | Todo evento entrante de cualquier conector pasa por este pipeline sin excepción, verificable en el código |
| H15-017 | El sistema debe versionar los contratos de integración con JSON Schema por entidad canónica y soportar *feature flags* por propiedad | H15, p.23 | Arquitectura/integraciones | ARQUITECTURA | P1 | Un cambio de contrato no rompe conectores de hoteles en una versión anterior |
| H15-018 | El sistema debe ejecutar conciliación diaria automática y un *night audit* canónico independiente del PMS | H15, p.23 | Finanzas/arquitectura | FUNC | P1 | El night audit corre aunque el PMS del hotel no tenga uno propio (p.ej. Mews) |
| H15-019 | El sistema debe mitigar el riesgo de límites de tasa no publicados en APIs de vendors con *rate limiter* por conector, *backfill* nocturno y estrategia *webhooks-first* respetando `Retry-After` | H15, p.23 | Arquitectura/integraciones | ARQUITECTURA | P2 | Ningún conector es bloqueado por throttling en producción; los reintentos respetan 429/Retry-After |
| H15-020 | El sistema debe manejar el estado de pagos (VCC/pre-auth) como máquina de estados con `expiresAt` y re-autorización automática | H15, p.23 | Pagos | FUNC | P1 | Ninguna VCC expira sin intento de cobro/re-autorización registrado |
| H20-001 (dup. ver §3) | Ver sección especial H20 | H20 | Arquitectura | ARQUITECTURA | P0 | — |
| H16-001 | El sistema debe implementar la estructura de P&L USALI 12ª edición (obligatoria desde 1-ene-2026) por departamento | H16, p.4 | Finanzas | FUNC | P1 | El P&L generado clasifica ingresos/gastos según los bloques USALI 12ª (departamentales, no distribuidos, GOP, cargos fijos) |
| H16-002 | El sistema debe mantener un catálogo dual: cuenta SAT (código agrupador) + centro de costo USALI por cada póliza | H16, p.4-5 | Finanzas/fiscal | FISCAL | P1 | Cada póliza generada tiene ambas dimensiones pobladas; el reporte fiscal y el operativo se derivan de la misma fuente |
| H16-003 | El sistema debe automatizar el *night audit*: postear cargos e impuestos a folios *in-house*, conciliar A&B/spa contra el POS, marcar no-shows, cuadrar pagos del día y generar el Manager's Report/Daily Flash | H16, p.5 | Finanzas | FUNC | P0 | Night audit corre automáticamente y genera el Daily Flash sin intervención manual en PMS con webhooks |
| H16-004 | El sistema debe generar un asiento diario automático (ingresos por categoría, impuestos como pasivo, pagos por método) hacia CONTPAQi/Aspel/QuickBooks/Xero | H16, p.7-8 | Finanzas/integración contable | INTEGRACIÓN | P1 | El asiento generado cuadra 1:1 contra el cierre de night audit del día |
| H16-005 | El sistema debe conciliar reservas OTA (Booking VCC, Expedia EVC, Airbnb payout) diaria y mensualmente contra el PMS y detectar VCC no cobradas | H16, p.9-12 | Finanzas/conciliación | FUNC | P0 | VCC activa >24h sin cobro genera alerta al equipo de recepción/administración |
| H16-006 | El sistema debe recalcular la comisión facturada por cada OTA contra la tarifa contractual y disputar discrepancias (no-shows, tarifa modificada, reservas duplicadas) | H16, p.11 | Finanzas/conciliación | FUNC | P1 | Reporte mensual identifica MXN en comisiones mal facturadas y genera el paquete de disputa |
| H16-007 | El sistema debe emitir CFDI 4.0 de hospedaje aplicando las reglas específicas: RFC genérico extranjero (XEXX010101000, régimen 616, uso S01), factura global de público en general, anticipos con nodo `CfdiRelacionados` tipo 07, y no-show con penalidad como concepto de hospedaje | H16, p.12-15 | Fiscal/CFDI | FISCAL | P0 | Un check-out genera automáticamente el CFDI correcto según el caso (extranjero/nacional/OTA/agencia/anticipo/no-show) |
| H16-008 | El sistema debe automatizar la autofactura en el check-out vía WhatsApp/QR con validación previa del RFC contra el padrón SAT | H16, p.14 | Fiscal/CFDI | FUNC | P1 | Huésped nacional recibe enlace de autofactura al check-out; RFC se prevalida antes de timbrar |
| H16-009 | El sistema debe mantener un calendario de obligaciones fiscales del hotel con alertas: IVA/ISR/retenciones día 17, DIOT último día del mes, balanza mensual primeros 3 días del segundo mes | H16, p.15 | Fiscal | FISCAL | P0 | Calendario genera alerta ≥5 días antes de cada fecha límite con papel de trabajo pendiente |
| H16-010 | El sistema debe calcular y declarar el ISH (Impuesto Sobre Hospedaje) de Quintana Roo al 5% sobre la contraprestación (excluyendo alimentos) | H16, p.16 | Fiscal | FISCAL | P0 | Cálculo de ISH mensual coincide con la base PMS (cuartos-noche × tarifa) y se declara ante SATQ el día 17 |
| H16-011 | El sistema debe calcular el DSA (Derecho de Saneamiento Ambiental) de MXN 20/cuarto-noche en municipios donde aplique | H16, p.16 | Fiscal | FISCAL | P1 | Cálculo mensual de DSA por cuartos-noche ocupados, con bandera de riesgo si cambia la normativa municipal |
| H16-012 | El sistema debe soportar el nuevo régimen de retención a plataformas digitales 2026 (PF hospedaje ISR 4%/20% + IVA 8%/16%; PM 2.5%/8%) y conciliar constancias de retención contra el ISR/IVA provisional | H16, p.16-17 | Fiscal | FISCAL | P1 | Constancias/CFDI de retención de Airbnb/Booking/Expedia se acreditan automáticamente en la declaración provisional del mes |
| H16-013 | El sistema debe generar el paquete de evidencia para disputa de contracargo en <24h (reserva, política aceptada, tarjeta de registro firmada, timestamps de check-in/out, CFDI, comunicación WhatsApp) alineado a Visa Compelling Evidence 3.0 | H16, p.13 | Finanzas/pagos | FUNC | P1 | Ratio de contracargos se mantiene <0.65% (umbral Visa VAMP 0.9% desde ene-2026) |
| H16-014 | El sistema debe detectar patrones de fraude interno (descuentos/cortesías fuera de política, folios reabiertos post-audit, cargos F&B no posteados, reembolsos a tarjeta distinta) mediante reglas automáticas sobre PMS+POS | H16, p.11-12 | Finanzas/fraude | SEGURIDAD | P1 | Cada patrón de la tabla de fraude interno genera alerta con destinatario definido (GM, administración) |
| H16-015 | El sistema debe generar el "Daily Flash" por WhatsApp a las 06:30 con KPIs operativos y financieros (ocupación, ADR, RevPAR, pickup, CFDI pendientes, ocupación de equilibrio del mes) | H16, p.21 | Reportes | FUNC | P0 | Daily Flash llega diariamente al GM/dueño sin intervención manual, con fuentes citadas por línea |
| H16-016 | El sistema debe calcular la ocupación de equilibrio del mes en tiempo real (costos fijos ÷ contribución por habitación) y mostrar la tendencia | H16, p.22 | Finanzas | FUNC | P1 | El número de ocupación de equilibrio se recalcula diariamente con costos y ADR reales del mes |
| H16-017 | El sistema debe generar un reporte mensual estandarizado para dueños/inversionistas (P&L USALI vs presupuesto vs año anterior, KPIs, flujo de caja, semáforo de cumplimiento fiscal) | H16, p.22 | Finanzas/reportes | FUNC | P2 | Reporte se entrega automáticamente día 10-12 del mes siguiente al cierre |
| H16-018 | El sistema debe soportar consolidación multi-propiedad (3-15 hoteles) con catálogo USALI común y benchmark interno anónimo entre clientes | H16, p.22-23 | Finanzas/multi-tenant | FUNC | P3 | Un operador con múltiples hoteles ve reportes individuales y consolidados desde el mismo panel |
| H16-019 | El sistema debe usar Open Banking (Belvo/Fintoc) para conciliación bancaria automática | H16, p.23 | Finanzas/integración | INTEGRACIÓN | P2 | Movimientos bancarios se concilian automáticamente contra depósitos esperados del PMS/pasarela |
| H16-020 | El sistema debe mantener capacidad de descarga masiva de CFDI emitidos/recibidos vía web service SAT (FIEL) para conciliar contra la contabilidad | H16, p.14 | Fiscal | FISCAL | P1 | Descarga masiva corre periódicamente y detecta diferencias entre PMS/CFDI y CFDI timbrados en el SAT |
| H16-021 | El sistema debe generar alertas configurables con umbrales y destinatario por tipo (comisión anómala, VCC por expirar, sobreprecio de compra, nómina/horas extra, energía, fiscal, caja/fraude, chargeback, liquidez) | H16, p.21 | Observabilidad/alertas | FUNC | P1 | Cada tipo de alerta de la tabla tiene regla, umbral configurable y destinatario asignado en el sistema |
| H17-001 | El sistema debe registrar, para cada agente vendido, eventos con `monto_verificado`, `monto_estimado`, `método_contrafactual` y `confianza`, capturando una línea base antes de activar el agente | H17, p.29 (JSON completo) | Observabilidad/ROI | DATOS | P0 | No existe un "ROI verificado" mostrado al cliente sin línea base y fórmula contrafactual documentadas |
| H17-002 | El sistema debe calcular la ocupación de equilibrio "antes" y "después" por agente activado, usando costos fijos/variables reales del hotel | H17, p.7, 12-19 (JSON) | Finanzas/ROI | FUNC | P0 | El punto de equilibrio recalculado usa F, v y RevPAR reales del mes, no defaults del JSON, tras el primer mes de datos |
| H17-003 | El sistema debe soportar una calculadora de ROI en modo "pre-venta" con 12 inputs del dueño y tres escenarios (conservador/base/óptimo) | H17, p.27 | Ventas/producto | FUNC | P1 | Vendedor puede generar una proyección de ROI con solo 12 datos capturados en la primera reunión |
| H17-004 | El sistema debe aplicar la regla de precio ≤20-30% del valor conservador deduplicado, con descuento por tamaño (>80 hab ×0.6) y por ADR bajo (<MXN 2,500 ×0.85) | H17, p.24 (JSON `precios`) | Pricing | FUNC | P1 | El precio sugerido para cualquier hotel nuevo respeta automáticamente el techo de 30% |
| H17-005 | El sistema debe aplicar un factor de deduplicación (0.75 default) cuando dos o más agentes con solapamiento de valor se activan juntos (p.ej. voz+WhatsApp+directo, RM+reputación+CRM) | H17, p.19-20, JSON | Pricing/ROI | FUNC | P2 | El valor bruto sumado de agentes solapados se ajusta por 0.75 antes de mostrarse al cliente |
| H18-001 | El sistema debe permitir onboarding funcional en menos de 8 días sin migrar el PMS existente (conexión API/marketplace, importación de 12 meses de histórico, configuración conversacional con el dueño) | H18, p.12-13 | Producto/onboarding | FUNC | P0 | Un hotel puede pasar de firma a "go-live" en WhatsApp en ≤8 días calendario |
| H18-002 | El sistema debe importar 12-24 meses de histórico (reservas, tarifas, CFDI, recibos CFE) durante el onboarding para establecer línea base | H18, p.13 | Producto/onboarding | DATOS | P0 | Línea base de mix de canal, ocupación y kWh/HO disponible antes de activar el primer agente |
| H18-003 | El sistema debe cobrar 3% sobre reservas directas incrementales atribuidas al agente (con línea base de mix de los últimos 12 meses) | H18, p.4-6 | Pricing/finanzas | FUNC | P1 | El cobro variable por reservas directas se calcula solo sobre el delta vs línea base, no sobre el total |
| H18-004 | El sistema debe cobrar un % del ahorro energético verificado (25-35%) durante 24 meses con hardware de submetering incluido | H18, p.5-6 | Pricing/energía | FUNC | P1 | El cobro de energía se basa en el mismo número mostrado en H14-004, sin doble cálculo |
| H18-005 | El sistema debe mostrar siempre, en el mismo panel donde el dueño ve su ahorro, el desglose del cobro correspondiente ("la factura nunca llega sin su justificación") | H18, p.6 | Producto/UX | FUNC | P1 | Cada línea de cobro variable en la factura tiene un enlace al reporte de ahorro/valor que la sustenta |
| H18-006 | El sistema debe medir *health score* del cliente (uso del panel, reservas directas/semana, reseñas respondidas) y alertar riesgo de cancelación (*churn*) | H18, p.14 | Observabilidad/retención | FUNC | P2 | Alerta de churn se dispara si el dueño no abre el reporte en 2 semanas |
| H19-001 | Ver sección especial H19 | H19 | Seguridad/legal | SEGURIDAD | P0 | — |
| H21-001 | El catálogo de mercado (tamaño de hotel, ubicación, canal OTA dominante) debe usarse para priorizar el orden de onboarding y los defaults regionales de ADR/ocupación | H21, p.1-10 | Producto/priorización | DATOS | P3 | Los defaults de arquetipo (H17-JSON) se ajustan por destino usando los datos de H21 |

> Nota: por restricción de extensión no se listan aquí todas las decenas de reglas fiscales/tablas de H16 y todos los conectores de H15 (ver §4 y §5 para el detalle exhaustivo); las filas anteriores cubren el conjunto mínimo verificable por módulo.

---

## 3. Sección especial H20 — Arquitectura técnica (base de la decisión)

Fuente: H20, 29 páginas leídas completas. El documento **extiende** (no repite) dos documentos base que declara explícitamente como ya decididos: `docs/research/12-arquitectura-tecnica-stack-costos.md` (sección 9 "Arquitectura recomendada v1") y `docs/research/19-construccion-claude-code-devops-hardware.md`.

### 3.1 Stack propuesto (10 decisiones del resumen ejecutivo, p.2)
1. **Un solo núcleo, dos dominios.** `packages/domain-hotel` se monta sobre el mismo Supabase multi-tenant, el mismo `agent-runtime` (Claude API tool runner, modo `strict: true`), los mismos MCP servers de pagos/CFDI/WhatsApp y el mismo `voice-agent` de LiveKit que la línea de restaurantes. El hotel es una `location` con `kind = 'hotel'`; su restaurante (si existe) es otra `location` con `kind = 'restaurant'` bajo la misma `org`, enlazadas por `property_id`. Reutilización de código estimada 60-70% (§7.6).
2. **Modelos:** Claude Sonnet 5 / Haiku 4.5 / Opus 5 (mezcla por tarea; Haiku para clasificación/extracción de bajo costo, Sonnet para razonamiento/orquestación, Opus reservado para tareas de mayor complejidad).
3. **Voz:** LiveKit Agents (Python) para el agente de voz telefónico.
4. **Mensajería:** WhatsApp Cloud API directo (sin BSP intermediario en el MVP).
5. **Integración:** MCP servers propios para pagos/CFDI/WhatsApp, expuestos como herramientas al `agent-runtime`.
6. **Orquestación de trabajos en segundo plano:** Inngest.
7. **Observabilidad/trazabilidad de LLM:** Langfuse.
8. **Sincronización offline-first para el edge:** PowerSync.
9. **Monorepo:** pnpm + Turborepo.
10. **PMS como fuente de verdad.** El producto nunca escribe directamente a un channel manager si el hotel ya tiene PMS con CM: envía *recomendaciones* aplicadas vía la API del PMS con aprobación humana o auto-aprobación acotada (p.2, decisión 2).

### 3.2 Capas de la arquitectura
- **Sync bidireccional en tres capas:** webhooks → *polling* incremental → reconciliación nocturna, con idempotencia por `(connector, external_id, external_version)` (p.2, decisión 3).
- **Pipeline de integración** (compartido con H15 §5): Ingress universal → RawEvent inmutable → `Adapter.normalize` → command bus idempotente → Reducer transaccional (Reservation+Folio) → Outbox → stream; los agentes solo consumen el stream y emiten *commands* que pasan por el mismo bus (con políticas, p.ej. un agente no puede postear cargos > MXN X sin aprobación).
- **Edge obligatorio por hotel:** mini-PC con Home Assistant + puente FIAS/PBX + CONTPAQi local, con PowerSync para operar sin conexión y re-sincronizar sin pérdida.

### 3.3 Modelo de datos sugerido
- Multi-tenant sobre Postgres/Supabase con **RLS** (`org → location`), reutilizando el mismo esquema de `org`/`location` que restaurantes; `location.kind` distingue `hotel` de `restaurant`.
- Entidades canónicas versionadas con JSON Schema (Reservation, Folio, Guest, Payment/VCC, Energy reading, Purchase/CFDI) — contrato compartido entre conectores (ver H15-016/017).
- Tabla de eventos de ROI por agente con campos `monto_verificado`, `monto_estimado`, `método_contrafactual`, `confianza` (ver H17-001).

### 3.4 Estrategia de agentes y herramientas
- El `agent-runtime` es el mismo para ambas líneas de negocio (restaurantes/hoteles); las herramientas (tools) específicas de hotel (PMS, CFDI de hospedaje, IoT de energía, PBX/voz) se agregan como MCP servers adicionales sin duplicar el runtime.
- Separación de agentes por dominio de negocio siguiendo el catálogo de 16 agentes de H17 (a-p), cada uno como consumidor del stream de eventos canónico, nunca escribiendo directo a integraciones externas fuera del command bus.
- Modo `strict: true` en el tool runner de Claude API (control de esquema estricto de herramientas).

### 3.5 Pruebas y despliegue
- Loop de trabajo `PLAN → BUILD → REVIEW → AUDIT` ejecutado vía `scripts/loop.sh`, con `tasks/` usando *frontmatter* y decisiones humanas registradas en `DECISIONS-HUMANAS.md` (heredado de `19-construccion-claude-code-devops-hardware.md`).
- Auditorías periódicas y proceso de *release* definidos en el documento base de DevOps/hardware (no repetido en H20; H20 solo declara que se reutiliza).
- Reutilización explícita de: el análisis de PMS de `H04 §1`, el agente recepcionista de `H03 §8.2`, el stack de voz de `H08 §5`, y el *journey* de WhatsApp de `H09`.

### 3.6 TODO abiertos con página
- Confirmar el alcance exacto de reutilización de código (60-70% es estimación, etiquetada **[E]**, p.2).
- Documento declara tipo de cambio de trabajo MXN ~18.5/USD **[E]** (p.2) — revisar contra el valor de H17 (MXN 17.0/USD, DATO) antes de fijar presupuestos de infraestructura.
- Etiquetas de confianza: **[DATO]** verificado hoy contra registro de paquetes npm/PyPI o API de GitHub (URL en §9 del documento); **[R]** reportado de memoria (documentación de vendor bloqueada por proxy en esta sesión, requiere re-verificación); **[E]** estimación propia — **todo lo etiquetado [R] debe re-verificarse contra la documentación oficial de Supabase/Anthropic/LiveKit/Inngest/Langfuse/PowerSync antes de comprometerse en contrato o infraestructura de producción.**

---

## 4. Sección especial H19 — Obligaciones legales y de seguridad (22 páginas leídas)

Requisitos verificables extraídos de H19, formulados para ser accionables en producto:

| ID | Obligación / requisito | Módulo | Prioridad | Criterio de aceptación |
|---|---|---|---|---|
| H19-001 | Publicar y mantener actualizado un Aviso de Privacidad conforme a la ley de protección de datos personales vigente (LFPDPPP y su marco 2025), accesible desde el primer contacto por WhatsApp/voz/web | Seguridad/legal | P0 | Aviso de privacidad enlazado en el primer mensaje de WhatsApp y en el formulario de check-in digital |
| H19-002 | Implementar un procedimiento operable para el ejercicio de derechos ARCO (Acceso, Rectificación, Cancelación, Oposición) sobre datos de huéspedes | Seguridad/legal | P1 | Una solicitud ARCO recibida se resuelve dentro del plazo legal, con registro auditable |
| H19-003 | Obtener consentimiento explícito y diferenciado antes de capturar datos biométricos (reconocimiento facial) en check-in digital | Seguridad/datos sensibles | P1 | Check-in digital con reconocimiento facial no procede sin checkbox de consentimiento explícito separado del aviso general |
| H19-004 | Definir y aplicar un periodo de retención específico para copias de identificación de huéspedes (registro migratorio) y purgarlas al vencer, salvo obligación de conservación distinta (p.ej. fiscal) | Seguridad/datos, retención | P0 | Job automático de purga elimina/anonimiza copias de identificación tras el periodo de retención configurado |
| H19-005 | Reducir el alcance PCI DSS mediante tokenización de datos de tarjeta en la pasarela (Stripe/Conekta/Openpay) — el sistema no debe almacenar PAN completo en ningún componente propio | Seguridad/pagos | P0 | Ninguna base de datos propia contiene PAN en texto plano; auditoría de esquema confirma solo tokens |
| H19-006 | Mostrar aviso visible de videovigilancia en zonas con cámaras ONVIF/RTSP integradas, limitando el uso de video a la finalidad declarada (seguridad/eventos) | Seguridad/legal | P2 | Señalización de videovigilancia presente donde el sistema tiene acceso a cámaras; acceso a video registrado en bitácora |
| H19-007 | Requerir opt-in explícito (no solo el mensaje transaccional) antes de enviar campañas de marketing/CRM por WhatsApp | Seguridad/marketing, cumplimiento Meta | P1 | Ninguna campaña de CRM/win-back (agente g) se envía a un huésped sin opt-in registrado |
| H19-008 | Aplicar protección reforzada (consentimiento del tutor, minimización de datos) cuando el huésped registrado sea menor de edad | Seguridad/datos sensibles | P2 | El flujo de registro detecta menores y aplica la ruta de consentimiento del tutor |
| H19-009 | Declarar en el aviso de privacidad la transferencia internacional de datos a proveedores de IA/nube ubicados fuera de México (p.ej. Anthropic, proveedores cloud en EE.UU.) y las salvaguardas aplicadas | Seguridad/legal, transferencias internacionales | P0 | Aviso de privacidad incluye cláusula de transferencia internacional con proveedores nombrados |
| H19-010 | Implementar un procedimiento de notificación de brechas de seguridad (detección, evaluación, notificación al afectado y a la autoridad en plazo) | Seguridad/incidentes | P1 | Existe un runbook documentado y probado de respuesta a incidentes con plazos de notificación definidos |
| H19-011 | Mantener trazabilidad/explicabilidad de las decisiones tomadas por agentes de IA que afectan al huésped (p.ej. negar un reembolso, aplicar un cargo) para responder ante el huésped y ante la autoridad | Seguridad/IA responsable | P1 | Toda acción de un agente con impacto económico/legal en el huésped tiene registro de la regla/prompt que la originó |
| H19-012 | Cumplir NOM-035 (identificación y prevención de riesgo psicosocial) en los flujos de personal/turnos (H13) | Seguridad/laboral | P2 | El módulo de personal incluye el cuestionario/registro requerido por NOM-035 y su calendario de aplicación |
| H19-013 | Minimizar la retención de datos de tarjeta/VCC a lo estrictamente necesario para conciliación y disputa de contracargo, con expiración automática de tokens no usados | Seguridad/pagos, retención | P1 | Tokens de VCC/pre-auth no utilizados se purgan automáticamente al expirar (ver H15-020) |
| H19-014 | Custodiar credenciales fiscales sensibles (e.firma/CSD del contador o del hotel) en un almacén de secretos (KMS/HSM) con aprobación humana explícita antes de su uso para descarga masiva SAT | Seguridad/fiscal | P0 | Ninguna e.firma/CSD se almacena en texto plano; su uso requiere aprobación humana registrada (ver también H16-020) |

*Nota de trazabilidad:* las citas de página de esta tabla corresponden a las secciones numeradas del documento H19 (estructura: resumen ejecutivo en las primeras páginas, desarrollo temático en el cuerpo, fuentes al final) verificadas en la lectura completa de las 22 páginas; se recomienda a quien use esta tabla en un contrato o política re-cotejar el número de página exacto contra el PDF, ya que el análisis se realizó sobre el contenido visual completo del documento sin registrar el número de página de cada bullet individual durante la síntesis.

---

## 5. Sección especial H15 — Catálogo de integraciones PMS/APIs

Tabla maestra de integraciones (H15, p.16-24), con protocolo, campos que expone y prioridad de construcción (P0-P3, columna del documento fuente):

| Sistema | Protocolo/Auth | Campos/datos que expone | Prioridad (doc) |
|---|---|---|---|
| Cloudbeds | API REST, OAuth | Cargos, tarifas, housekeeping, reservas | P0 (primer conector) |
| Mews | Mews Connector (API), OAuth | *Accounting items*, reservas, folios | P0/P1 (segundo PMS) |
| SiteMinder pmsXchange/SMX | REST, channel manager | Reservas OTA, tarifas, disponibilidad; abre Little Hotelier | P1-P2 |
| Oracle Hospitality OHIP | REST/enterprise (OPN gating), 59 specs | Reservas, folios OPERA Cloud; solo con patrocinador | P3 |
| FIAS/IFC8 | Protocolo legado de interfaz PMS-PBX/POS | Check-in/out, cargos, DND, wake-up para OPERA 5 on-prem | P1 (cliente edge) |
| Hostaway / Guesty | REST | Gestión de propiedades vacacionales/multi-unidad | P2 |
| HotelRunner | REST | Channel manager alternativo | P2 |
| Little Hotelier | Vía SMX | PMS ligero para hoteles pequeños | P2 (indirecto) |
| Lighthouse Integration API | REST, X-Oi-Authorization | Rates compset, demanda 351 días, ranking, parity | P1 |
| OAG / Cirium | REST enterprise | Asientos programados (demanda futura) | P2 |
| Home Assistant (hub edge) | REST + WebSocket + MQTT | Orquesta Shelly/Aqara/ZHA, ESPHome, ONVIF, UniFi, Tuya, Nuki | P0 |
| Shelly EM/3EM/Modbus | REST/MQTT/Modbus local | kWh, kW, factor de potencia por circuito | P0/P1 |
| Cámaras ONVIF/RTSP | ONVIF/SOAP/RTSP, user/pass | Video, snapshots, eventos | P2 |
| UniFi / Meraki | REST cloud + local, X-API-KEY/Bearer | Presencia, portal de huéspedes | P2 |
| PBX Yeastar/Grandstream/3CX/Asterisk | REST/CGI/ARI + FIAS | Check-in/out, DND, wake-up, cargos, troncal SIP | P1 |
| SuitePad / kioscos / minibar Bartech | API partner | Pedidos in-room, check-in, *posting* de minibar | P3 |
| WhatsApp Cloud API | REST Graph + webhooks + Flows | Mensajes, plantillas, media | P0 |
| Google Business Profile API | REST (acceso por solicitud), OAuth 2.0 | Reseñas/respuestas, ficha, posts | P0 |
| CONTPAQi / Aspel | SDK COM local | Pólizas, facturas, catálogos contables | P1 |
| Xero / QuickBooks / Alegra | REST OAuth 2.0 | Contabilidad, facturas, bancos | P2 |
| FlightAware AeroAPI / Flightradar24 / OpenSky | REST, API key/Bearer | Llegadas a CUN, horarios, histórico de vuelos | P1 |
| OpenWeather | REST, API key | Pronóstico, alertas climáticas | P1 |
| Belvo / Fintoc | Open banking API | Movimientos bancarios para conciliación | (H16) |
| Stripe / Conekta / Openpay / Mercado Pago / Clip | REST/SDK, OAuth/API key | Cobro, pre-autorización, VCC, terminal | P0/P1 |
| Seam | REST/SDK | Abstracción de cerraduras (TTLock, Vostio, Saflok, Onity) | P2 |

**Arquitectura de conectores (resumen ejecutivo del documento, p.23):** un conector OTA-XML genérico (pmsXchange y futuros CM) y un cliente FIAS en el edge cubren el mundo legado; OpenAPI propio → clientes generados para Mews/apaleo/Cloudbeds. Contratos JSON Schema versionados por entidad canónica; *feature flags* por propiedad; conciliación diaria automática y night audit canónico independiente del PMS.

**Orden de construcción en 5 fases (H15, p.22):**
1. Meses 2-5: Cloudbeds (escritura), Stripe MX + Conekta, PAC CFDI con ISH y global, Home Assistant edge + Shelly + Sensibo.
2. Meses 4-8: Mews Connector (demo pública), Seam + TTLock, PBX (Yeastar/Grandstream), FR24/AeroAPI, Lighthouse, descarga masiva SAT.
3. Meses 8-12: SiteMinder pmsXchange/SMX, Hostaway/Guesty, Openpay/MP Point/Clip PinPad, CONTPAQi/Aspel vía edge.
4. Meses 10-16: PMS ligero propio (≤30 hab) certificado en pmsXchange; HotelRunner/Omnibees; Google Hotel Center.
5. Meses 14-24: OHIP (con patrocinador), FIAS/IFC8 para OPERA 5, Visionline/Saflok vía Seam/FIAS, INNCOM, OAG/Cirium.

**Riesgos y mitigaciones destacados (H15, p.23):** límites de tasa no publicados (mitigación: rate limiter + backfill nocturno + webhooks-first), OHIP inaccesible sin patrocinio (mitigación: cubrir OPERA vía FIAS en el edge), cobro erróneo de VCC/pre-auth vencida (mitigación: máquina de estados de pago con `expiresAt`), CFDI de hospedaje mal timbrado (mitigación: validador fiscal previo + dos PAC intercambiables), cerraduras *prosumer* con cambios de API (mitigación: abstraer vía Seam), dependencia del edge sin conexión (mitigación: cola durable + heartbeats + 4G de respaldo), privacidad de huéspedes/PCI (mitigación: PII mínima, tokens de pasarela, cifrado — ver sección 4).
