import { LegalPage, FaltaDato, type SeccionLegal } from "./legal/LegalPage";

const SECCIONES: SeccionLegal[] = [
  {
    titulo: "1. Quién es responsable de tus datos",
    parrafos: [
      "Este aviso aplica a dos grupos de personas distintos, con responsables distintos:",
      "**Personal del hotel** (dueños, gerencia, recepción, housekeeping, mantenimiento con acceso al panel): sus datos de cuenta (correo, nombre, rol) son tratados por **atiende.ai** como responsable, para operar el panel.",
      "**Huéspedes del hotel** (quienes reservan o se hospedan): sus datos (nombre, contacto, fechas de estancia, folio) pertenecen a la relación comercial entre esa persona y el **hotel**. El hotel es el responsable de esos datos frente a la ley; atiende.ai los trata **por cuenta del hotel**, como encargado, únicamente para prestar el servicio de reservas y atención.",
    ],
  },
  {
    titulo: "2. Qué datos se recaban",
    parrafos: [
      "De quien reserva o se hospeda: nombre, contacto, fechas de llegada/salida, tipo de habitación y, cuando el hotel lo requiere para el registro obligatorio, identificación oficial.",
      "De la conversación por WhatsApp/voz: el historial de mensajes o la transcripción de la llamada con el agente conversacional, para dar seguimiento a una reserva o solicitud.",
      "Del personal del hotel: correo electrónico, nombre, teléfono (opcional) y el rol que tiene dentro del panel.",
    ],
  },
  {
    titulo: "3. Para qué se usan",
    parrafos: [
      "Para gestionar la reserva, el check-in/check-out, el folio de consumo y las solicitudes de housekeeping/mantenimiento; para que el hotel pueda auditar una conversación si hay una duda sobre una reserva; y para operar y dar soporte al panel del hotel.",
      "No se usan para fines publicitarios propios de atiende.ai ni se venden a terceros.",
    ],
  },
  {
    titulo: "4. Con quién se comparten",
    fundamento: "Ver docs/REQUISITOS.md §3.16 (integraciones externas) de este mismo proyecto para el catálogo completo, incluidas las pendientes de credenciales.",
    parrafos: [
      "Con los proveedores que hacen posible el servicio, únicamente en la medida necesaria para operarlo: WhatsApp Cloud API (Meta), el proveedor de gestión hotelera (PMS), el proveedor de pagos y el PAC de facturación (CFDI).",
      "**Con el proveedor de inteligencia artificial que redacta las respuestas del asistente conversacional** (Anthropic y/o, según la configuración de cada hotel, OpenRouter como enrutador hacia otros modelos): el texto de tu conversación por WhatsApp/voz/web con el asistente —tu mensaje y el contexto mínimo necesario de tu reserva— se envía a ese proveedor para generar la respuesta. Es un tratamiento necesario para que el asistente funcione, no un uso adicional o publicitario del dato. Estos proveedores operan fuera de México (transferencia internacional de datos personales); no se les envía el número completo de tu documento de identidad ni datos de tarjeta.",
      "Si prefieres no interactuar con el asistente de inteligencia artificial, puedes pedir en cualquier momento que te atienda una persona del hotel — el propio asistente lo ofrece desde el primer mensaje (ver sección 6).",
      "No se comparten los datos de los huéspedes de un hotel con otro hotel distinto dado de alta en la plataforma — cada hotel solo ve sus propias reservas y huéspedes.",
    ],
  },
  {
    titulo: "5. Consentimiento",
    parrafos: [
      "Antes de capturar tu documento de identidad en el check-in en línea, se te pide aceptar expresamente este aviso — esa aceptación queda registrada con fecha, canal y la versión del aviso vigente en ese momento.",
      "Si el hotel te contacta con fines de mercadotecnia (promociones, encuestas fuera de tu estancia), puedes darte de baja en cualquier momento respondiendo \"BAJA\" o pidiéndolo directamente — dejarás de recibir esos mensajes. Esto no afecta los mensajes operativos de tu reserva (confirmaciones, recordatorios de check-in, etc.).",
    ],
  },
  {
    titulo: "6. Uso de inteligencia artificial",
    parrafos: [
      "El asistente que te atiende por WhatsApp se identifica como un sistema de inteligencia artificial desde el primer mensaje de cada conversación, y te indica que una persona del hotel puede intervenir cuando lo necesites.",
      "El asistente nunca decide el precio de tu reserva, ni presenta impuestos/ISH, ni autoriza cargos por sí mismo — esas decisiones siempre pasan por el motor de reglas del hotel o por una persona.",
    ],
  },
  {
    titulo: "7. Derechos ARCO (Acceso, Rectificación, Cancelación, Oposición)",
    parrafos: [
      "Puedes pedir una copia de tus datos a través de un enlace de un solo uso que el hotel te puede generar bajo solicitud (recepción/gerencia verifica tu identidad y te lo entrega).",
      "Para pedir la rectificación de un dato incorrecto, la cancelación (borrado) de tus datos, u oponerte a un tratamiento en particular, puedes presentar una solicitud directamente con el hotel — queda registrada con un plazo de respuesta y seguimiento auditable.",
    ],
  },
];

export function Privacidad() {
  return (
    <LegalPage
      etiqueta="Aviso de privacidad"
      bajada="Aplica al panel de Atiende Hoteles y a los canales conversacionales que opera."
      vigenteDesde="pendiente de confirmar con el equipo legal del fundador"
      secciones={SECCIONES}
      aviso={
        <FaltaDato>
          Este documento describe el tratamiento de datos previsto por el diseño del producto (H3, frontend). El
          camino técnico para ejercer derechos ARCO ya existe (exportación por enlace de un solo uso + solicitud
          auditada con plazo, auditoría-2/correccion-A). Pendientes de que el fundador/equipo legal los confirme antes
          de publicarse como aviso legal definitivo — no se inventan aquí: la fecha de vigencia, el domicilio del
          responsable, el texto final de esta página, el nombre exacto del DPO/responsable de datos, y el plazo legal
          preciso de respuesta a una brecha de seguridad (ver docs/runbooks/incidentes.md).
        </FaltaDato>
      }
      pie={<p>¿Dudas sobre tus datos? Escribe a la gerencia de tu hotel o al correo de soporte que te proporcionaron al darte de alta.</p>}
    />
  );
}

export default Privacidad;
