import { baseConfig } from "./packages/config/eslint.config.js";

export default [
  ...baseConfig,
  {
    ignores: [
      "apps/web/**",
      "packages/ui/**",
      "docs/**",
      // Worktree de otro agente trabajando en paralelo sobre apps/web y packages/ui
      // (ver instrucciones de esta tarea): no se toca ni se lintea desde aqui.
      ".claude/**"
    ]
  }
];
