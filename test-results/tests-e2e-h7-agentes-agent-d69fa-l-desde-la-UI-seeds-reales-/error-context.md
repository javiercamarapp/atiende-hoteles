# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tests/e2e/h7-agentes.spec.ts >> agentes: gate/techo, demo determinista (FakeProvider) y tarjeta de ROI en Resumen -- recorrido real desde la UI (seeds reales)
- Location: tests/e2e/h7-agentes.spec.ts:64:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByText(/sin datos todavía/i)
Expected: visible
Error: strict mode violation: getByText(/sin datos todavía/i) resolved to 4 elements:
    1) <p class="text-[11px] text-muted-foreground">Sin datos todavía.</p> aka getByText('Sin datos todavía.').first()
    2) <p class="text-[11px] text-muted-foreground">Sin datos todavía.</p> aka getByText('Sin datos todavía.').nth(1)
    3) <p class="text-[11px] text-muted-foreground">Sin datos todavía.</p> aka getByText('Sin datos todavía.').nth(2)
    4) <p class="text-[11px] text-muted-foreground">Sin datos todavía.</p> aka getByText('Sin datos todavía.').nth(3)

Call log:
  - Expect "toBeVisible" getByText(/sin datos todavía/i) with timeout 15000ms
  - waiting for getByText(/sin datos todavía/i)

```

# Page snapshot

```yaml
- generic [ref=f3e2]:
  - generic [ref=f3e3]:
    - link "Saltar al contenido principal" [ref=f3e4] [cursor=pointer]:
      - /url: "#contenido-principal"
    - complementary "Navegación principal" [ref=f3e6]:
      - generic [ref=f3e7]:
        - generic [ref=f3e8]:
          - img "atiende" [ref=f3e9]
          - generic [ref=f3e15]: atiende
        - button "Colapsar barra lateral" [ref=f3e16] [cursor=pointer]
      - button "Cambiar de hotel" [ref=f3e21] [cursor=pointer]:
        - generic [ref=f3e26]: Hotel Demo Centro
      - navigation [ref=f3e29]:
        - generic [ref=f3e30]:
          - paragraph [ref=f3e31]: ANÁLISIS
          - link "Resumen" [ref=f3e33] [cursor=pointer]:
            - /url: /resumen
        - generic [ref=f3e41]:
          - button "OPERACIÓN" [expanded] [ref=f3e42] [cursor=pointer]
          - generic [ref=f3e45]:
            - link "Reservas" [ref=f3e46] [cursor=pointer]:
              - /url: /reservas
            - link "Disponibilidad" [ref=f3e52] [cursor=pointer]:
              - /url: /disponibilidad
            - link "Recepción" [ref=f3e57] [cursor=pointer]:
              - /url: /recepcion
        - button "SERVICIOS" [ref=f3e66] [cursor=pointer]
        - button "HUÉSPEDES" [ref=f3e70] [cursor=pointer]
        - button "ADMINISTRAR" [ref=f3e74] [cursor=pointer]
      - generic [ref=f3e77]:
        - generic [ref=f3e78]:
          - button "Centro de ayuda" [ref=f3e79] [cursor=pointer]
          - link "Configuración" [ref=f3e84] [cursor=pointer]:
            - /url: /configuracion
          - generic [ref=f3e89]: gm
          - radiogroup "Tema de la interfaz" [ref=f3e95]:
            - radio "Tema claro" [checked] [ref=f3e96] [cursor=pointer]
            - radio "Seguir al sistema" [ref=f3e103] [cursor=pointer]
            - radio "Tema oscuro" [ref=f3e106] [cursor=pointer]
        - generic [ref=f3e110]:
          - generic [ref=f3e111]: G
          - generic [ref=f3e112]:
            - paragraph [ref=f3e113]: gm@hotel-demo-centro.demo
            - paragraph [ref=f3e114]: gm
          - button "Cerrar sesión" [ref=f3e115] [cursor=pointer]
    - generic [ref=f3e119]:
      - banner [ref=f3e120]:
        - button "1 notificaciones sin leer" [ref=f3e121] [cursor=pointer]:
          - generic [ref=f3e125]: "1"
        - link "Aprobaciones" [ref=f3e126] [cursor=pointer]:
          - /url: /aprobaciones
        - generic [ref=f3e132]: gm@hotel-demo-centro.demo
      - main [ref=f3e133]:
        - generic [ref=f3e135]:
          - generic [ref=f3e137]:
            - heading "Resumen" [level=1] [ref=f3e138]
            - paragraph [ref=f3e139]: Ocupación, tarifa promedio (ADR), RevPAR y reservas del día para el hotel seleccionado.
          - generic [ref=f3e140]:
            - generic [ref=f3e142]:
              - generic [ref=f3e143]: Ocupación
              - paragraph [ref=f3e151]: 0.0%
            - generic [ref=f3e153]:
              - generic [ref=f3e154]: ADR (tarifa promedio)
              - paragraph [ref=f3e163]: $1,850 MXN
            - generic [ref=f3e165]:
              - generic [ref=f3e166]: RevPAR
              - paragraph [ref=f3e173]: $0 MXN
            - generic [ref=f3e175]:
              - generic [ref=f3e176]: Reservas hoy
              - paragraph [ref=f3e183]: "0"
          - generic [ref=f3e184]:
            - heading "Valor generado por agentes de IA" [level=3] [ref=f3e186]
            - paragraph [ref=f3e190]: "Sin datos todavía: ningún agente ha registrado un evento de ROI este período."
    - region "Consentimiento de cookies y analítica" [ref=f3e191]:
      - generic [ref=f3e192]:
        - paragraph [ref=f3e193]:
          - text: Usamos analítica de producto para entender qué funciona del panel y mejorarlo. No la activamos sin tu permiso, y nunca incluye datos de huéspedes ni información personal identificable. Puedes leer el detalle en el
          - link "aviso de privacidad" [ref=f3e194] [cursor=pointer]:
            - /url: /privacidad
          - text: .
        - generic [ref=f3e195]:
          - button "Rechazar" [ref=f3e196] [cursor=pointer]
          - button "Aceptar analítica" [ref=f3e197] [cursor=pointer]
  - region "Notifications alt+T"
```

# Test source

```ts
  49  | }
  50  | 
  51  | function matarProceso(proc: ChildProcess | null) {
  52  |   if (!proc?.pid) return;
  53  |   try {
  54  |     process.kill(-proc.pid, "SIGTERM");
  55  |   } catch {
  56  |     try {
  57  |       proc.kill("SIGTERM");
  58  |     } catch {
  59  |       /* ya no existe */
  60  |     }
  61  |   }
  62  | }
  63  | 
  64  | test("agentes: gate/techo, demo determinista (FakeProvider) y tarjeta de ROI en Resumen -- recorrido real desde la UI (seeds reales)", async ({ page }, testInfo) => {
  65  |   test.setTimeout(180_000);
  66  | 
  67  |   const apiPort = await puertoLibre();
  68  |   const dbPort = await puertoLibre();
  69  |   const webPort = await puertoLibre();
  70  |   const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "atiende-hoteles-e2e-h7-"));
  71  | 
  72  |   let apiProc: ChildProcess | null = null;
  73  |   let webProc: ChildProcess | null = null;
  74  | 
  75  |   try {
  76  |     apiProc = spawn("node", ["--experimental-transform-types", "src/server.ts"], {
  77  |       cwd: API_DIR,
  78  |       detached: true,
  79  |       stdio: "pipe",
  80  |       env: {
  81  |         ...process.env,
  82  |         PORT: String(apiPort),
  83  |         DB_PORT: String(dbPort),
  84  |         DB_DATA_DIR: dataDir,
  85  |         JWT_SECRET: "e2e-test-jwt-secret-no-usar-en-produccion",
  86  |         NODE_ENV: "test",
  87  |         CORS_ALLOWED_ORIGINS: `http://localhost:${webPort}`,
  88  |       },
  89  |     });
  90  |     let apiOut = "";
  91  |     apiProc.stdout?.on("data", (d) => (apiOut += d.toString()));
  92  |     apiProc.stderr?.on("data", (d) => (apiOut += d.toString()));
  93  | 
  94  |     const apiOk = await esperarServidor(`http://localhost:${apiPort}/health`, 60_000);
  95  |     expect(apiOk, `apps/api no arrancó en 60s. Salida:\n${apiOut.slice(-4000)}`).toBeTruthy();
  96  | 
  97  |     webProc = spawn("npm", ["run", "dev", "--", "--port", String(webPort), "--strictPort"], {
  98  |       cwd: WEB_DIR,
  99  |       detached: true,
  100 |       stdio: "pipe",
  101 |       env: { ...process.env, VITE_API_URL: `http://localhost:${apiPort}` },
  102 |     });
  103 |     let webOut = "";
  104 |     webProc.stdout?.on("data", (d) => (webOut += d.toString()));
  105 |     webProc.stderr?.on("data", (d) => (webOut += d.toString()));
  106 | 
  107 |     const webOk = await esperarServidor(`http://localhost:${webPort}/`, 60_000);
  108 |     expect(webOk, `apps/web (vite dev) no arrancó en 60s. Salida:\n${webOut.slice(-4000)}`).toBeTruthy();
  109 | 
  110 |     await page.emulateMedia({ reducedMotion: "reduce" });
  111 |     const vp = testInfo.project.use.viewport;
  112 | 
  113 |     // Login real como gerencia (gm) del "Hotel Demo Centro" -- owner/gm pueden cambiar
  114 |     // gate/techo, además de disparar la demo.
  115 |     await page.goto(`http://localhost:${webPort}/login`);
  116 |     await page.getByLabel("Tu correo").fill("gm@hotel-demo-centro.demo");
  117 |     await page.getByLabel("Contraseña").fill("atiende-dev-2026");
  118 |     await page.getByRole("button", { name: /entrar/i }).click();
  119 |     await page.waitForURL(/\/resumen$/, { timeout: 15_000 });
  120 | 
  121 |     // ---- /agentes: catálogo real (gate "shadow" por default en los 3 agentes) ----
  122 |     await page.goto(`http://localhost:${webPort}/agentes`);
  123 |     await expect(page.getByRole("heading", { name: "Agentes" })).toBeVisible();
  124 |     await expect(page.getByText("Recepción virtual")).toBeVisible({ timeout: 15_000 });
  125 |     await expect(page.getByText("Sin corridas registradas este mes todavía.").first()).toBeVisible();
  126 |     await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `h7-agentes-catalogo-${vp?.width}x${vp?.height}.png`), fullPage: true });
  127 | 
  128 |     // ---- Demo determinista (FakeProvider, sin red) sobre "Recepción virtual" ----
  129 |     // AGENT_DEFINITIONS (packages/agent-core/src/agents.ts) lista recepcion_virtual
  130 |     // primero -- GET /hoteles/:hotelId/agentes preserva ese orden, así que el primer
  131 |     // botón "Demo (simulada)" de la grilla es el de recepción virtual.
  132 |     await page.getByRole("button", { name: "Demo (simulada)" }).first().click();
  133 |     await expect(page.getByText(/completado/i).first()).toBeVisible({ timeout: 15_000 });
  134 |     await expect(page.getByText("simulado").first()).toBeVisible();
  135 |     await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `h7-agentes-demo-${vp?.width}x${vp?.height}.png`), fullPage: true });
  136 | 
  137 |     // El costo del mes se actualiza tras la corrida (aunque sea $0.00 con FakeProvider
  138 |     // sin tabla de precios real para "fake" -- lo importante es que deja de mostrar
  139 |     // "sin corridas registradas").
  140 |     await page.reload();
  141 |     await expect(page.getByText("Recepción virtual")).toBeVisible({ timeout: 15_000 });
  142 | 
  143 |     // ---- /resumen: tarjeta de ROI etiquetada "estimado, supuestos H17-v1" ----
  144 |     await page.goto(`http://localhost:${webPort}/resumen`);
  145 |     await expect(page.getByText("Valor generado por agentes de IA")).toBeVisible({ timeout: 15_000 });
  146 |     // La demo de recepción_virtual corrió en gate "shadow": registrar_evento_roi NO se
  147 |     // ejecuta en shadow (AgentRunner omite toda tool write/external/money) -- la tarjeta
  148 |     // debe mostrar "sin datos todavía" de forma honesta, nunca un cero fabricado.
> 149 |     await expect(page.getByText(/sin datos todavía/i)).toBeVisible({ timeout: 15_000 });
      |                                                        ^ Error: expect(locator).toBeVisible() failed
  150 |     await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `h7-resumen-roi-${vp?.width}x${vp?.height}.png`), fullPage: true });
  151 |   } finally {
  152 |     matarProceso(apiProc);
  153 |     matarProceso(webProc);
  154 |     await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  155 |   }
  156 | });
  157 | 
```