# Crystal Shell — Guía para Claude Code

Contexto: shell/escritorio para Arch + Hyprland. Stack: **AGS-v3 + GTK4 + gtk4-layer-shell + libadwaita + TypeScript/JSX + SCSS**. Pintado custom con **Cairo** donde hace falta (dock squircles, workspace dots, resource circles, schematic).

## Filosofía de UI — "Crystal literal"

Vocabulario visual: **cápsulas de cristal** con blur pesado (40px) + borde interior 1px blanco + sombra externa suave + sheen superior. Acento color **solo para estado activo/selección**. Radios capsule-first (pill 9999, lg 24, md 16, sm 10, xs 6). Squircle 28% exclusivo para plates de app icons.

Tokens canónicos en `ui/ags-v3/styles/_base.scss`. Nunca inventar hex — usar `--crystal-accent`, `--crystal-text*`, `--crystal-surface*`, `--crystal-border`, `--crystal-radius-*`, `--crystal-shadow-*`. Los valores dark/light los inyecta `FluidCrystal.ts` → `generateTokensCss` en runtime.

## Regla clave: Adwaita vs GTK4 puro

**No es "uno u otro". Es qué usas de cada uno.**

| Superficie | Qué usar | Por qué |
|---|---|---|
| Dock, Bar, workspace dots, resource circles, schematic | **GTK4 puro + Cairo (`Gtk.DrawingArea` / `Gtk.Snapshot`)** | Adwaita no aporta nada aquí. Pintar directo = cero CSS defensivo. |
| Overlays flotantes (CC, NotifCenter, Spotlight, SystemMenu, WorkspaceOverview) | **`Gtk.Box` + gtk4-layer-shell + CSS custom** | Adwaita solo añade chrome que luego hay que anular. |
| Toggles/sliders/switches dentro de overlays | **`Gtk.Switch`, `Gtk.Scale`, `Gtk.Button` (NO `Adw.SwitchRow`, NO `Adw.ActionRow`)** | Los widgets base son estilables limpios. Los Adw.*Row traen padding/focus-ring/separators que hay que matar uno por uno. |
| Settings window | **`Adw.PreferencesWindow` + `Adw.PreferencesGroup` + `Adw.ActionRow`** con tema override | Aquí Adwaita ahorra ~2.000 líneas (a11y, kbd nav, búsqueda, split-view responsive). Compensa. |
| Diálogos modales | **`Adw.AlertDialog`** | Buena estructura, fácil de temar. |

Regla aplicable: **Adwaita solo donde ahorra arquitectura. Todo lo demás, GTK4 puro.**

## Guía para SCSS

Síntomas a evitar (hoy presentes en el repo en cierto grado):

1. **Evitar `background: none; border: none; box-shadow: none` sobre nodos internos** (`decoration`, `contents`, `ripple`, `focus-ring`, `outline`, viewport, list). Si necesitas ≥3 de estos resets, probablemente el widget es Adwaita y debería ser GTK base.
2. **Evitar cadenas de especificidad tipo** `window.crystal-settings-window preferencespage preferencesgroup list.boxed-list row`. Añadir `add_css_class("crystal-foo")` desde el TSX y estilar `.crystal-foo` plano.
3. **Evitar literales de color** (`#ff3b30`, `rgba(255,255,255,0.1)`, `#30d158`). Todo debe resolverse contra tokens:
   - Añadir `--crystal-danger`, `--crystal-success`, `--crystal-warning` a `_base.scss`.
   - `FluidCrystal.ts` los adapta a modo claro/oscuro.
4. **Mixin `@mixin glass($level)`** a crear en `_base.scss` — encapsula fondo translúcido + blur + borde + sheen + sombra para los 3 niveles (surface/raised/floating). Sustituye a los ~20 bloques repetidos.
5. **Mixin `@mixin crystal-reset`** — los resets anti-Adwaita que repetimos hoy. Una sola fuente de verdad.
6. **`background-clip: padding-box` + `border: Npx solid transparent`** — ya lo usas en sliders. Extenderlo a cualquier caso de "grosor visual ≠ grosor real". Evita negative margins que rompen `GtkGizmo`.
7. **Sin `transform` en widgets interactivos**. GTK lo respeta pero rompe hit-testing. Para hover/press, usar `margin` o escalar en Cairo.

## Cairo vs CSS — división de trabajo

- **CSS**: cualquier cosa con estados (hover, active, focus, drag).
- **Cairo**: formas complejas estáticas (squircles, dots con halo, ring charts de recursos).
- **Cuidado con el solapamiento**: si Cairo pinta el fondo de un nodo, que el CSS no declare `background-color`. Hoy `.cd-squircle-plate` tiene `background-color: white` redundante.

## Blur real = compositor, no widget

GTK no tiene `backdrop-filter` de verdad. El blur pesado del dock/bar/overlays debe venir de **Hyprland**:

```
layerrule = blur, crystal-dock
layerrule = blur, crystal-bar
layerrule = blur, crystal-control-center
layerrule = ignorezero, crystal-dock
```

El CSS solo pone fondo translúcido + sheen + borde. El `backdrop-filter: blur()` en SCSS es para preview web y se ignora en AGS.

## Acento — paleta oficial

Los 9 colores viven en `_settings.scss` bajo `button.accent-circle-btn`:

| Nombre | Hex |
|---|---|
| blue | `#0088FF` |
| teal | `#2190A4` |
| green | `#79B757` |
| yellow | `#F3BA4B` |
| orange | `#E9873A` |
| red | `#ED5F5D` |
| pink | `#E55E9C` |
| purple | `#9A57A3` |
| slate | `#6F8396` |

Cuando cambia, `FluidCrystal.ts` reescribe `--crystal-accent`, `--crystal-accent-rgb`, `--crystal-accent-10/30/60` en tiempo real.

## Referencias del design system

En el bundle adjunto tienes:
- `Crystal Shell.html` — prototipo navegable de todas las pantallas (dock, bar, CC, NotifCenter, Spotlight, WorkspaceOverview, Settings, Lock, Login, Dialog, SystemMenu).
- `styles/tokens.css` — los `--crystal-*` exactos que deben vivir en `_base.scss`.
- `styles/components.css` — geometría/estados de botones, inputs, toggles, sliders, segmented, boxed-list, menu, tooltip. Equivalencia SCSS directa.
- `styles/shell.css` — layout de dock, topbar, overlays, windows.
- `components/*.jsx` — React de referencia **solo para comportamiento e interacción**. La implementación real es TSX con AGS.

## Tareas típicas que vendrán

Cuando el usuario pida implementar una pantalla del prototipo:

1. Leer la sección relevante del HTML/CSS del bundle.
2. Identificar si debe ser GTK puro (overlays, cápsulas) o Adw (solo Settings/Dialogs).
3. Usar tokens `--crystal-*` — si falta alguno, añadirlo a `_base.scss` + `FluidCrystal.ts`.
4. Si necesita blur real, añadir `layerrule` a `config/hypr/hyprland.conf`.
5. Cairo solo para forma compleja estática.
6. Nombrar con `crystal-*` y estilar plano. Cero cadenas largas de selectores.

## Cosas que NO hacer

- No meter `Adw.ActionRow` / `Adw.SwitchRow` / `Adw.ComboRow` fuera de Settings.
- No hardcodear colores — siempre tokens.
- No añadir `transform: scale/translate` a widgets clicables.
- No pelear con nodos internos de Adwaita con `!important` o cadenas de 5 selectores. Si hace falta eso, el widget elegido es el equivocado.
- No usar emoji como iconografía — usar los SVG de `assets/fluid-crystal/assets/scalable/` o pedirlos al usuario.
