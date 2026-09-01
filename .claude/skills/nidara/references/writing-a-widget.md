# Writing a widget

A widget is **one file in `ui/shell/widgets/`** that default-exports an `AtomicWidget`.
Dropping it there registers it: `scripts/gen-widget-index.mjs` regenerates the committed
`widgets.gen.ts`, and it runs on `npm run build`/`dev` and in the dev launcher, so in practice
you never invoke it by hand. There is no registry to edit, no list to append to, no surface to
touch.

That last one is the rule this whole page exists for:

> **A widget declares what it IS and what it DOES, never where it is DRAWN.**

The bar and the Control Centre both host the same `AtomicWidget`. A widget that reaches into
either of them makes one host the owner of a vocabulary they share — which is exactly what had
happened by 2026-09-01, when `widgets/` held **28 imports from `surfaces/`** and every one of
them type-checked. `scripts/ci/widget-boundary-check.mjs` fails the build now if one comes back.

## The whole vocabulary, in one import

`import { … } from "../common/widget-kit"` is the only thing a widget file needs besides
`core/` services. Nothing here knows about the bar or the Control Centre; the hosts read the
widget, not the other way round.

### Deciding what the tile looks like

| word | size | what it is |
|---|---|---|
| `makeIconTile(getIcon, subscribe?)` | 1×1 | a status icon, **no click target** — the tile-level tap opens the detail, and a toggle here is a second, invisible hit-region on top of it |
| `makeRoundTile(getIcon, getActive, onClick, subscribe?)` | 1×1 | a round toggle button |
| `makeCapsuleTile(getIcon, getTitle, getSub, subscribe?)` | 2×1 | icon circle + title/subtitle, nothing clickable. **The common case** |
| `makeSplitCapsuleTile(getIcon, getTitle, getSub, onToggle, subscribe?)` | 2×1 | …but the icon badge toggles and the rest opens the detail |
| `makeHSliderTile({low, high, getValue, onChange, onExtChange})` | 4×1 | a slider between two end icons, with a live `%`. Everything in it is **0..100** |
| `makeVerticalFillTile` (in `ui/lib/nidara-kit`) | 1×2 | the fill IS the tile, so it lives in the shared kit rather than here |
| `makeCapsuleInner` + `wrapCapsuleTile` | any | the building block, when a tile needs the refs or builds its own box |
| `roundToggleSpec(id, name, icon, active, onClick, sub?, subscribe?)` | — | a whole content spec for a widget that is nothing but an on/off toggle |

Every maker takes an optional **`subscribe`**: hand it the service's own watcher
(`Net.watchWifiNetwork`, a `Theme.connect` wrapper, …) and the tile re-reads its getters when
it fires and disposes on `unrealize`. Do not wire that by hand — nine widgets used to.

### Deciding what the bar pill looks like

`makeBarIcon({ getIcon, onAction, activeClass?, getActive?, subscribe? })` is an icon-only pill.
`makeBarExpandable({ getIcon, getText, onAction?, autoHideMs? })` is one that slides a label out
on click and hides it again.

### Deciding what a panel looks like

A bar expansion (`buildBarExpanded`) and a Control-Centre detail (`buildCCDetail`) are both a
vertical column of rows:

- `panelRow(label, control)` — label on the left, a switch or a button on the right.
- `panelInfoRow(label, getValue)` — label + a live value, and an `update()` that re-reads it.
- `panelSeparator()` — a rule carrying 2px of its own air.
- `PANEL_W` — the width tiers, `sm` 200 / `md` 220 / `lg` 240 / `xl` 280 / `full` 356. **Never a
  hardcoded px width**: the scale belongs to the shell and gets re-tuned globally.

The **column** is deliberately not a word: a bar expansion sizes itself (`spacing: 12` + a
`PANEL_W` tier), a CC detail fills what it is given (`spacing: 0`, `hexpand`). Neither are a
row's outer margins — a `margin_bottom: 4` means "a separator follows", a `margin_top: 4` means
one precedes, and the row cannot know that. Set them on what you get back.

## The shortest widget that exists

`widgets/calculator.ts`, in full — copy it:

```ts
import { execAsync } from "../../lib/process"
import { AtomicWidget, WidgetSize, roundToggleSpec, makeBarIcon } from "../common/widget-kit"
import { t } from "../core/i18n"
import Icons from "../core/Icons"

const launch = () => execAsync("gnome-calculator").catch(() => {})

const calculatorWidget: AtomicWidget = {
    id: "calculator",
    category: "utilities",          // media | utilities | system — drives bar order + Settings grouping
    barOrder: 30,                   // optional fine-tune inside the category; lower = further left
    name: t("widget.calculator.name"),
    icon: Icons.calculator,         // for the Settings picker
    locations: ["bar", "cc"],
    defaultSize: WidgetSize.SINGLE,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE, WidgetSize.SQUARE],
    buildContent: (size, budget) =>
        roundToggleSpec("calculator", t("widget.calculator.name"), Icons.calculator, false, launch)
            .buildContent(size, budget),
    buildBarContent: () => makeBarIcon({ getIcon: () => Icons.calculator, onAction: launch }),
}

export default calculatorWidget
```

Everything else on `AtomicWidget` is optional and documented at its field in
`common/widget-kit/contract.ts`: `buildBarExpanded`, `buildCCDetail`, `buildSettings` (a
Configure subpage — keep a widget's own options with the widget), `isAvailable`/`watchAvailable`
(a hardware gate: without it the widget stops existing for the user rather than showing
broken), `getActive`/`watchActive` (fills the whole island with the accent, the standard
quick-settings convention), `getFill` (the gauge variant), `barClick` (intercept the pill's
click; consulted on every click, so it can answer differently as state changes).

## Never do host geometry

`buildContent(size, budget)` hands you a **`ContentBudget`**: the inner `width`/`height` the
host guarantees, plus `pitch`, the distance between two of its repeating slots. That is the
whole of what a widget is allowed to know about the surface drawing it, and it is **given, never
derived**. `UNIT`/`GAP` belong to `CCLayoutManager` and are unreachable from `widgets/` — the
boundary check sees to it. Your own intrinsic sizes (an icon circle, a caption's height) are
fine; reconstructing the host's grid is not. `cpu-memory` is the example: it spaces its two
rings `budget.pitch - ring` apart so each lands on a cell centre, and it used to rebuild that
number from `UNIT + GAP` by hand.

## Two things that fail silently

- **`common/widget-kit/` must stay a leaf.** Importing `CCLayoutManager` from it closes the
  cycle `CCLayoutManager → widgets/index → a widget → widget-kit → CCLayoutManager` and
  **crashes the shell at boot** (`CC_DEFAULT_ORDER` undefined mid-cycle). `tsc` does not see
  module cycles; only a real boot does. The boundary check does too, now.
- **A widget must not depend on another widget at module scope.** Import order is alphabetical.

## Trying it

```bash
node scripts/gen-widget-index.mjs       # only if you are not going through npm run build/dev
# Super+Shift+R in a graphical session, then:
tail -f "$XDG_RUNTIME_DIR/nidara-ui.log"
nidara-ipc queryUI ".your-css-class"    # read your widget out of the live tree, no screenshot needed
```

Commit `widgets.gen.ts` **with** your widget file: the CI job *Widget registry freshness* fails
on a stale one, and runs the boundary check beside it.

If you are extending your own installed copy rather than this repo, read
`agent-contribution.md` first — it decides whether your change is personal, belongs in Settings,
or is worth proposing upstream.
