# Feature request: una sección de notas persistente junto a los Todos

Este es un borrador para `.github/ISSUE_TEMPLATE/feature_request.yml` en
`Gentleman-Programming/gentle-shell`, sección por sección y en el mismo orden.
No es un PR: según `skills/branch-pr`, un PR solo existe sobre un issue aprobado
(`status:approved`).

---

## Antes de enviar

- [x] Busqué en issues abiertos y cerrados y no encontré una solicitud para esta
      funcionalidad.
- [x] Revisé la solicitud y eliminé credenciales, tokens, rutas privadas,
      nombres de host y otros datos sensibles. Verificado: un grep en todos los
      archivos versionados no devuelve coincidencias. Una salvedad: el historial
      de git lleva el email del autor de los commits, como en cualquier repositorio público.

---

## Problema u oportunidad

A menudo surgen ideas en cadena mientras se trabaja con el agente — cosas como
"preguntar por el orden de la migración", "el test inestable probablemente sea
el fixture", "recordar revisar las release notes". No son tareas a las que uno
se comprometa a hacer ahora (para eso están los Todos), son pensamientos que no
se quiere perder.

Hoy se termina escribiéndolos en el input del chat a modo de bloc de notas, lo
que genera dos problemas:
1. Se ensucia el input que realmente se usa para prompts
2. Si se envía uno sin querer, se interrumpe al agente a mitad de edición

Desarrollé una extensión pequeña que añade una **sección Notes en el rail de la
sidebar** (justo debajo de Todos) y una fila compacta sobre el editor en modo
regular. La uso a diario y resuelve exactamente esa fricción.

## Resultado propuesto

Una sección `notes` en el rail a pantalla completa, debajo de los Todos, que
funciona como superficie de captura y envío diferido con la misma gramática
visual que ya usa el rail:

- **Captura sin salir del teclado.** Un campo vive dentro de la card. Click en
  él (o usa el comando), escribe, pulsa Enter. El texto se envuelve en párrafo
  mientras se escribe y hace scroll para mantener el cursor visible.
- **Diferir y luego enviar.** Cada nota pendiente lleva un botón `➤`. Al
  hacer click, envía esa nota al chat como prompt — o, según un ajuste del
  plugin, la inserta en el input del chat en la posición del cursor para
  editarla antes. Si el agente está ocupado, la nota entra en cola como
  follow-up en lugar de interrumpir el turno.
- **Las notas enviadas permanecen y se explican solas.** Una nota enviada
  aparece tachada con `✓`, exactamente como un Todo completado. Su cabecera de
  sección (`N enviadas`) pliega la sección y lleva un botón `Delete All` que la
  vacía de una vez. Cada fila enviada puede restaurarse a pendiente (`↶`) —
  como borrador si nunca viajó (`✓`), de modo que restaurar nunca reenvía nada
  a escondidas — o eliminarse (`×`).
- **Vistas progresivas, misma gramática que los Todos.** Dos controles
  independientes en la cabecera de la card: uno colapsa todo el bloque a una
  sola fila, el otro pliega cada nota a su primera línea para una vista
  compacta tipo Todos. Cada nota también puede plegarse individualmente con
  doble click.
- **Degrada a una línea.** Por debajo del breakpoint de pantalla completa, la
  sección se convierte en una fila estilo card sobre el editor — control,
  contadores y las primeras palabras de la última nota — que se expande en una
  lista acotada con scroll de rueda.
- **Un almacén por proyecto, compartido en vivo.**
  `~/.pi/gentle-ai/notes/<slug>--<hash8>.json`, escrituras atómicas y un watcher
  para que dos sesiones en el mismo proyecto vean las mismas notas mientras
  ambas están abiertas. El estado de vista (colapsado, plegado, sección de
  enviadas colapsada) viaja en el mismo archivo, así que un reinicio parece que
  la sesión no terminó.
- **Ruta de teclado para cada gesto que la tenga.** `/notes` (diálogo gestor),
  `/note <texto>` (captura directa desde el chat), `alt+n` (gestor), y los
  subcomandos `/notes add|send|list|show|restore|clear|delete|collapse|expand|fold|unfold|settings`.
  La edición inline de texto es la única excepción hoy: es solo por click, y
  quien use teclado cambia una nota borrándola y volviéndola a añadir.

## Alternativas consideradas

- **Extender `Todos` con una marca "no es tarea".** Descartada: sobrecarga el
  significado de una tarea y la gramática de fila que los Todos ya fijan, y
  las dos listas tienen ciclos de vida distintos (una tarea se termina; una
  nota se envía o se borra).
- **Extensión Pi standalone, sin sección en el rail.** Así está construida hoy
  y funciona, pero es el producto más débil: sin el rail la superficie es una
  fila compacta y un diálogo, y los dos paneles no comparten chrome.
- **Enviar cada nota como prompt de inmediato.** Elimina la fricción que hace
  valiosa la funcionalidad: una interrupción no es una nota.
- **Guardar notas en el transcript de la sesión.** Las notas deben sobrevivir a
  las sesiones; el transcript no.
- **Usar el input del chat como área de retención.** Es lo que pasa hoy, y
  choca con lo que el usuario ya estaba escribiendo.

## Contexto adicional

### Qué existe ya y qué cuesta upstream

La implementación está completa y probada en un repositorio aparte
(`gentle-notes`: 8 módulos fuente, 259 tests, `npm run check` en verde). Llega
al rail a través del mismo interop `Symbol.for` que usan las demás secciones
(`sidebarPart(tui, "notes", bottom, rail)`), así que **no requiere fork de
gentle-shell**: es inofensiva si gentle-shell no está presente.

Solo se necesita un parche aditivo para que la card aparezca en la lista de
secciones del rail — `notes` en el array de secciones de
`lib/shell-sidebar-layout.ts`, más la condición `visibility.notes` y su tipo.
Todo lo demás es client-side.

Deuda conocida, declarada y no descubierta después: el chrome de la card
(`src/card-chrome.ts`) y el hit-testing de puntero que lee columnas de glifos
desde las filas renderizadas son una **réplica local** del sistema de cards del
shell, porque gentle-shell no expone módulo importable para ninguno — su
renderer y su `NativePointerRegion` viven dentro del paquete, y una extensión
solo puede alcanzar el estado compartido `Symbol.for`. La réplica está fijada
byte a byte contra la salida upstream mediante fixtures dorados, y su cabecera
nombra el archivo, commit y blob upstream que replica. Una vez que la sección
`notes` llegue upstream y la card se escriba junto a `lib/shell-card.ts`, la
réplica deja de ser necesaria: mismo módulo, imports directos,
`NativePointerRegion` para el hit-testing. Es consecuencia de mover el código,
no trabajo que esta solicitud prometa — como extensión no tiene ni el módulo
ni la región de puntero para importar.

Tres miembros que usa son internos del host, y se alcanzan mediante guards en
runtime en lugar de asumirlos:

- `terminal.inputHandler`, envuelto para liberar foco al hacer click fuera de
  la card (el TUI despacha el press de forma síncrona, así que no hace falta
  timer);
- `getFocusedComponent()`, para devolver el teclado al chat;
- `ui.pasteToEditor`, cuando el destino de envío es el input del chat. Es
  opcional por diseño: cuando el miembro falta o la ejecución es headless, la
  nota va al chat.

Dos hallazgos al añadir typecheck, que pueden ser relevantes para este
repositorio independientemente de esta solicitud:

1. `@earendil-works/pi-tui` exporta `EditorTheme`, `MarkdownTheme`,
   `SelectListTheme`, … pero **ningún** tipo `Theme` general.
2. `@earendil-works/pi-coding-agent` (1.3.0) declara
   `"types": "./dist/index.d.ts"` en su manifiesto y publica solo
   `dist/index.d.ts.map`.

Ambos imports son type-only en una extensión normal, así que se borran en
runtime y nada falla — que es exactamente por qué nada se verifica. La
extensión nombra la forma que necesita en un módulo local y typecheckea contra
ella.

### Cómo se validó

- Suite determinista: `npm run check` → `tsc --noEmit` limpio (73 errores
  encontrados y corregidos al añadir el compilador) y **259 tests / 40 suites**
  en verde. Fixtures dorados fijan la card byte a byte contra el render de cards
  del shell; un test de ancho decreciente fija el contrato "cada línea cabe" del
  rail, cuya violación desactiva silenciosamente todo el layout del rail.
- Terminal real, no solo unit tests: repros pty a 180, 120 y 80 columnas (rail
  visible con su indicador de scroll; fila compacta visible y rail suprimido
  por debajo del breakpoint), y click en el glifo de envío verificado contra el
  almacén en disco.
- Reglas de almacenamiento bajo test: permisos solo propietario (`0700`/`0600`,
  la misma pareja que `lib/agents-runner.ts`), un almacén ilegible movido a
  `*.corrupt-<timestamp>` en lugar de sobrescribirse, un suscriptor de watcher
  roto aislado de los demás, y texto de nota limpiado de controles C0/C1 y
  overrides bidi antes de guardarse (zero-width joiners se conservan, porque
  emoji y escrituras complejas los necesitan).

### Trabajo relacionado en este tracker (buscado 2026-10-24; ninguno duplica esta solicitud)

- #2302 propone una API documentada de registro de paneles de rail para
  extensiones, motivada exactamente por el puente de símbolo privado que esta
  extensión usa hoy. Esa solicitud define el mecanismo; esta es un consumidor
  concreto para él.
- PR #1939 (cadena Project Map) añade contribuciones de sidebar y composición
  de layout upstream, y #1063 propone convenciones de colocación sobre el mismo
  objeto de estado. La sección que solicita esto es la pieza que falta para
  apilarse sobre ellos.

### Preguntas abiertas para el mantenedor

- **Forma.** Esto vive en 8 módulos pequeños; `gentle-todo.ts` es un solo
  archivo de 18K. ¿Unificar en uno o aceptar directorio?
- **Propiedad.** ¿Deberían la card y el almacén vivir en gentle-shell (junto a
  los Todos), o mantenerse como extensión independiente que solo pide la sección
  del rail?
- **`ui.pasteToEditor`.** Si hay una API de "poner esto en el compositor"
  planeada, esto es un consumidor para ella; si no, el fallback actual (enviar
  al chat) es aceptable pero un ajuste que degrada en silencio es peor que uno
  que lo dice explícitamente.