# Claude Subagents Viewer

Extensión de VS Code para **ver en vivo los subagentes que despliega Claude Code**: cuáles están corriendo, qué herramienta están ejecutando en este momento, cuánto llevan, y qué informe entregaron al terminar.

No necesita ninguna API ni configuración de Claude Code: lee directamente los transcripts que Claude Code ya escribe en disco.

## Qué muestra

Las tres vistas comparten un mismo sistema de diseño (`src/ui.ts`): paleta de estados validada en tema claro y oscuro, iconos por categoría de herramienta, colores por tipo de subagente y tooltips explicativos en cada elemento. El estado nunca depende solo del color: siempre lleva icono, etiqueta y una frase que explica qué significa.

### Panel lateral (icono de robot en la barra de actividad)

Es un webview propio, no un árbol nativo, así que cada subagente es una **tarjeta** con color de estado:

- **Cabecera viva**: «2 subagentes activos ahora · en 1 sesión · último cambio hace 3 s», y cuatro contadores (activos, listos, detenidos, cancelados) que funcionan como **filtros de un clic**. Debajo, buscador (nombre, tipo, herramienta, fase, modelo) y selector de ámbito («Solo este proyecto» / «Todos los proyectos») con el número de sesiones de cada uno. Cuando hay un filtro activo se muestra «Mostrando 3 de 25 · estado ejecutando · quitar».
- **Sesiones**: carpeta de trabajo, pastilla «abierta» (hay un proceso de Claude Code vivo) o «cerrada», desde dónde se lanzó (VS Code / terminal), número de subagentes y workflows, herramientas con error, última actividad y una barra apilada con la proporción de estados. Colapsables; con acciones «gráfico» (dashboard filtrado por esa sesión) y «carpeta».
- **Workflows**: agrupan a sus agentes con el nombre del script, barra «5 de 10 completados», chips de fase con el número de agentes en cada una (la fase en curso resaltada) y estado global.
- **Tarjeta de subagente**: icono de estado (anillo girando si ejecuta), nombre (con sufijo `#id` cuando varios comparten prompt), tiempo transcurrido **en vivo**, badges de tipo, fase, modelo («Opus 5») y anidamiento; y según el estado:
  - **Ejecutando** → línea «AHORA» con icono y nombre de la herramienta, su resumen (el comando, el archivo…) y cuánto lleva en esa llamada; si supera 60 s aparece un aviso «puede ser un comando largo o un proceso colgado».
  - **Completado** → extracto del informe final.
  - **Detenido** → «Sin actividad desde hace 6 m; no cerró su turno» (el tooltip explica las causas habituales).
  - **Cancelado** → «Detenido por el usuario tras 3 m y 12 herramientas».
  - Pie con herramientas, errores (en rojo), tokens y la **tira de actividad** (una celda por llamada, coloreada por duración; rojo = error; punteada = en curso).
  - Al **expandir** (›): tarea recibida, herramientas usadas con recuento, los últimos 8 pasos con icono, duración y error, y botones «Ver detalle», «Transcript», «Informe», «Prompt».
- **Estado vacío** que explica qué hace falta para que aparezca algo y, si hay sesiones ocultas por el ámbito, un botón para verlas.
- **Pie** con leyenda desplegable (estados, tira de actividad, iconos de herramienta, umbral) y «actualizado hace N s».

Los tiempos avanzan cada segundo en el propio panel; los datos se refrescan al cambiar los transcripts.

### Panel gráfico (botón 📊 en la cabecera del panel, o clic en la barra de estado)

- **Barra de filtros** pegajosa: sesión, estado (Todos / Ejecutando / Completados / Con problemas), búsqueda y vista tarjetas/tabla.
- **KPIs** con cifra grande y sublabel que explica qué cuenta cada uno; los de estado actúan como filtro.
- **Gantt de actividad** de una sesión (con línea de «ahora» y tooltip por barra).
- **Tarjetas** con la misma anatomía que el panel lateral, **herramientas más usadas** coloreadas por categoría, reparto **por categoría** y **tabla** con todos los valores en texto.

### Panel de detalle

Clic en cualquier subagente: cabecera fija con badges, estado y su explicación, botones (transcript, copiar prompt, copiar informe, revelar carpeta), barra «AHORA» con tiempo en vivo, tarjetas de estadísticas (duración, herramientas y errores, mensajes, tokens con barra entrada/salida/caché, última actividad), tira de actividad, chips de herramientas usadas, informe final e **línea de tiempo** numerada (#1, #2…) con filtros (Todo / Herramientas / Errores / Razonamiento / Respuestas) y búsqueda; cada evento despliega su entrada y su resultado.

### Barra de estado

`⟳ 3 subagentes` cuando hay actividad; `🤖 N` cuando no. Clic para abrir el panel gráfico.

## Instalación

```bash
cd D:\ANTHROPIC\claude-subagents-viewer
npm install
npm run compile
npm run package          # genera claude-subagents-viewer-0.2.0.vsix
code --install-extension claude-subagents-viewer-0.2.0.vsix --force
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
| `cancelado` | el `.meta.json` lleva `stoppedByUser: true` y el turno no se cerró: el usuario lo paró (Esc / stop) |

El umbral es configurable (`claudeSubagents.runningThresholdSeconds`).

## Rendimiento

Los transcripts pesan cientos de MB en total, así que **no se releen enteros**: la primera pasada indexa cada archivo y las siguientes solo parsean los bytes añadidos desde la última lectura, apoyándose en `mtime`/`size` para saltarse por completo los que no cambiaron. En un `~/.claude` con más de 600 subagentes en 25 sesiones: **1,6 s** la primera pasada y **~35 ms** cada refresco posterior.

El refresco se dispara por dos vías: un `fs.watch` recursivo sobre `~/.claude/projects` (filtrado a rutas `subagents/`) y un temporizador de respaldo cada 2 s.

## Ajustes

| Ajuste | Por defecto | Qué hace |
|---|---|---|
| `claudeSubagents.onlyCurrentWorkspace` | `true` | Solo sesiones cuyo `cwd` está dentro del workspace abierto (también se cambia desde el selector de ámbito del panel) |
| `claudeSubagents.refreshIntervalMs` | `2000` | Intervalo del temporizador de respaldo |
| `claudeSubagents.runningThresholdSeconds` | `90` | Antigüedad máxima para considerar un agente vivo |
| `claudeSubagents.maxSessions` | `25` | Sesiones recientes a inspeccionar |
| `claudeSubagents.sessionMaxAgeDays` | `14` | Ignorar sesiones más antiguas |
| `claudeSubagents.maxEvents` | `500` | Eventos conservados en memoria por subagente |
| `claudeSubagents.showThinking` | `true` | Mostrar bloques de razonamiento |
| `claudeSubagents.notifyOnFinish` | `false` | Notificar cuando un subagente termina |
| `claudeSubagents.claudeHome` | `""` | Ruta alternativa a `~/.claude` |

Los botones de la cabecera del panel abren el dashboard, refrescan y abren los ajustes. Los filtros de estado y el ámbito se manejan dentro del propio panel.

## Limitaciones conocidas

- Un subagente que muere sin escribir su turno final aparece como `detenido`, no como fallido: el transcript no distingue entre «cancelado» y «cayó por error».
- El journal del workflow (etiquetas y fases) se escribe cuando el workflow avanza, no en tiempo real por agente. Mientras corre, los agentes sin etiqueta muestran la primera línea útil de su prompt; si varios comparten el mismo prompt base, se les añade un `#id` corto para distinguirlos.
- Solo lee lo que hay en disco: no se conecta al proceso de Claude Code, así que no puede cancelar ni relanzar agentes.
# CLAUDE-SUBAGENTS-VIEWER
# CLAUDE-SUBAGENTS-VIEWER
# CLAUDE-SUBAGENTS-VIEWER
