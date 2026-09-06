// H12a · Script de preview local: recorre `TEMPLATES`, renderiza cada plantilla con sus
// datos de ejemplo, guarda el HTML en docs/correos/preview/<slug>.html y captura dos
// anchos (600px desktop, 375px móvil) con Chromium headless vía playwright-core. No usa
// ningún servidor real de correo -- es solo para revisión visual humana antes de un
// deploy (mismo espíritu que Storybook, pero sin dependencia nueva).
//
// Uso: node --experimental-strip-types packages/email/scripts/preview.ts
//   (o `npm run email:preview -w @atiende-hoteles/email`)
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { TEMPLATES } from "../src/templates/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/email/scripts -> repo root: sube 3 niveles (scripts -> email -> packages -> raíz).
const REPO_ROOT = join(__dirname, "..", "..", "..");
const OUT_DIR = join(REPO_ROOT, "docs", "correos", "preview");

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const slugs = Object.keys(TEMPLATES);
  const browser = await chromium.launch();

  const generated: string[] = [];

  try {
    for (const slug of slugs) {
      const { render, sample } = TEMPLATES[slug]!;
      const data = sample();
      const rendered = render(data);

      const htmlPath = join(OUT_DIR, `${slug}.html`);
      await writeFile(htmlPath, rendered.html, "utf8");
      generated.push(htmlPath);

      const desktopPath = join(OUT_DIR, `${slug}.png`);
      const mobilePath = join(OUT_DIR, `${slug}-movil.png`);

      const desktopPage = await browser.newPage({ viewport: { width: 600, height: 900 } });
      await desktopPage.setContent(rendered.html, { waitUntil: "networkidle" });
      await desktopPage.screenshot({ path: desktopPath, fullPage: true });
      await desktopPage.close();
      generated.push(desktopPath);

      const mobilePage = await browser.newPage({ viewport: { width: 375, height: 900 } });
      await mobilePage.setContent(rendered.html, { waitUntil: "networkidle" });
      await mobilePage.screenshot({ path: mobilePath, fullPage: true });
      await mobilePage.close();
      generated.push(mobilePath);

      console.log(`OK  ${slug}`);
    }
  } finally {
    await browser.close();
  }

  console.log(`\n${slugs.length} plantillas renderizadas.`);
  console.log(`Archivos generados en ${OUT_DIR}:`);
  for (const path of generated) console.log(`  - ${path}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
