import { defineConfig, devices } from "@playwright/test";

// Playwright corre desde apps/web (donde vive `npm run dev`), pero las
// specs y las capturas viven en tests/e2e/ (permiso de escritura de este
// agente) para no meter infraestructura de pruebas bajo apps/web/**.
// `channel: 'chrome'` usa el Chrome del sistema — sin descargar navegadores
// (encargo H3, punto 4).
export default defineConfig({
  testDir: "../../tests/e2e",
  outputDir: "../../tests/e2e/.playwright-results",
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:4173",
    channel: "chrome",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run preview -- --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], channel: "chrome", viewport: { width: 1280, height: 800 } },
    },
    {
      name: "mobile",
      use: {
        ...devices["Desktop Chrome"],
        channel: "chrome",
        viewport: { width: 390, height: 844 },
        hasTouch: true,
      },
    },
  ],
});
