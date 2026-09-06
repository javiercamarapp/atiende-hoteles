# Evidencia B-001: búsqueda ampliada de "empresas agénticas"

Búsqueda de solo lectura para localizar cualquier mención local (rutas, notas,
historial de shell, configuraciones de agentes) que revele la ubicación real
de una carpeta llamada "empresas agénticas" o variantes. Ya se había
confirmado previamente que NO existe un directorio con ese nombre bajo `~/`
(find profundidad 4/7), `~/Desktop`, `~/Documents`, `~/Documents/Codex`,
iCloud, ni vía `mdfind`. No se creó ninguna carpeta ni se leyeron
`.env`/credenciales.

Nota de entorno: macOS no tiene `timeout`/`gtimeout` instalado en esta
máquina, así que se usó una función bash equivalente (`mytimeout <segs>
<cmd...>`, kill -9 al vencer el plazo) para respetar los límites de tiempo
pedidos.

## 1. "mi memoria claude" (solo .md)

```
mytimeout 120 grep -ril --include='*.md' -i -E \
  "empresas[ -]?ag[eé]nticas|agentic companies|empresas IA ag[eé]nticas" \
  "/Users/javiercamaraportepetit/Desktop/mi memoria claude/wiki"
# (exit:1 -> sin coincidencias)

mytimeout 120 grep -ril --include='*.md' -i -E \
  "empresas[ -]?ag[eé]nticas|agentic companies|empresas IA ag[eé]nticas" \
  "/Users/javiercamaraportepetit/Desktop/mi memoria claude"
# (exit:1 -> sin coincidencias, incluye wiki/)
```
Resultado: sin coincidencias en ninguno de los dos.

## 2. wiki-sync-inbox

```
ls -la /Users/javiercamaraportepetit/Documents/Codex/wiki-sync-inbox
```
El directorio contiene 77 archivos placeholder `codex-pending-*.md` de
~32-39 bytes cada uno (colas de sincronización, sin contenido relevante).

```
mytimeout 120 grep -ril --include='*.md' --include='*.txt' --include='*.json' \
  -i -E "empresas[ -]?ag[eé]nticas|agentic companies" \
  /Users/javiercamaraportepetit/Documents/Codex/wiki-sync-inbox
# (exit:1 -> sin coincidencias)
```

## 3. Proyectos/memoria de Claude Code

```
find /Users/javiercamaraportepetit/.claude/projects -maxdepth 3 -type d
```
Solo existe un proyecto: `-Users-javiercamaraportepetit`, con subcarpeta
`memory/` **vacía** (`total 0`, solo `.` y `..`). No existen archivos
`memory/*.md`.

```
ls -la /Users/javiercamaraportepetit/.claude/CLAUDE.md
# No such file or directory

find /Users/javiercamaraportepetit/.claude/projects -maxdepth 2 -iname "CLAUDE.md"
# sin resultados
```
Resultado: no hay `CLAUDE.md` global ni por proyecto, ni memoria persistida.

## 4. Otras herramientas de IA (~/.codex, ~/.grok, ~/.gemini, ~/.antigravity, ~/.openclaw)

Todas las carpetas existen. Se buscó en `.md/.json/.toml/.txt`:

```
mytimeout 90 grep -ril --include='*.md' --include='*.json' --include='*.toml' \
  --include='*.txt' -i -E "empresas[ -]?ag[eé]nticas|agentic companies" \
  "/Users/javiercamaraportepetit/<dir>"
```
Resultado para las 5 carpetas: `(exit:1)` -> sin coincidencias en ninguna.

## 5. ~/.zsh_history

```
grep -i "empresas" ~/.zsh_history | grep -i -E "agent|agén" | tail -20
# sin salida (0 líneas)

grep -i -E "mkdir|cd " ~/.zsh_history | grep -i agent | tail -30
```
Salida relevante: solo comandos de configuración de **OpenClaw**
(`mkdir -p ~/.openclaw/agents/main/agent && ...`), un `cd
~/ruta-del-proyecto && npx @aidesigner/agent-skills init` (ruta placeholder
literal, no una ruta real) y un `cd ~/openclawsetup/dashboard`. Ninguna
línea menciona "empresas agénticas" ni una carpeta con ese nombre.

## 6. Listados de un nivel

- `~/Desktop/GitHub`: `Mirror-AI`, `repo-temp`
- `~/Desktop/INTENTO DE STARTUPS`: `ATIENDE`, `HATO AI`
- `~/Desktop/Codex`: `2026-07-29`
- `~/Desktop/Escritorio - Mac mini de Javier`: `AI TOOLS`, `SKILLS`
- `~/Documents/Documentos - Mac mini de Javier`: `New project`
- Google Drive (`~/Library/CloudStorage/GoogleDrive-javiercamaraportepetit@gmail.com/Mi unidad`):
  listado completo de un nivel obtenido (todos los `ls` completaron en <60 s,
  ninguno se abandonó); contiene ~180 archivos/carpetas de proyectos varios
  (ATIENDE.AI, LOOPZY, MONI AI, LIKIDA, HatoAI, VEIKUL, etc.) pero ninguna
  entrada llamada "empresas agénticas" ni variante reconocible.

Ninguno de estos listados contiene una carpeta con el nombre buscado o
variante.

## Conclusión

No se encontró ninguna mención local (en notas, historial de shell,
memoria de Claude Code, configuraciones de otras herramientas de IA, ni
listados de directorios de un nivel) que indique la ruta real de una
carpeta "empresas agénticas". Combinado con las búsquedas previas
(find/mdfind bajo `~`, Desktop, Documents, Codex, iCloud), la conclusión es:
**no hay mención local localizable de esa carpeta con las herramientas y el
alcance disponibles en esta búsqueda.**
