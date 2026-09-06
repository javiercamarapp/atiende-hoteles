import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: ["default"],
    // .claude/worktrees/** son checkouts de OTROS agentes trabajando en paralelo (ver
    // instrucciones de esta tarea): vitest los recogia igual porque el patron posicional
    // "tests/unit"/"tests/integration" hace match por subcadena de ruta en cualquier
    // profundidad, duplicando la ejecucion de la misma suite (con su propio
    // embedded-postgres efimero) y produciendo fallos/flakiness ajenos a este repo.
    exclude: ["**/node_modules/**", "**/.claude/**", "**/dist/**"],
  },
});
