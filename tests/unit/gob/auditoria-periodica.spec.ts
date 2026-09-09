// REQ-OBS-003 (GOB-009, BP-142/BP-143): "El sistema debe ejecutar una auditoría
// periódica automatizada cada N tareas cerradas del backlog (checklist del blueprint) y
// escribir el veredicto en un documento fechado; un veredicto rojo detiene el loop de
// construcción hasta resolución." Corre contra directorios temporales sintéticos
// (`tasks/`/`docs/auditoria-N/` reales pero efímeros, checklist inyectado) -- mismo
// patrón que tests/unit/gob/evidencia-obligatoria-cierre.spec.ts/gate-por-tarea.spec.ts
// -- nunca contra el repo real (que hoy no tiene `tasks/`, ver el propio script) ni
// contra los ~16 checks reales de `scripts/checks/` (lento y no determinista para una
// prueba unitaria; el checklist real se ejercita indirectamente por
// `discoverChecklist`/`runChecklistItemReal`, ver más abajo).
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeVerdict,
  contarTareasCerradas,
  type ChecklistItem,
  type ChecklistItemResult,
  discoverChecklist,
  leerUltimoVeredicto,
  resolverRonda,
  runChecklistItemReal,
  runPeriodicAudit,
} from "../../../scripts/checks/auditoria-periodica.ts";
import { isBuildLoopBlockedByAudit } from "../../../packages/agent-core/src/backlog/backlogStateMachine.ts";

let dirs: string[] = [];

function crearDirTemporal(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function escribirTarea(root: string, nombre: string, status: string): void {
  writeFileSync(join(root, nombre), `---\nid: ${nombre}\nstatus: ${status}\n---\n\n# ${nombre}\n`);
}

function checklistSintetico(resultados: Record<string, boolean>): {
  checklist: ChecklistItem[];
  runItem: (item: ChecklistItem) => ChecklistItemResult;
} {
  const checklist = Object.keys(resultados).map((id) => ({ id, path: `/no-existe/${id}.ts` }));
  const runItem = (item: ChecklistItem): ChecklistItemResult =>
    resultados[item.id]
      ? { id: item.id, ok: true, exitCode: 0, detail: "ok" }
      : { id: item.id, ok: false, exitCode: 1, detail: `${item.id} falló` };
  return { checklist, runItem };
}

describe("contarTareasCerradas", () => {
  it("cuenta solo status: done, ignora otros estados", () => {
    const tasksDir = crearDirTemporal("obs003-tasks-");
    escribirTarea(tasksDir, "a.md", "done");
    escribirTarea(tasksDir, "b.md", "done");
    escribirTarea(tasksDir, "c.md", "doing");
    escribirTarea(tasksDir, "d.md", "ready");
    expect(contarTareasCerradas(tasksDir)).toBe(2);
  });

  it("0 si tasks/ no existe (backlog de archivos aún no materializado)", () => {
    expect(contarTareasCerradas(join(tmpdir(), "obs003-no-existe-nunca"))).toBe(0);
  });
});

describe("discoverChecklist / runChecklistItemReal: contra el catálogo real de scripts/checks/", () => {
  it("autodescubre al menos los checks reales conocidos y se excluye a sí mismo", () => {
    const items = discoverChecklist();
    const ids = items.map((i) => i.id);
    expect(ids).toContain("gate-por-tarea");
    expect(ids).toContain("no-tests-skip");
    expect(ids).not.toContain("auditoria-periodica");
  });

  it("runChecklistItemReal corre un check real que pasa (exit 0) -> ok:true", () => {
    const items = discoverChecklist();
    const item = items.find((i) => i.id === "registro-unico-conectores")!;
    const result = runChecklistItemReal(item);
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("runChecklistItemReal corre un script inexistente -> ok:false, exitCode != 0", () => {
    const result = runChecklistItemReal({ id: "no-existe", path: "/ruta/que/no/existe.ts" });
    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
  });
});

describe("computeVerdict", () => {
  it("verde si todos los ítems pasan", () => {
    expect(computeVerdict([{ id: "a", ok: true, exitCode: 0, detail: "" }])).toBe("verde");
  });

  it("rojo si al menos un ítem falla", () => {
    expect(
      computeVerdict([
        { id: "a", ok: true, exitCode: 0, detail: "" },
        { id: "b", ok: false, exitCode: 1, detail: "x" },
      ]),
    ).toBe("rojo");
  });
});

describe("runPeriodicAudit: ciclo completo (GOB-009)", () => {
  it("con 0 tareas cerradas, no toca ronda -- verde trivial, no escribe documento", () => {
    const tasksDir = crearDirTemporal("obs003-tasks-");
    const auditDir = join(crearDirTemporal("obs003-audit-"), "auditoria-N");
    const { checklist, runItem } = checklistSintetico({ a: true });

    const outcome = runPeriodicAudit({ tasksDir, auditDir, checklist, runItem });
    expect(outcome.ranNewRound).toBe(false);
    expect(outcome.blocked).toBe(false);
    expect(existsSync(auditDir)).toBe(false);
  });

  it("con 7 tareas cerradas (no múltiplo de 8), no toca ronda", () => {
    const tasksDir = crearDirTemporal("obs003-tasks-");
    for (let i = 1; i <= 7; i++) escribirTarea(tasksDir, `t-${i}.md`, "done");
    const auditDir = join(crearDirTemporal("obs003-audit-"), "auditoria-N");
    const { checklist, runItem } = checklistSintetico({ a: true });

    const outcome = runPeriodicAudit({ tasksDir, auditDir, checklist, runItem });
    expect(outcome.ranNewRound).toBe(false);
    expect(outcome.blocked).toBe(false);
  });

  it("con 8 tareas cerradas y checklist en verde: escribe veredicto verde, no bloquea", () => {
    const tasksDir = crearDirTemporal("obs003-tasks-");
    for (let i = 1; i <= 8; i++) escribirTarea(tasksDir, `t-${i}.md`, "done");
    const auditDir = join(crearDirTemporal("obs003-audit-"), "auditoria-N");
    const { checklist, runItem } = checklistSintetico({ a: true, b: true });

    const outcome = runPeriodicAudit({ tasksDir, auditDir, checklist, runItem, now: () => new Date("2026-09-08T00:00:00Z") });
    expect(outcome.ranNewRound).toBe(true);
    expect(outcome.blocked).toBe(false);
    expect(outcome.audit?.verdict).toBe("verde");
    expect(outcome.audit?.round).toBe(1);
    expect(outcome.audit?.closedTaskCount).toBe(8);

    const contenido = readFileSync(join(auditDir, "ronda-1.md"), "utf8");
    expect(contenido).toContain("veredicto: verde");
    expect(contenido).toContain("fecha: 2026-09-08");
    expect(contenido).toContain("resuelto: false");
  });

  it("con 8 tareas cerradas y un ítem del checklist en rojo: escribe veredicto rojo y BLOQUEA", () => {
    const tasksDir = crearDirTemporal("obs003-tasks-");
    for (let i = 1; i <= 8; i++) escribirTarea(tasksDir, `t-${i}.md`, "done");
    const auditDir = join(crearDirTemporal("obs003-audit-"), "auditoria-N");
    const { checklist, runItem } = checklistSintetico({ a: true, b: false });

    const outcome = runPeriodicAudit({ tasksDir, auditDir, checklist, runItem });
    expect(outcome.ranNewRound).toBe(true);
    expect(outcome.blocked).toBe(true);
    expect(outcome.audit?.verdict).toBe("rojo");
    expect(outcome.audit?.resolved).toBe(false);

    const contenido = readFileSync(join(auditDir, "ronda-1.md"), "utf8");
    expect(contenido).toContain("veredicto: rojo");
    expect(contenido).toContain("**ROJO**");
    expect(contenido).toMatch(/`b`.*\*\*ROJO\*\*/);
  });

  it("un veredicto rojo sin resolver sigue bloqueando aunque NO toque ronda nueva todavía", () => {
    const tasksDir = crearDirTemporal("obs003-tasks-");
    for (let i = 1; i <= 8; i++) escribirTarea(tasksDir, `t-${i}.md`, "done");
    const auditDir = join(crearDirTemporal("obs003-audit-"), "auditoria-N");
    const rojo = checklistSintetico({ a: false });
    runPeriodicAudit({ tasksDir, auditDir, checklist: rojo.checklist, runItem: rojo.runItem });

    // Se re-corre SIN agregar tareas (sigue en 8, no toca ronda 2) -- debe seguir
    // bloqueado por la ronda 1 sin resolver, no "nada que hacer".
    const verde = checklistSintetico({ a: true });
    const outcome = runPeriodicAudit({ tasksDir, auditDir, checklist: verde.checklist, runItem: verde.runItem });
    expect(outcome.ranNewRound).toBe(false);
    expect(outcome.blocked).toBe(true);
    expect(outcome.audit?.round).toBe(1);
    expect(outcome.message).toMatch(/BLOQUEADO/);
  });

  it("re-correr con el MISMO conteo de tareas (misma ronda) no re-ejecuta el checklist", () => {
    const tasksDir = crearDirTemporal("obs003-tasks-");
    for (let i = 1; i <= 8; i++) escribirTarea(tasksDir, `t-${i}.md`, "done");
    const auditDir = join(crearDirTemporal("obs003-audit-"), "auditoria-N");
    const verde = checklistSintetico({ a: true });
    const primero = runPeriodicAudit({ tasksDir, auditDir, checklist: verde.checklist, runItem: verde.runItem });
    expect(primero.ranNewRound).toBe(true);

    let corridas = 0;
    const segundo = runPeriodicAudit({
      tasksDir,
      auditDir,
      checklist: verde.checklist,
      runItem: (item) => {
        corridas++;
        return verde.runItem(item);
      },
    });
    expect(segundo.ranNewRound).toBe(false);
    expect(corridas).toBe(0);
  });

  it("resolverRonda marca resuelto:true y libera el loop -- ronda 2 puede correr normalmente", () => {
    const tasksDir = crearDirTemporal("obs003-tasks-");
    for (let i = 1; i <= 8; i++) escribirTarea(tasksDir, `t-${i}.md`, "done");
    const auditDir = join(crearDirTemporal("obs003-audit-"), "auditoria-N");
    const rojo = checklistSintetico({ a: false });
    runPeriodicAudit({ tasksDir, auditDir, checklist: rojo.checklist, runItem: rojo.runItem });

    const resuelta = resolverRonda(1, auditDir);
    expect(resuelta.resolved).toBe(true);
    expect(isBuildLoopBlockedByAudit(resuelta)).toBe(false);

    const ultimo = leerUltimoVeredicto(auditDir)!;
    expect(ultimo.resolved).toBe(true);
    expect(ultimo.verdict).toBe("rojo"); // el veredicto histórico no se reescribe, solo `resuelto`

    // Ahora, con 16 tareas cerradas (toca ronda 2), el loop corre libre de nuevo.
    for (let i = 9; i <= 16; i++) escribirTarea(tasksDir, `t-${i}.md`, "done");
    const verde = checklistSintetico({ a: true });
    const outcome = runPeriodicAudit({ tasksDir, auditDir, checklist: verde.checklist, runItem: verde.runItem });
    expect(outcome.blocked).toBe(false);
    expect(outcome.ranNewRound).toBe(true);
    expect(outcome.audit?.round).toBe(2);
  });

  it("resolverRonda sobre una ronda inexistente lanza error explícito", () => {
    const auditDir = join(crearDirTemporal("obs003-audit-"), "auditoria-N");
    expect(() => resolverRonda(99, auditDir)).toThrow(/ronda_no_encontrada/);
  });
});

describe("leerUltimoVeredicto", () => {
  it("null si el directorio de auditoría no existe todavía", () => {
    expect(leerUltimoVeredicto(join(tmpdir(), "obs003-nunca-existe"))).toBeNull();
  });

  it("con varias rondas, devuelve la de mayor número, no la última escrita en disco", () => {
    const auditDir = crearDirTemporal("obs003-audit-");
    writeFileSync(
      join(auditDir, "ronda-2.md"),
      "---\nronda: 2\nfecha: 2026-01-02\ntareasCerradas: 16\nveredicto: verde\nresuelto: true\n---\n",
    );
    writeFileSync(
      join(auditDir, "ronda-1.md"),
      "---\nronda: 1\nfecha: 2026-01-01\ntareasCerradas: 8\nveredicto: rojo\nresuelto: true\n---\n",
    );
    const ultimo = leerUltimoVeredicto(auditDir);
    expect(ultimo?.round).toBe(2);
  });
});
