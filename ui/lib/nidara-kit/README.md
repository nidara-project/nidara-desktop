# nidara-kit

Nidara's platform library — what libadwaita is to a GNOME app. The widgets, the application host,
the appearance engine and the stylesheet every Nidara application wears. It is **installed once**
(`pacman -S nidara-kit`) and **loaded by every app when it starts**, so a fix or a design change
reaches all of them with one update. Licence: LGPL-3.0-or-later (`COPYING.LESSER`) — your app may
use any licence.

This file is the guide for writing an app **outside** the Nidara repository. Inside it, the four
bundles import the kit by relative path and `scripts/bundle.sh --kit-external` rewrites those
imports to what is below; the mechanism is in the repo's skill (`architecture.md` → "The kit's
CODE is loaded, not bundled").

**Language: JavaScript or TypeScript, run by GJS.** The kit is ES modules, so an app in Python,
Rust, C or Vala cannot import its widgets, its host or its appearance engine. A plain `.js` file
works with no build step (`gjs -m app.js`); TypeScript is compiled to one.

## What is installed

| path | what |
|---|---|
| `/usr/share/nidara-kit/js/<module>.js` | the modules, as ES modules — **this is what your app imports** |
| `/usr/share/nidara-kit/kit.css` | the kit's stylesheet |
| `/usr/share/nidara-kit/src/` | the TypeScript sources: the kit's **types** |
| `/usr/share/nidara-kit/package.json` | the kit's API version |

## Importing the kit

The kit is imported by **absolute `file://` URI**:

```ts
import app from "file:///usr/share/nidara-kit/js/platform/host.js"
import { NidaraWindow, NidaraButton } from "file:///usr/share/nidara-kit/js/index.js"
```

That is the kit's one public specifier, and it is not a stand-in for a nicer one: GJS resolves no
bare module names except its own built-ins (`gi://…`, `system`, `console`, `cairo`, `gettext`), so
`import … from "nidara-kit"` cannot be made to work at runtime without a bundler rewriting it. A
`file://` URI works in a plain `.js` file run by `gjs -m`, with no build step at all, and it is
exactly what the in-repo bundles contain after bundling.

- `index.js` — the widgets (`NidaraWindow`, `NidaraButton`, `NidaraList`, `NidaraRow`, the rows,
  the dialogs, `NidaraDropDown`, `makeSlider`, …). Read `src/index.ts` for the list.
- `platform/<module>.js` — what an app needs besides widgets:
  `host` (the `Gtk.Application`), `gtk-theme` (`useNoGtkTheme`), `appearance-css`
  (`initAppearance`), `kit-css` (`kitSheetPath`, `withKitSheet`), `font-rendering`, `icons`.

⚠️ **Import every kit module from `/usr/share/nidara-kit/js`, and never bundle a copy.** The kit
holds process-wide state — the application object, the appearance seam, every registered GObject
type — once per module. Two copies in one process are two application objects and two
appearance seams, and a widget built by one copy never hears what the other was told.

## A minimal app

```ts
import Gtk from "gi://Gtk?version=4.0"
import app from "file:///usr/share/nidara-kit/js/platform/host.js"
import { useNoGtkTheme } from "file:///usr/share/nidara-kit/js/platform/gtk-theme.js"
import { initAppearance } from "file:///usr/share/nidara-kit/js/platform/appearance-css.js"
import { kitSheetPath } from "file:///usr/share/nidara-kit/js/platform/kit-css.js"
import { NidaraWindow, NidaraButton } from "file:///usr/share/nidara-kit/js/index.js"

// Before any widget exists: no GTK theme at all. The kit's sheet draws
// everything; a node it does not style is drawn by nothing, never by GNOME.
useNoGtkTheme()

app.start({
    applicationId: "org.example.Hello",   // also the Wayland app-id
    applicationName: "Hello",
    css: kitSheetPath(),                  // or withKitSheet("/path/to/your/style.css")
    main() {
        initAppearance()                  // accent, light/dark, fonts — from the Settings portal
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12 })
        box.append(NidaraButton({ label: "Hello", variant: "primary" }))
        NidaraWindow({ app, title: "Hello", content: box }).window.present()
    },
})
```

Three calls are not optional, and none of them fails loudly when missing:

1. **`useNoGtkTheme()`** before anything is built. Without it the user's GTK theme paints under
   the kit's rules, and the app looks like Nidara on one machine and like something else on the
   next.
2. **The kit's sheet** — `kitSheetPath()` if you have no CSS of your own, or
   `withKitSheet(yourCssPath)` if you do. The latter puts both in ONE provider, kit first, so
   your rules win by specificity the way they would in one file (GTK does not compare
   specificity across providers).
3. **`initAppearance()`** inside `main()`. It reads the accent, the colour scheme and the
   opacities from the XDG Settings portal and follows them live. Skip it and the kit renders its
   fallback (a blue accent on a light surface) and logs a warning.

## Types (TypeScript)

The kit ships its sources as its types. Map the runtime URI onto them in your `tsconfig.json`:

```jsonc
{
  "compilerOptions": {
    "target": "ES2020",               // keeps useDefineForClassFields OFF — see below
    "module": "ES2022",
    "moduleResolution": "bundler",
    "skipLibCheck": true,
    "paths": { "file:///usr/share/nidara-kit/js/*": ["/usr/share/nidara-kit/src/*"] }
  },
  "include": [
    "/usr/share/nidara-kit/src/gi-cairo.d.ts",   // FIRST, or it is silently ignored
    "src/**/*.ts",
    "@girs/**/*"                                 // GI typings: npx @ts-for-gir/cli generate
  ]
}
```

- **`gi-cairo.d.ts` must be first in `include`.** The GI typings also declare `gi://cairo`, and
  whichever declaration tsc reads first wins; listed later, the shim does nothing and the kit's
  gradients become errors in YOUR typecheck.
- **`target: ES2020` when you compile TypeScript that subclasses a GObject.** Newer targets turn
  on define-semantics for class fields, which shadows GObject property accessors silently.
- Your compiler must leave `file://…` and `gi://…` imports alone: with esbuild,
  `--external:file://* --external:gi://*` plus gjs's built-ins (`system`, `console`, `cairo`,
  `gettext`), `--format=esm`.

## Depending on it, and what the version means

Package your app with

```
depends=('nidara-kit-api>=0.1.0' 'nidara-kit-api<0.2.0')
```

`nidara-kit-api` is the kit's **API** version (`/usr/share/nidara-kit/package.json`), provided by
the `nidara-kit` package. The package's own version is the Nidara release it was built in, and
says nothing about what your app can import.

What is the API: the module paths under `js/`, their exports, and the CSS classes and custom
properties (`--nidara-*`) the kit's sheet defines. An app built against one kit resolves those
**by name** at runtime against whatever kit is installed, so they are a contract.

- While the version is **0.x**, a **minor** bump (0.1 → 0.2) may remove or rename something;
  a **patch** bump never does. Hence the upper bound above.
- From **1.0**, only a **major** bump may.

Chunk files (`js/chunk-*.js`) are internal — their names are content hashes and change on every
build. Never import one.
