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
      "No se comparten los datos de los huéspedes de un hotel con otro hotel distinto dado de alta en la plataforma — cada hotel solo ve sus propias reservas y huéspedes.",
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
          Este documento describe el tratamiento de datos previsto por el diseño del producto (H3, frontend). La fecha
          de vigencia, el domicilio del responsable y el proceso de ejercicio de derechos ARCO están pendientes de que
          el fundador los confirme antes de publicarse como aviso legal definitivo — no se inventan aquí.
        </FaltaDato>
      }
      pie={<p>¿Dudas sobre tus datos? Escribe a la gerencia de tu hotel o al correo de soporte que te proporcionaron al darte de alta.</p>}
    />
  );
}

export default Privacidad;
