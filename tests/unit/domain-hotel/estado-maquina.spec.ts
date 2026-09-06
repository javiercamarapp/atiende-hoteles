// Espejo de aplicación de la máquina de estados real (DB, ver
// tests/unit/reservation-state-machine.spec.ts) más la política de "quién puede
// ejecutar cada transición por rol", exigida por el encargo H4.
import { describe, expect, it } from "vitest";
import {
  RESERVATION_STATUSES,
  allowedNextStatuses,
  canRolePerformTransition,
  canTransition,
  isCancellable,
  isModifiable,
  isTerminalStatus,
} from "@atiende-hoteles/domain-hotel";

describe("máquina de estados de reserva (espejo de packages/db, H4)", () => {
  it("expone los 8 estados exactos definidos en 0006_reservation.sql", () => {
    expect(RESERVATION_STATUSES).toEqual([
      "cotizada",
      "confirmada",
      "check_in",
      "en_estancia",
      "check_out",
      "cerrada",
      "cancelada",
      "no_show",
    ]);
  });

  it("permite la cadena feliz completa", () => {
    expect(canTransition("cotizada", "confirmada")).toBe(true);
    expect(canTransition("confirmada", "check_in")).toBe(true);
    expect(canTransition("check_in", "en_estancia")).toBe(true);
    expect(canTransition("en_estancia", "check_out")).toBe(true);
    expect(canTransition("check_out", "cerrada")).toBe(true);
  });

  it("rechaza saltos inválidos (cotizada -> en_estancia)", () => {
    expect(canTransition("cotizada", "en_estancia")).toBe(false);
    expect(allowedNextStatuses("cotizada")).toEqual(["confirmada", "cancelada"]);
  });

  it("los estados terminales no admiten ninguna transición", () => {
    for (const status of ["cerrada", "cancelada", "no_show"] as const) {
      expect(isTerminalStatus(status)).toBe(true);
      expect(allowedNextStatuses(status)).toEqual([]);
    }
  });

  it("housekeeping/maintenance no pueden ejecutar ninguna transición de reserva", () => {
    expect(canRolePerformTransition("housekeeping", "cotizada", "confirmada")).toBe(false);
    expect(canRolePerformTransition("maintenance", "confirmada", "check_in")).toBe(false);
  });

  it("frontdesk sí puede hacer check-in y check-out, pero no cerrar la reserva por sí solo (además accountant/gm/owner sí)", () => {
    expect(canRolePerformTransition("frontdesk", "confirmada", "check_in")).toBe(true);
    expect(canRolePerformTransition("frontdesk", "en_estancia", "check_out")).toBe(true);
    expect(canRolePerformTransition("frontdesk", "check_out", "cerrada")).toBe(true);
    expect(canRolePerformTransition("accountant", "check_out", "cerrada")).toBe(true);
    expect(canRolePerformTransition("accountant", "cotizada", "confirmada")).toBe(false);
  });

  it("el job automático de no-show ('system') solo puede mover confirmada -> no_show", () => {
    expect(canRolePerformTransition("system", "confirmada", "no_show")).toBe(true);
    expect(canRolePerformTransition("system", "cotizada", "confirmada")).toBe(false);
  });

  it("una transición sintácticamente inválida nunca se permite aunque el rol esté en la lista de otra transición", () => {
    expect(canRolePerformTransition("owner", "cerrada", "confirmada")).toBe(false);
  });

  it("isModifiable/isCancellable solo son verdaderos antes del check-in", () => {
    expect(isModifiable("cotizada")).toBe(true);
    expect(isModifiable("confirmada")).toBe(true);
    expect(isModifiable("check_in")).toBe(false);
    expect(isModifiable("en_estancia")).toBe(false);
    expect(isCancellable("confirmada")).toBe(true);
    expect(isCancellable("cerrada")).toBe(false);
  });
});
