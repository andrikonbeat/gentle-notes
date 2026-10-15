# Gentle Notes — libreta de tareas con envío al chat (sidebar de gentle-shell)

Extensión de Pi/gentle-shell: libreta persistente de tareas pendientes en el rail derecho, con ícono de envío por nota (`sendUserMessage`) y estado "enviada" tachado con la misma gramática visual del TODO done. En modo regular: fila compacta arriba del editor + diálogo de gestión.

## Specs

- **S1 — Sidebar derecha (rail):** "en la sidebar lateral derecha tener una libreta de notas". La libreta pinta como sección `notes` del rail de gentle-shell (fullscreen ≥140 cols), registrada por esta extensión vía `sidebarPart(tui, "notes", bottom, rail)`; requiere el parche upstream que agrega `notes` a la lista de secciones de `lib/shell-sidebar-layout.ts` (hoy `["footer","agents","todo"]`).
- **S2 — Backlog persistente:** "quiero poder tener un espacio donde anotar cosas y tareas que quiero que la IA vaya haciendo después pero las tengo en la cabeza y si no las anoto se me olvida". Las notas sobreviven sesiones y recargas: JSON por proyecto bajo el config home de gentle-shell (`~/.pi/gentle-ai/notes/<slug>--<hash8>.json`, respetando `GENTLE_PI_CONFIG_HOME`), escritura atómica (tmp+rename) y cola de mutación por archivo. Archivo malformado o faltante degrada a estado vacío, nunca lanza.
- **S3 — Ingreso y guardado:** "quiero tener un espacio para ingresar este texto guardarlo como una tarea". Entrada por diálogo (atajo `alt+n`, comando `/notes`): input de una línea, trim, texto vacío rechazado; guarda como tarea `pending` con id incremental e instante de creación.
- **S4 — Ícono de enviar como prompt:** "al lado de el texto de la tarea un icono de enviar para cuando yo quiera enviar esa tarea como un prompt al chat". En el rail, ícono hover+clic por fila que llama `pi.sendUserMessage(texto)`; si el agente está ocupado, `deliverAs: "followUp"` (encola como próximo prompt sin interrumpir el turno). Camino de teclado equivalente: `/notes send` abre selector de pendientes.
- **S5 — Estado "enviada" tachado:** "para que me salgan las tareas que ya envié tachadas como que fueron enviadas y un icono que lo indique". Enviadas: `theme.strikethrough()` envolviendo antes de estilar (SGR 9 por línea física), glyph `✓` en success + texto dim — misma gramática del TODO done. Pendientes con glyph propio (`✉`). Listas largas pliegan `✓ N sent` (estilo `bodyRows` del TODO, cap 12 filas).
- **S6 — Modo regular (decisión L3, elegida "Widget compacto + diálogo"):** widget compacto de una fila arriba del editor conviviendo con el TODO (sin toggle modal), con summary `✉ N pend · M sent — última: "…"`; gestión completa por diálogo (camino de teclado obligatorio: en modo regular el terminal es dueño del mouse); visibilidad `notes` configurable como `visibility.todo`.
- **S7 — Upstream (decisión L3, elegida "Clonalo dentro del proyecto"):** clon fresh de `Gentleman-Programming/gentle-shell` dentro del proyecto (`upstream/gentle-shell`, gitignored) sobre el que se prepara el parche del rail en una rama.

## Tasks

- **T1** · S1,S7 · inline · Clon upstream shallow + parche del rail: sección `notes` en `lib/shell-sidebar-layout.ts` (+ condición `visibility.notes` y tipo en `shell-sidebar.ts`) en rama `notes-rail-section` del clon, con test nuevo. — commit: `upstream/gentle-shell@b2d428b` (47/47 tests del layout)
- **T2** · S2,S3 · inline · Scaffold repo + módulos puros `notes-state`/`storage` con RED→GREEN (`node --test`, TS nativo). — commit: `7f40342`
- **T3** · S4,S5 · inline · Render puro de la card (`notes-card`): glyphs, tachado, pliegue, summary + tests. — commit: `2b43376`
- **T4** · S3,S4 · inline · Extensión activa: comandos `/notes`, atajo `alt+n`, diálogo add/send/list/clear, `sendUserMessage` con `followUp` si busy, evento snapshot + `sidebarPart("notes")`. — commit: (pendiente)
- **T5** · S6 · inline · Widget compacto `aboveEditor` para modo regular. — commit: (pendiente)
- **T6** · S1-S6 · inline · README, verificación integrada (carga con `pi --extension`), cierre. — commit: (pendiente)

## Log

- **L1**: "Quiero evaluar la posibilidad de hacer una extensión de gentle-shell, gentle pi. Que me permita en la sidebar lateral derecha tener una libreta de notas, quiero poder tener un espacio donde anotar cosas y tareas que quiero que la IA vaya haciendo después pero las tengo en la cabeza y si no las anoto se me olvida, y quiero tener un espacio para ingresar este texto guardarlo como una tarea y al lado de el texto de la tarea un icono de enviar para cuando yo quiera enviar esa tarea como un prompt al chat y un indicador de estado como se maneja en los TODOS para que me salgan las tareas que ya envié tachadas como que fueron enviadas y un icono que lo indique."
- **L2**: "puedes usar https://github.com/Gentleman-Programming/gentle-shell https://github.com/Gentleman-Programming/gentle-ai como referencia."
- **L3**: "Si la opcion A es la mejor arrancamos. pero primero explicame como resuelves el problema cuando esta en modo regular una boton que intercambia entre el todos normal y las notas o que ?" → Decisión: Opción A (parche upstream mínimo + extensión separada). Modo regular elegido por el usuario: **widget compacto + diálogo** (sin toggle). Upstream elegido: **clon fresh dentro del proyecto**. Referencias de arquitectura: `lib/shell-sidebar-layout.ts` (secciones), `extensions/gentle-todo.ts` (patrón bottom/rail y widget), `lib/jobs-sidebar-state.ts` (evento snapshot tipado), `lib/shell-todo.ts` (tachado/pliegue/estados), `lib/shell-hover.ts` (hover).
