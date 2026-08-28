# Claude Subagents Viewer

Extensión de VS Code para **ver en vivo los subagentes que despliega Claude Code**: cuáles están corriendo, qué herramienta están ejecutando en este momento, cuánto llevan, y qué informe entregaron al terminar.

No necesita ninguna API ni configuración de Claude Code: lee directamente los transcripts que Claude Code ya escribe en disco.

## Qué muestra

### Panel gráfico (botón 📊 en la cabecera del panel, o clic en la barra de estado)

Un dashboard que se refresca solo mientras los subagentes trabajan:

- **Fila de KPIs** con la cifra grande de subagentes ejecutando ahora, más completados, detenidos, herramientas y tokens.
- **Gantt de actividad**: una barra por subagente sobre un eje de tiempo real, coloreada por estado, con una línea vertical marcando *ahora*. Se dibuja una sesión a la vez (sesiones distintas están separadas por horas o días y compartir eje aplastaría todas las barras).
- **Tarjetas** por subagente: borde de color según estado, insignias de tipo y fase, la herramienta que ejecuta en este momento, y una **tira de actividad** donde cada celda es una llamada a herramienta coloreada por cuánto tardó (rampa azul rápida → lenta, roja si falló). Se ve de un vistazo dónde se atasca cada agente.
- **Barras de herramientas más usadas** en toda la flota.
- **Filtros** de sesión y "solo activos", más una **vista de tabla** con todos los valores en texto.

Todo se pinta con una paleta validada con el validador de la guía de visualización (separación CVD y contraste comprobados en tema claro y oscuro). El estado nunca depende solo del color: cada uno lleva glifo (▶ ✓ ⏸) y etiqueta, y la tabla repite todos los valores.

### Panel lateral (icono de robot en la barra de actividad)

```
● bot                    ▶2   2 activos · 13 subagentes · hace 1m
  ⛓ inbox-whatsapp-like-panels    ▶1   10 agentes · 18m
      ⟳ recon:scroll-live    ▶   ejecutando · ▶ Bash: npm run typecheck · 4m · 44 herr.
          Bash               npm run typecheck
          Read               app/inbox/page.tsx
          razonando          El scroll se rompe cuando el contenedor…
      ✓ recon:code-map       ✓   Reconocimiento · completado · 9m 33s · 40 herr.
```

Etiquetas coloreadas e insignias de estado (▶ ✓ ⏸) sobre cada subagente, y un contador azul de agentes activos sobre cada sesión y workflow.

- **Sesión** → carpeta de trabajo, si el proceso de Claude Code sigue vivo, cuántos subagentes tiene.
- **Workflow** (`⛓`) → agrupa los agentes lanzados por un mismo workflow, con sus fases.
- **Subagente** → tipo, fase, estado, duración, herramientas y, si está corriendo, **la herramienta que ejecuta ahora**.
- **Actividad** → los últimos eventos del subagente.

### Panel de detalle

Clic en cualquier subagente (en el árbol o en una tarjeta): prompt recibido, línea de tiempo completa con entrada y resultado de cada herramienta, uso de tokens, e informe final. Se actualiza solo mientras el subagente trabaja.

### Barra de estado

`⟳ 3 subagentes` cuando hay actividad. Clic para abrir el panel gráfico.

## Instalación

```bash
cd D:\ANTHROPIC\claude-subagents-viewer
npm install
npm run compile
npm run package          # genera claude-subagents-viewer-0.1.0.vsix
code --install-extension claude-subagents-viewer-0.1.0.vsix
```

Para desarrollar: abre la carpeta en VS Code y pulsa `F5` (Ejecutar extensión).

## De dónde saca los datos

Claude Code escribe cada subagente como un JSONL independiente:

```
~/.claude/
├── sessions/<pid>.json                                 # sesiones vivas (pid, cwd, busy/idle)
└── projects/<proyecto>/
    ├── <sessionId>.jsonl                               # conversación principal
    └── <sessionId>/
        ├── subagents/
        │   ├── agent-<id>.jsonl                        # transcript del subagente
        │   ├── agent-<id>.meta.json                    # { agentType, description, toolUseId }
        │   └── workflows/wf_<id>/agent-<id>.jsonl      # agentes de un workflow
        └── workflows/wf_<id>.json                      # journal: label, fase, estado, tokens
```

La extensión combina las tres fuentes: el `.meta.json` da el tipo y la descripción, el journal del workflow da la etiqueta y la fase, y el JSONL da la actividad real.

**Cómo decide el estado:**

| Estado | Criterio |
|---|---|
| `ejecutando` | el último turno no cerró y el archivo se escribió hace menos de 90 s |
| `completado` | el último turno es texto con `stop_reason: end_turn`, o el journal lo marca `done` |
| `detenido` | quedó a medias y lleva más de 90 s sin escribir (workflow cancelado, sesión cerrada) |

El umbral es configurable (`claudeSubagents.runningThresholdSeconds`).

## Rendimiento

Los transcripts pesan cientos de MB en total, así que **no se releen enteros**: la primera pasada indexa cada archivo y las siguientes solo parsean los bytes añadidos desde la última lectura, apoyándose en `mtime`/`size` para saltarse por completo los que no cambiaron. En un `~/.claude` con más de 600 subagentes en 25 sesiones: **1,6 s** la primera pasada y **~35 ms** cada refresco posterior.

El refresco se dispara por dos vías: un `fs.watch` recursivo sobre `~/.claude/projects` (filtrado a rutas `subagents/`) y un temporizador de respaldo cada 2 s.

## Ajustes

| Ajuste | Por defecto | Qué hace |
|---|---|---|
| `claudeSubagents.onlyCurrentWorkspace` | `true` | Solo sesiones cuyo `cwd` está dentro del workspace abierto |
| `claudeSubagents.onlyActive` | `false` | Solo subagentes en ejecución |
| `claudeSubagents.refreshIntervalMs` | `2000` | Intervalo del temporizador de respaldo |
| `claudeSubagents.runningThresholdSeconds` | `90` | Antigüedad máxima para considerar un agente vivo |
| `claudeSubagents.maxSessions` | `25` | Sesiones recientes a inspeccionar |
| `claudeSubagents.sessionMaxAgeDays` | `14` | Ignorar sesiones más antiguas |
| `claudeSubagents.treeActivityItems` | `12` | Eventos recientes bajo cada subagente (`0` los oculta) |
| `claudeSubagents.maxEvents` | `500` | Eventos conservados en memoria por subagente |
| `claudeSubagents.showThinking` | `true` | Mostrar bloques de razonamiento |
| `claudeSubagents.notifyOnFinish` | `false` | Notificar cuando un subagente termina |
| `claudeSubagents.claudeHome` | `""` | Ruta alternativa a `~/.claude` |

Los botones de la cabecera del panel abren el dashboard y alternan los filtros «solo activos» y «solo este workspace».

## Limitaciones conocidas

- Un subagente que muere sin escribir su turno final aparece como `detenido`, no como fallido: el transcript no distingue entre «cancelado» y «cayó por error».
- El journal del workflow (etiquetas y fases) se escribe cuando el workflow avanza, no en tiempo real por agente. Mientras corre, los agentes sin etiqueta muestran la primera línea útil de su prompt; si varios comparten el mismo prompt base, se les añade un `#id` corto para distinguirlos.
- Solo lee lo que hay en disco: no se conecta al proceso de Claude Code, así que no puede cancelar ni relanzar agentes.
# CLAUDE-SUBAGENTS-VIEWER
