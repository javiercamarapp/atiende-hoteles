// REQ-CRM-003 (P1/F): "El sistema debe generar automáticamente un ticket de
// mantenimiento cuando se acumulan N menciones negativas del mismo tema en una
// ventana de tiempo definida (p.ej. 3 en 14 días)." Verifica la política PURA
// (`evaluarAcumulacionTicket`): (1) el caso literal del criterio de aceptación --
// N-1 menciones no dispara, N sí; (2) el borde exacto de la ventana (inclusive en
// ambos extremos) y justo fuera de ella; (3) un ticket ya vigente para el mismo tema
// nunca se duplica aunque el umbral se cumpla; (4) config personalizada (N/ventana
// distintos al default).
import { describe, expect, it } from "vitest";
import { ACUMULACION_TICKET_DEFAULT, evaluarAcumulacionTicket } from "@atiende-hoteles/domain-hotel";

const DIA_MS = 24 * 60 * 60 * 1000;

describe("evaluarAcumulacionTicket (REQ-CRM-003)", () => {
  const ahora = new Date("2026-09-11T12:00:00.000Z");

  it("caso literal del criterio: N menciones (3 en 14 días) SÍ dispara ticket", () => {
    const resultado = evaluarAcumulacionTicket({
      fechaActual: ahora,
      fechasMencionesPrevias: [
        new Date(ahora.getTime() - 1 * DIA_MS),
        new Date(ahora.getTime() - 6 * DIA_MS),
      ],
      yaExisteTicketReciente: false,
    });
    // 2 previas + la actual = 3 = umbral default -> dispara.
    expect(resultado.totalMenciones).toBe(3);
    expect(resultado.umbralMenciones).toBe(ACUMULACION_TICKET_DEFAULT.umbralMenciones);
    expect(resultado.disparaTicket).toBe(true);
  });

  it("caso literal del criterio: N-1 menciones (solo 1 previa + la actual = 2) NO dispara ticket", () => {
    const resultado = evaluarAcumulacionTicket({
      fechaActual: ahora,
      fechasMencionesPrevias: [new Date(ahora.getTime() - 1 * DIA_MS)],
      yaExisteTicketReciente: false,
    });
    expect(resultado.totalMenciones).toBe(2);
    expect(resultado.disparaTicket).toBe(false);
  });

  it("sin ninguna mención previa (solo la actual) nunca dispara con el umbral default", () => {
    const resultado = evaluarAcumulacionTicket({ fechaActual: ahora, fechasMencionesPrevias: [], yaExisteTicketReciente: false });
    expect(resultado.totalMenciones).toBe(1);
    expect(resultado.disparaTicket).toBe(false);
  });

  it("una mención EXACTAMENTE en el borde de la ventana (14 días atrás) todavía cuenta", () => {
    const resultado = evaluarAcumulacionTicket({
      fechaActual: ahora,
      fechasMencionesPrevias: [
        new Date(ahora.getTime() - 14 * DIA_MS), // exactamente en el borde -> cuenta
        new Date(ahora.getTime() - 1 * DIA_MS),
      ],
      yaExisteTicketReciente: false,
    });
    expect(resultado.totalMenciones).toBe(3);
    expect(resultado.disparaTicket).toBe(true);
  });

  it("una mención justo FUERA de la ventana (14 días y 1 milisegundo atrás) no cuenta", () => {
    const resultado = evaluarAcumulacionTicket({
      fechaActual: ahora,
      fechasMencionesPrevias: [
        new Date(ahora.getTime() - 14 * DIA_MS - 1), // 1ms fuera de la ventana -> no cuenta
        new Date(ahora.getTime() - 1 * DIA_MS),
      ],
      yaExisteTicketReciente: false,
    });
    expect(resultado.totalMenciones).toBe(2); // solo la de -1 día + la actual
    expect(resultado.disparaTicket).toBe(false);
  });

  it("una mención futura respecto a fechaActual (dato corrupto/reloj distinto) no cuenta", () => {
    const resultado = evaluarAcumulacionTicket({
      fechaActual: ahora,
      fechasMencionesPrevias: [new Date(ahora.getTime() + 1 * DIA_MS), new Date(ahora.getTime() - 1 * DIA_MS)],
      yaExisteTicketReciente: false,
    });
    expect(resultado.totalMenciones).toBe(2);
  });

  it("umbral alcanzado pero YA existe un ticket reciente para el mismo tema: nunca duplica", () => {
    const resultado = evaluarAcumulacionTicket({
      fechaActual: ahora,
      fechasMencionesPrevias: [new Date(ahora.getTime() - 1 * DIA_MS), new Date(ahora.getTime() - 2 * DIA_MS)],
      yaExisteTicketReciente: true,
    });
    expect(resultado.totalMenciones).toBe(3);
    expect(resultado.disparaTicket).toBe(false);
  });

  it("config personalizada: umbral=5 en ventana de 7 días", () => {
    const config = { umbralMenciones: 5, ventanaDias: 7 };
    const cuatroPrevias = [1, 2, 3, 4].map((d) => new Date(ahora.getTime() - d * DIA_MS));
    const conCuatro = evaluarAcumulacionTicket({ fechaActual: ahora, fechasMencionesPrevias: cuatroPrevias, yaExisteTicketReciente: false, config });
    expect(conCuatro.totalMenciones).toBe(5);
    expect(conCuatro.disparaTicket).toBe(true);

    const tresPrevias = [1, 2, 3].map((d) => new Date(ahora.getTime() - d * DIA_MS));
    const conTres = evaluarAcumulacionTicket({ fechaActual: ahora, fechasMencionesPrevias: tresPrevias, yaExisteTicketReciente: false, config });
    expect(conTres.totalMenciones).toBe(4);
    expect(conTres.disparaTicket).toBe(false);

    // Una de las 4 previas cae fuera de la ventana de 7 días (8 días atrás) -> no cuenta.
    const conUnaFueraDeVentana = evaluarAcumulacionTicket({
      fechaActual: ahora,
      fechasMencionesPrevias: [...tresPrevias, new Date(ahora.getTime() - 8 * DIA_MS)],
      yaExisteTicketReciente: false,
      config,
    });
    expect(conUnaFueraDeVentana.totalMenciones).toBe(4);
    expect(conUnaFueraDeVentana.disparaTicket).toBe(false);
  });
});
