-- REQ-SEG-007 (P0/SEG): "todo mensaje de marketing incluye opción de baja" -- verificado
-- con "mensaje sin opción de baja -> rechazado por el linter de plantillas". La
-- infraestructura de OPT-IN (fecha/canal/texto antes de enviar) ya existe desde la
-- migración 0099 (`marketing_templates`, `isMarketingSendBlocked`, REQ-HUE-021); esta
-- migración agrega lo que faltaba para la segunda mitad del requisito: el TEXTO real de
-- cada plantilla de marketing, para que `lintMarketingTemplateBody()`
-- (packages/domain-hotel) pueda verificar que ese texto incluye una opción de baja
-- explícita ANTES de que la plantilla pueda clasificarse como marketing
-- (`PATCH .../mensajeria/config`, apps/api/src/routes/mensajeria.ts) -- y para que el
-- mensaje REAL que se envía (`createSendWhatsappTemplateTool`/`getMarketingTemplateBody`,
-- packages/agent-core) use ese mismo texto ya verificado como cuerpo persistido, en vez
-- de un resumen genérico que nunca pasó por el linter.
--
-- Clave = nombre de plantilla (mismo valor que un elemento de `marketing_templates`),
-- valor = texto completo que se envía al huésped (incluida la opción de baja). Default
-- vacío: ningún hotel existente queda con una plantilla de marketing "huérfana" de texto
-- por defecto (`marketing_templates` también default vacío desde 0099) -- la ruta de
-- configuración exige y valida el texto de CUALQUIER plantilla nueva que se agregue a
-- `marketing_templates` a partir de esta migración, pero nunca reinterpreta ni rechaza
-- retroactivamente una fila ya existente sin tocarla.
alter table public.hotel_messaging_config
  add column marketing_template_bodies jsonb not null default '{}'::jsonb;

comment on column public.hotel_messaging_config.marketing_template_bodies is
  'Texto real (incluida una opción de baja explícita) de cada plantilla clasificada como marketing en `marketing_templates`, indexado por nombre de plantilla (REQ-SEG-007). `PATCH /mensajeria/config` exige y valida este texto con el linter de plantillas (`lintMarketingTemplateBody`, packages/domain-hotel) antes de permitir que una plantilla se agregue a `marketing_templates`; el envío real (`getMarketingTemplateBody`, packages/agent-core) reutiliza este mismo texto ya verificado como cuerpo del mensaje persistido.';
