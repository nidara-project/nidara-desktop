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

A pill opens a panel only if the widget has `buildBarExpanded`. **It never falls back to the CC
detail** — until 2026-09-25 it did, and since a `makeBarIcon` acts on press and the capsule's
release fires after it, one click on night light / Bluetooth / Focus toggled AND opened the CC.
A widget with a CC detail but no bar panel acts from its pill, like dark mode.

**The pill is also reachable by keyboard** (Super+Ctrl+B walks the bar, Enter/Space/↓ acts —
since 2026-09-27). Both makers register their action with `barKeyAction`, so they get this for
free. A hand-built `buildBarContent` that takes its click through a `GestureClick` is NOT
reachable: a gesture has no key. Either use a `Gtk.Button` (a keyboard stop on its own) or have
`buildBarExpanded`/`barClick`, which the bar runs on the key as it does on the click.

### Deciding what a panel looks like

A bar expansion (`buildBarExpanded`) and a Control-Centre detail (`buildCCDetail`) are both a
vertical column of rows:

- `panelRow(label, control)` — label on the left, a switch or a button on the right.
- `panelSwitch(get, set, subscribe?)` — **the only switch a panel should hold.** It calls `set`
  when the USER flips it and only reflects `get()` when `subscribe` fires. Do not hand-roll
  `new Gtk.Switch` + `state-set` + `sw.active = get()`: GtkSwitch emits `state-set` for a
  programmatic `active` too, so the write-back re-issues the command. Against an async service
  that passes through intermediate states that is a loop — the Wi-Fi detail toggled the radio
  ~14×/s until the panel closed (2026-09-14), and nothing in `tsc` or a single click shows it.
- `panelInfoRow(label, getValue)` — label + a live value, and an `update()` that re-reads it.
- `panelSeparator()` — a rule carrying 2px of its own air.
- `PANEL_W` — the width tiers, `sm` 200 / `md` 220 / `lg` 240 / `xl` 280 / `full` 356. **Never a
  hardcoded px width**: the scale belongs to the shell and gets re-tuned globally.

The **column** is deliberately not a word: a bar expansion sizes itself (`spacing: 12` + a
`PANEL_W` tier), a CC detail fills what it is given (`spacing: 0`, `hexpand`). Neither are a
row's outer margins — a `margin_bottom: 4` means "a separator follows", a `margin_top: 4` means
one precedes, and the row cannot know that. Set them on what you get back.

## The shortest widget that exists

`widgets/dark-mode.ts`, in full — copy it:

```ts
import Theme from "../core/ThemeManager"
import { AtomicWidget, WidgetSize, roundToggleSpec, makeBarIcon } from "../common/widget-kit"
import { t } from "../core/i18n"
import Icons from "../core/Icons"
import { safeDisconnect } from "../core/signals"

// One subscribe, reused by every surface below — the tile, the bar pill and the
// island's active state all re-read their getters when the theme changes.
const themeSubscribe = (sync: () => void) => {
    const id = Theme.connect("changed", sync)
    return () => safeDisconnect(Theme, id)
}

const darkModeWidget: AtomicWidget = {
    id: "dark_mode",
    category: "system",             // media | utilities | system — drives bar order + Settings grouping
    barOrder: 10,                   // optional fine-tune inside the category; lower = further left
    name: t("widget.dark-mode.name"),
    icon: Icons.moon,               // for the Settings picker
    locations: ["bar", "cc"],
    defaultSize: WidgetSize.SINGLE,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE, WidgetSize.SQUARE],
    buildContent: (size, budget) => roundToggleSpec(
        "dark-mode", t("widget.dark-mode.name"),
        () => Theme.isDark ? Icons.moon : Icons.sun,
        () => Theme.isDark,
        () => Theme.setDarkMode(!Theme.isDark),
        () => Theme.isDark ? t("widget.dark-mode.sub.dark") : t("widget.dark-mode.sub.light"),
        themeSubscribe,
    ).buildContent(size, budget),
    buildBarContent: () => makeBarIcon({
        getIcon: () => Theme.isDark ? Icons.moon : Icons.sun,
        onAction: () => Theme.setDarkMode(!Theme.isDark),
        subscribe: themeSubscribe,
    }),
    getActive: () => Theme.isDark,
    watchActive: themeSubscribe,
}

export default darkModeWidget
```

Everything in it is a getter plus a `subscribe`, and nothing in it is a value read once. That is
the shape: the widget never pushes, the host pulls when the subscribe fires.

**How a control shows in the bar — one rule for every widget** (owner, 2026-09-28, taken from
Apple's Menu Bar pane after #651 had put "When active" on the wrong ones). A widget is one of three:

| kind | declares | in Settings → Top bar | examples |
|---|---|---|---|
| plain | neither | a check: shown or not; its ICON says on/off | Wi-Fi, Bluetooth, VPN, volume |
| choosable | `ccFixed` + `barActive` (+ `defaultBarMode`) | a check + "Always / When active" | Do Not Disturb, night light |
| presence | `barActive` alone | a check; there only while `barActive()` holds | Ethernet (a cable — turned off from its CC tile or Settings, never from the icon that then disappears) |

"When active" is for a state that COMES AND GOES — Apple offers it for Focus, Sound, Display,
Screen Mirroring and Now Playing, never for Wi-Fi, Bluetooth or VPN. And only for a widget the CC
always has (`ccFixed`): hidden from the bar while off, the CC tile is how it gets turned on again,
and a fixed tile cannot be removed. `widgets/index.ts` derives `DEFAULT_BAR_MODE` (choosable) and
`BAR_PRESENCE` from these declarations; `WidgetConfig.barMode` answers "active" for a presence
widget and ignores a stored choice for anything not choosable. A presence indicator must not be
the way the thing is turned on — that is the trap the rule exists for.
`barActive` is NOT the CC's `getActive` (the tile's accent fill): dark mode is "on" in that sense,
and hiding its own switch while it is off would leave no way back.
A missing adapter is not a mode: `isAvailable` false = the control does not exist on this machine
(not in the bar, not listed in Settings → Top bar), and a dongle plugged in later brings it back.
⚠️ **Not with `buildSettings`.** Settings → Top bar gives a row ONE trailing control, and Configure
beats the mode menu — so a widget with a settings page AND a choosable mode has a mode nobody can
change. Screen recording shipped that way in #651, defaulted to "When active": its icon (where a
capture STARTS) never appeared, checked or not (owner, 2026-09-27).

**Fixed in the Control Centre: `ccFixed`.** Wi-Fi, Bluetooth, Do Not Disturb, night light, volume,
brightness and media — Apple's fixed modules, adapted to hardware that may not be there. A fixed
widget is in the CC whenever it is available: `WidgetConfig` forces its placement (a stored
`false` included) and refuses `setCC(false)`; the CC's edit mode has no ✕ and its context menu no
Remove for it (it still moves and resizes); Settings → Widgets shows its Center switch on and
insensitive. So a CC can never be emptied. Known limit: a fixed widget whose hardware appears
while the grid is full has no cell and stays out until one frees up (tech-debt.md).

**The master switch goes on the CC detail's title line: `ccDetailSwitch`.** A detail used to
open on its title ("Wi-Fi") and then a row "Wi-Fi [switch]" under it (owner, 2026-09-28). A
widget with an on/off now hands the switch to the CC (`ccDetailSwitch: () => Gtk.Widget`), which
puts it right of the title and names it after the widget for accessibility, and its
`buildCCDetail` leaves that row out: Wi-Fi, Bluetooth, night light, Ethernet. The BAR panel keeps its
switch row — there it IS the title. A widget whose detail would be nothing but that switch has
no detail: Do Not Disturb's tile is the toggle at every size (`roundToggleSpec`, whose optional
`wideTitle` keeps a capsule title that is not the widget's name).

**A panel that rebuilds its rows owes the keyboard focus back.** Removing the focused row
lets GTK move the focus wherever it likes — in the Wi-Fi panel that was the current network's
leave button, so Enter to open its details and Enter again to close them would have
disconnected (measured by keyboard, 2026-09-28). Two rules, both in `widgets/wifi.ts`: a
disclosure (details, a folded section) shows and hides what it opens IN PLACE, never by
rebuilding; and a rebuild forced by data (a scan, the link changing) records the focused row by
what it IS (a key, not a widget) and grabs the new row with that key, else a harmless one.
And a destructive one-click target is not a Tab stop where a panel opens: a CC detail opened by
keyboard focuses its FIRST stop, which was that same leave badge — Enter on arrival would have
disconnected. The badge is pointer-only (Apple's); the keyboard gets a visible "Disconnect" in
the details. ⚠️ GTK sets `:focus-visible` along the whole focus CHAIN, so a box that carries row
states draws the ring around a focused child too — the current-network box turns it off.

**Bar content carries its own side air.** In the bar a widget is an ITEM of the right-hand group,
touching its neighbours, and the hover/open pill is drawn round whatever the content measures
(design-system.md → "Bar groups"). `makeBarIcon`/`makeBarExpandable` already put `BAR_ITEM_PAD`
(8) on each side; a hand-built `buildBarContent` must do the same, or its pill hugs the glyph.

Everything else on `AtomicWidget` is optional and documented at its field in
`common/widget-kit/contract.ts`: `buildBarExpanded`, `buildCCDetail`, `buildSettings` (a
Configure subpage — keep a widget's own options with the widget; ⚠️ it is the one field Settings
cannot receive once it runs in its own process (#571), so put the options themselves in GSettings
and keep the page a thin set of rows over them, as `screenrecord` does), `isAvailable`/`watchAvailable`
(a hardware gate: without it the widget stops existing for the user rather than showing
broken), `getActive`/`watchActive` (fills the whole island with the accent, the standard
quick-settings convention), `getFill` (the gauge variant), `barClick` (intercept the pill's
click; consulted on every click, so it can answer differently as state changes),
`barTooltipState` (the pill's tooltip is the widget's `name` for free; return a short,
translated state and it reads "name · state" — owner's call 2026-09-24: title by default, state
opt-in. The pill gets it through `barTooltip` (`surfaces/bar/capsule.ts`): none shows while a bar panel is open, and one already up closes when a panel opens — by Status state, since a bar panel lives in the bar's own surface and the pointer never leaves the capsule).

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
