#!/usr/bin/env node
// REQ-TEN-002 · revisión estática: complementa a tests/integration/schema/location.spec.ts
// (que confirma la FORMA real del esquema contra un motor vivo). Esta mitad revisa el
// TEXTO de las migraciones para atrapar el caso que el criterio de aceptación nombra
// explícitamente: "una migración que intente crear una tabla `hotel` paralela sin usar
// `location` falla la revisión" -- es decir, que en algún momento futuro alguien agregue
// una SEGUNDA `create table ... hotel (...)` (en 0002_org_location_hotel.sql o en una
// migración nueva) que no sea la extensión 1:1 de `location` (columna `id` que es PK y
// FK a `location(id)`), reintroduciendo el "modelo de tenencia contradictorio" que
// docs/auditoria-0/documentos.md ya encontró una vez (hotel como raíz en vez de bajo org).
//
// Uso: `node scripts/checks/schema-location.ts` -- sale con código 1 si encuentra una
// violación, imprimiendo archivo y motivo.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const MIGRATIONS_DIR = join(ROOT, "packages", "db", "migrations");

// \b antes y después de "hotel" evita falsos positivos contra hotel_staff,
// hotel_tax_config, hotel_cancellation_policy, etc. (el guion bajo es \w, así que \b no
// separa "hotel" de "_staff": el límite de palabra ya excluye esos nombres solo).
const CREATE_HOTEL_TABLE = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?hotel\s*\(([\s\S]*?)\n\s*\);/gi;

// La columna `id` de la extensión legítima debe ser PRIMARY KEY y FK a location(id) --
// el patrón exacto de packages/db/migrations/0002_org_location_hotel.sql.
const ID_REFERENCES_LOCATION =
  /^\s*id\s+\S+\s+primary\s+key\s+references\s+(?:public\.)?location\s*\(\s*id\s*\)/im;

interface Finding {
  file: string;
  reason: string;
}

function scanMigrations(): { findings: Finding[]; totalCreateHotelStatements: number } {
  const findings: Finding[] = [];
  let files: string[];
  try {
    files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  } catch (err) {
    return {
      findings: [{ file: MIGRATIONS_DIR, reason: `no se pudo leer el directorio de migraciones: ${String(err)}` }],
      totalCreateHotelStatements: 0,
    };
  }

  let totalCreateHotelStatements = 0;
  const relFiles: string[] = [];

  for (const file of files) {
    const full = join(MIGRATIONS_DIR, file);
    const contents = readFileSync(full, "utf8");
    const relFile = full.replace(ROOT + "/", "");

    let match: RegExpExecArray | null;
    CREATE_HOTEL_TABLE.lastIndex = 0;
    while ((match = CREATE_HOTEL_TABLE.exec(contents)) !== null) {
      totalCreateHotelStatements += 1;
      relFiles.push(relFile);
      const body = match[1] ?? "";
      if (!ID_REFERENCES_LOCATION.test(body)) {
        findings.push({
          file: relFile,
          reason:
            "crea `hotel` sin que la columna `id` sea `primary key references location(id)` -- " +
            "sería una tabla `hotel` paralela, no una extensión 1:1 de `location` (REQ-TEN-002).",
        });
      }
    }
  }

  if (totalCreateHotelStatements === 0) {
    findings.push({
      file: MIGRATIONS_DIR.replace(ROOT + "/", ""),
      reason: "ninguna migración crea `public.hotel` -- REQ-TEN-002 exige que exista como extensión de `location`.",
    });
  } else if (totalCreateHotelStatements > 1) {
    findings.push({
      file: relFiles.join(", "),
      reason:
        `se encontraron ${totalCreateHotelStatements} sentencias \`create table ... hotel\` -- ` +
        "una tabla `hotel` paralela (duplicada) viola REQ-TEN-002, que exige una única extensión de `location`.",
    });
  }

  return { findings, totalCreateHotelStatements };
}

const { findings } = scanMigrations();

if (findings.length > 0) {
  console.error("REQ-TEN-002: revisión estática de esquema falló:");
  for (const f of findings) {
    console.error(`  ${f.file}: ${f.reason}`);
  }
  process.exit(1);
}

console.log("REQ-TEN-002 OK: `hotel` existe una sola vez y es una extensión 1:1 de `location` (id → location(id)).");
process.exit(0);
