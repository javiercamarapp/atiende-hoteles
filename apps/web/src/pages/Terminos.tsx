import { LegalPage, FaltaDato, type SeccionLegal } from "./legal/LegalPage";

const SECCIONES: SeccionLegal[] = [
  {
    titulo: "1. Qué es este servicio",
    parrafos: [
      "Atiende Hoteles es un panel de operación hotelera (reservas, disponibilidad, recepción, housekeeping, mantenimiento, alimentos y bebidas, mensajería y reputación) más agentes conversacionales por WhatsApp/voz para huéspedes.",
    ],
  },
  {
    titulo: "2. Cuentas de personal",
    parrafos: [
      "El acceso al panel se otorga por rol (`owner`, `gm`, `frontdesk`, `reservations`, `housekeeping`, `maintenance`, `fnb`, `accountant`) dado de alta por la gerencia del hotel. Cada persona es responsable de mantener su contraseña confidencial y de las acciones realizadas con su sesión.",
    ],
  },
  {
    titulo: "3. Disponibilidad del servicio",
    parrafos: [
      "El panel depende de integraciones externas (PMS, WhatsApp, pagos, facturación) que pueden estar pendientes de credenciales en un hotel recién dado de alta; mientras eso ocurra, las pantallas correspondientes lo declaran explícitamente en vez de simular datos.",
    ],
  },
];

export function Terminos() {
  return (
    <LegalPage
      etiqueta="Términos de servicio"
      bajada="Aplica al panel de Atiende Hoteles y a los canales conversacionales que opera."
      vigenteDesde="pendiente de confirmar con el equipo legal del fundador"
      secciones={SECCIONES}
      aviso={
        <FaltaDato>
          Documento provisional de H3 (frontend). La versión legal definitiva, jurisdicción y proceso de resolución de
          disputas están pendientes de revisión del fundador antes de publicarse.
        </FaltaDato>
      }
      pie={<p>¿Dudas sobre estos términos? Escribe a la gerencia de tu hotel o al correo de soporte que te proporcionaron al darte de alta.</p>}
    />
  );
}

export default Terminos;
