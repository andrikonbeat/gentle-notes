# Feature request: una sección de notas persistente junto a los Todos

## El problema (en mis palabras)

A menudo se me ocurren ideas en cadena mientras trabajo con el agente. No son tareas a las que me comprometa a hacer *ahora* (para eso están los Todos), son pensamientos que no quiero perder.

Al final termino escribiéndolos en el input del chat a modo de bloc de notas, el problema: **no todas son ideas que quiero enviar a la cola de chat**.

## Qué hace

- **Click en el campo de la sidebar, escribe, Enter** → nota guardada, campo listo para la siguiente. El texto se envuelve solo mientras escribes.
- **Cada nota tiene un botón `➤`** — lo clickeas cuando quieres mandarla al chat como prompt. Si el agente está ocupado, entra en cola como follow-up en lugar de interrumpir.
- **Las notas enviadas quedan visibles** tachadas con `✓` (misma gramática visual que los Todos done), así tienes historial de lo que ya mandaste.
- **Controles de plegar/colapsar** calcados de la card de Todos — colapsas todo el bloque, o pliegas cada nota a su primera línea para vista compacta.
- **Persiste por proyecto** (`~/.pi/gentle-ai/notes/`) — sobrevive reinicios, compartida entre sesiones.
- **Teclado ante todo** — `/note "texto"` desde el chat, `alt+n` para settings, `/notes send` con picker, `alt+pgup/pgdn` para scrollear.

## Qué cuesta upstream

Solo **un parche mínimo** (18 líneas en 3 archivos):
- Agregar `notes` a la lista de secciones del rail en `lib/shell-sidebar-layout.ts`
- Agregar `notes?: boolean` al tipo `visibility` en `lib/shell-sidebar.ts`
- Un test

Todo el resto vive en la extensión — no hace falta fork, es inofensiva sin gentle-shell.

## Por qué lo propongo en lugar de dejarlo privado

Si esto resuena con cómo trabajas tú (o como trabajan otros), tiene sentido que esté en el shell integrado nativamente. Si es muy de nicho, cero drama: la mantengo yo como extensión y listo.

El código está listo: 259 tests, typecheck limpio, paridad byte-a-byte con el render de cards del shell, CI replicando sus tres gates. Cualquier duda, la charlamos.

---

**Repo:** https://github.com/andrikonbeat/gentle-notes  
**Patch:** `proposal/rail-patch/notes-rail.patch` (se aplica con `git apply`)