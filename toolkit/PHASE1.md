# The toolkit, phase 1 — the contract (revision 2)

**Status: ACCEPTED by the owner on 2026-10-18.** Revision 2, after the architecture review (Astra, comment on #852, 2026-10-18: seven
blocking findings, one non-blocking; each is answered below, marked `[A1]`…`[A8]`).** Phase 0's
contract is [CONTRACT.md](CONTRACT.md): its five gates passed on 2026-10-17 (#818). This file
does not amend it. Component names follow [CATALOG.md](CATALOG.md) and are still proposals;
`nk` stays the working name (the public name is the owner's, still open — `ntk` is taken in
Arch's own repositories by the Non ToolKit).

## The gate (#818)

> **Phase 1 — foundations + Settings.** The new Settings covers the daily-use pages and is
> measured against the current one (memory, start-up, smoothness), then replaces it.

With the owner's rules (2026-10-15): a new piece replaces the old one **as soon as it covers
daily use**; what is missing comes back later; a phase is never lengthened.

## Fixed by the owner (not reopened)

| When | Decision |
|---|---|
| 2026-10-17 | **Appearance** is the daily-use page and the only one the takeover needs |
| 2026-10-17 | **D3**: take over once Appearance passes; every other page opens the current Settings |
| 2026-10-17 | Start-up must beat **Nautilus (473 ms)** and the current Settings (959 ms) |
| 2026-10-17 | Any Wayland compositor, best on Hyalo (#848) |
| 2026-10-18 | **Trust model: cooperative consent, as today** — `Config1` is not wider than `setConfig`, and is not a security boundary (a process of the same user can write dconf). Real enforcement goes with #840 (privacy and permissions) |
| 2026-10-18 | **No non-Hyalo compositor run in CI in phase 1** — it would be paid on every PR. D5's fallbacks are specified and unit-tested, not run on a foreign compositor |
| 2026-09-13 | Applications read the appearance **only from the Settings portal** (#534) — so does the native Settings ([A8]) |
| 2026-10-15 | Rust, own AT-SPI provider (#834), Parley (#825) |

## D1 — one service changes the settings: `org.nidara.Config1`

The native Settings carries **no setting logic**. Every value it shows and every change it makes
goes through `org.nidara.Config1` (`ui/shell/core/ConfigService.ts`, #854), the registry agents
already use (`core/ConfigRegistry.ts`), served by the shell under its own name
`org.nidara.Config` so it can move to `nidara-sessiond` (#574) without touching a client.

### Identities `[A1]`

Two Settings processes coexist from now until the legacy one is gone. **Bus names are not app
ids**, and each name has one job:

| Bus name | Owned by | Job |
|---|---|---|
| `org.nidara.SettingsNative` | the native Settings, always (before and after the takeover) | the ONE name whose owner gets Settings' path in `Config1` (`Set`/`Apply` not gated by Settings → AI) |
| `org.nidara.Settings` | the legacy Settings **until** the takeover; the native one **after** | the entry point every client calls: the shell's `openSettings`/`settingsPage`/`settingsApp`/`queryUI`, `core/SettingsAppClient.ts`, the desktop entry |
| `org.nidara.SettingsLegacy` | the legacy Settings **after** the takeover | where the native Settings sends a page it does not draw (D3) |

- The native Settings uses **one bus connection** for everything: owning its names and calling
  `Config1` — the trusted check is "the sender owns `org.nidara.SettingsNative`", per call.
- At the takeover the launchers swap: `nidara-settings` runs the native app; the legacy one keeps
  its executable as `nidara-settings-legacy` and is single-instance under its new name.
  `Request(["page", id])` to the native app: drawn → navigate; not drawn → forward to
  `org.nidara.SettingsLegacy` (activating it), then raise it. `queryUI` answers for the native
  window; a page it forwarded is the legacy process's own `queryUI`.
- The legacy Settings writes through its in-process registry, as today; it never calls `Config1`.
- Cooperative model, stated plainly: a same-user process can claim
  `org.nidara.SettingsNative` while Settings is closed. That bypasses only the cooperative gate,
  as `gsettings` already does; it is not a privilege escalation. Agent writes are **never**
  unlocked to make the native Settings work.
- `ConfigService.ts` trusts `org.nidara.Settings` today (#854); it moves to
  `org.nidara.SettingsNative`, and the owner check is cached from `NameOwnerChanged` instead of
  one synchronous `GetNameOwner` per `Set` ([A4]: every slider step paid it).

### Every Appearance operation, through the service `[A2]`

The registry gains the keys Appearance's custom controls need. **Persistence stays in the shell's
services**; only the door is new. Each row: the key, its type and validation, the canonical value
`Apply` returns, what announces a change, and where the choices come from.

| Control (manifest item) | Key | Type, validation → canonical | Announced by | Choices |
|---|---|---|---|---|
| Dark mode | `appearance.darkMode` | boolean | Theme `changed` | — |
| Accent (`accentPicker`) | `appearance.accent` | enum `ACCENT_PALETTE` | Theme `changed` (#854 added it) | enum + swatch colour from `ACCENT_HEX` |
| Wallpaper image (`wallpaperPreview`, `wallpaperGallery`, `wallpaperPicker`) | **`wallpaper.current`** (new) | string: an absolute path to a readable JPEG/PNG/GIF/WebP/AVIF file (the formats the current picker accepts); a `file://` URI is accepted and canonicalised to the path | Wallpaper `changed` | **`catalogue`**: the bundled wallpapers (`getBundledWallpapers()`, greeter's excluded), offered, not enforced |
| Transition | `wallpaper.transition` | enum | Wallpaper `changed` (#857 fixed the silent shell write) | enum |
| Window transparency | `appearance.windowTransparency` | boolean; insensitive when `accessibility.reduceTransparency` | Theme `changed` | — |
| Window blur | `appearance.windowBlur` | boolean; `available` only on Hyalo | own setter + the compositor's `config-reloaded` (#857: other processes' writes) | — |
| Window controls | `appearance.windowControls` | enum `right`/`left`, **segmented** | WindowButtons change | enum |
| Night light on / temperature / schedule | `nightlight.enabled`, `.temperature` (integer K, rounded → canonical), `.scheduleEnabled` | as registered | NightLight `changed` | — |
| Schedule times (`nightScheduleTimes`) | **`nightlight.scheduleFrom`**, **`nightlight.scheduleTo`** (new) | string `HH:MM`, 24 h (the service's own `isTime`) | NightLight `changed` | — |
| GTK / icon / interface icon / cursor theme | the four `appearance.*Theme` keys | enum, **re-read at `Describe`** (a theme installed meanwhile appears) | Theme `changed` | enum |
| Interface / mono font (`interfaceFont`, `monoFont`) | **`appearance.interfaceFont`**, **`appearance.monoFont`** (new) | string, Pango description `Family [Style] Size` (point size, unscaled — as `org.gnome.desktop.interface` stores it); a family fontconfig does not know is refused | Theme `changed` | the chooser enumerates families itself, lazily ([A4]) |

Parity (gate 1) is checked **per control** of this table, not per manifest key.

### Synchronisation `[A3]`

Added **inside v1** (the protocol rule: never bump; old members stay as they are):

| Member | Shape | Meaning |
|---|---|---|
| `Snapshot() → (t epoch, t revision, s schema)` | | `schema` = `Describe`'s JSON (with values) at exactly `revision` |
| `Apply(s key, v value) → (t revision, v canonical)` | | `Set` that answers the value **in force** after it and the revision that includes it (a no-op or a normalisation still answers) |
| `Updated(t epoch, t revision, a{sv})` signal | | every change, with the revision it made; `Changed` keeps being emitted for old clients |

- `epoch` = the serving process's instance (random at start); `revision` = monotonic per epoch,
  +1 per announced change.
- **Client order:** subscribe to `Updated` first, then `Snapshot`; drop any `Updated` with a
  revision ≤ the snapshot's; never apply an old-epoch event or reply.
- **Owner lost** (`NameOwnerChanged` on `org.nidara.Config`): every control becomes insensitive
  and is marked unavailable; nothing is replayed. **Owner back:** new epoch → re-subscribe →
  fresh `Snapshot` → controls enabled again. A write whose reply never came is reported as
  failed, not retried.
- **Sliders:** at most one `Apply` in flight per key; the latest value waits; on release the
  final value is always sent and its canonical answer shown.
- **Errors:** `Invalid` (validation), `Denied` (the gate), `Failed` (the service threw while
  applying). The registry's `set` is awaited, so `Apply` answers after the service applied it.
- **Every observable value announces itself from every writer:** a key the native Settings
  draws must have a `subscribe` that hears all writers (own process, the legacy Settings, an
  agent, a file edit the service watches), and whose first call is synchronous and is the
  current value. CI writes each Appearance key through a path other than `Config1` and requires
  `Updated` (gate 1).

## D2 — the manifest is the page, on an allowlist `[A6]`

- **Allowlist, not inference:** the native Settings draws only the pages it lists — phase 1:
  `appearance`. Every other page, whatever its `kind`, is D3. Nothing is inferred from
  `kind: "preference"`.
- **The schema is versioned** (`schemaVersion` in `Snapshot`/`Describe`) and the renderer
  handles exactly these, everything else being a CI failure for an allowlisted page:
  controls `toggle`, `dropdown`, `segmented`, `slider` (unit, pct, decimals, step,
  `commitOnRelease`, `debounce`), `preset`; group `footer`/`footerWhen`; item
  `visibleWhen`/`sensitiveWhen`; `disclosure`; the named custom/decoration builders
  (`wallpaperPreview`, `wallpaperGallery`, `wallpaperPicker`, `accentPicker`,
  `nightScheduleTimes`, `interfaceFont`, `monoFont`).
- **Unavailable keys** are reported (`available: false`), not omitted, so a row can hide
  deliberately; an unknown current enum value is shown as it is, as the kit does.
- `Describe` has no `default` field (the registry has none); D1's earlier table promised one —
  dropped.
- **Language:** registry labels come translated from `Describe`; manifest strings from the
  exported `i18n/<locale>.json`. Both resolve against the session's language; the native
  Settings follows a language change by restarting, as the legacy one does.
- **Icons by name, not by path:** `ui.slider.icons` becomes icon names; the native Settings
  resolves them through the **interface icon theme** the user chose
  (`appearance.interfaceIconTheme`), as the shell does (`core/Icons.ts`).
- Read-only `ai.*` rows are not on the allowlist; their writes stay the legacy Settings'.

## D3 — replace the entry point when Appearance passes (accepted)

See [A1] for the identities and the routing.

## D4 — one source for strings, pages, icons and tokens

- **Pages and strings:** `scripts/export-settings-data.mjs` (#855) →
  `build/settings-data/manifest.json` + `i18n/<locale>.json`, from the same `manifest.ts` and
  `locales/*.ts`; locales stay `.ts`.
- **Tokens:** `scripts/export-tokens.mjs` (#856) → `build/settings-data/tokens/`: the token
  engine itself over its 72 inputs (accent × dark/light × reduce transparency × window
  transparency), on `_base.scss` compiled, plus `_tokens.scss`'s variables and `tokens.ts`'s
  data. **Not extended** to fonts, text scale, output scale or animation state: those are
  run-time inputs with layout/paint invalidation `[A8]`.
- **Installed** under `/usr/share/nidara/settings-data/` by `install.sh` and the PKGBUILD,
  with a `version` file shared by the three exports; a mismatch with the app's expected version
  is a start-up error, never a silent fallback.
- **Rendering authority `[A8]`:** the native Settings paints from the **Settings portal**, like
  every application (#534): `org.freedesktop.appearance` `accent-color`/`color-scheme` and
  `org.nidara.appearance` `reduce-transparency`/`window-transparency` select one of the 72 sets,
  all four from one `ReadAll`, re-selected on `SettingChanged`. `Config1` is for **editing**
  only. An unknown combination is an error shown, not a silent blue/dark. No file or `Config1`
  fallback for painting.

## D5 — any Wayland compositor, best on Hyalo `[A5]`

The capability contract (decided: specified + unit-tested in phase 1, no foreign-compositor CI
run):

| Protocol | Without it |
|---|---|
| `wl_compositor`, `wl_shm`, `xdg_wm_base`, `wl_seat` | **required** — refuse to start, say which |
| `wp_viewporter` + `wp_fractional_scale_v1` | integer `wl_surface.set_buffer_scale` (today both are REQUIRED in `nk-wayland`: becomes optional) |
| `nidara_material_v1` | **opaque base material** — the window and pane backgrounds forced to alpha 1 from the same tokens; hover/selection overlays keep their alpha; the user's transparency preference is not written back |
| `nidara_layers_v1` | the client animates, with ONE timeline shared by paint, hit-testing, focus bounds and the IME cursor rectangle |
| server-side window controls (Hyalo's) | client-drawn controls (close/minimise/maximise), keyboard reachable |
| `zwp_text_input_v3` | no input method: typing works, composition does not — said in the docs, not hidden |
| `wp_presentation` | frame callbacks only; the gate's numbers are taken on Hyalo |
| `zxdg_exporter_v2` | the file chooser opens unparented (`parent_window` empty) |

- Reduce motion (`org.freedesktop.appearance reduced-motion`) is honoured independently of reduce
  transparency.
- **File chooser:** `org.freedesktop.portal.FileChooser.OpenFile`, parented with an
  `xdg-foreign` handle when available; cancel = no change; an error is shown in the row; focus
  returns to the "Change…" button.
- Unit tests in the `toolkit` job build the capability set with each optional protocol missing
  and require the fallback above.

## Foundations (`nk-widgets`) and their acceptance `[A7]`

Promoted from phase 0's invariants (retained tree, stable ids, two-step layout, per-kind
invalidation, one focused node, pointer capture):

| Component | Used by | AT-SPI acceptance |
|---|---|---|
| Window with sidebar + content | the app | `FRAME`; sidebar `LIST` of pages, selected state; content `SCROLL_PANE` |
| Scroll region | content | `SCROLL_PANE`; focus scrolls into view; offscreen nodes stay in the tree (not hidden), `VISIBLE`/`SHOWING` correct |
| Grouped list, row | every page | group = `PANEL` labelled by its header (label relation); row label relation to its control |
| Switch, button | rows | `TOGGLE_BUTTON` (checked), `PUSH_BUTTON` |
| Dropdown | rows | `COMBO_BOX` + Selection (phase 0, #842) |
| **Segmented choice** | window controls | `RADIO_BUTTON`s in a `PANEL`, one checked, arrows move |
| Slider | temperature | `SLIDER` with the **Value** interface (min, max, current, step) and text "4500 K" |
| Preset choice | (presets) | radio group as segmented |
| Swatch choice | accent | radio group; each swatch named ("Blue"), checked state |
| Image + thumbnail strip | wallpaper | thumbnails = radio group named by file; preview `IMAGE` named |
| Time fields | schedule | two `SPIN_BUTTON`s per time (Value interface, labelled "From hour" …) |
| Font chooser (dialog) | fonts | modal `DIALOG`; family `LIST` + search `ENTRY`; focus returns to its launcher |
| Search input | sidebar | phase 0's field, `ENTRY` with search purpose |

- **Hidden versus offscreen:** a row hidden by `visibleWhen` leaves the tree; one scrolled away
  stays. Focus on a control that a predicate hides moves to the next focusable row.
- **Text scale and fonts change live:** layout invalidated, focus and scroll position kept.
- **Phase 0's text/IME invariants** hold in every field here (search, font search, time
  fields): preedit, surrounding text, cursor rectangle while scrolled, scale 1.25.
- **Agent view in phase 1 = the AT-SPI tree, nothing more.** No new remote action transport:
  agents change settings through `Config1`/MCP (gated by Settings → AI), and computer-use tools
  driving the window through AT-SPI are gated by `allowComputerControl` exactly as they are on
  the legacy Settings. A remote AT-SPI action runs the same code as a click — it does not
  carry an exemption of its own. Ids: window-lifetime node ids + a tree generation; stale,
  hidden or disabled targets are refused. Cross-launch identity stays CATALOG Q1 (open).

## Start-up `[A4]`

### The references (measured 2026-10-17)

Owner's machine, live Hyalo session, 2560×1440. Launch → the window's first buffer in Hyalo
(`scripts/dev/startup-probe.py` over `msg events`; a window is listed only once mapped); PSS
2 s after; median of runs 2–6.

| What | First buffer | PSS |
|---|---|---|
| Current Settings, **dev mode** (rebuilt on every launch; fixed by #853 → 933 ms) | 1539 ms | 165 MiB |
| Current Settings, **installed** | 959 ms (916–974) | 157 MiB |
| Nautilus, cold | 473 ms (470–491) | 77 MiB |
| Phase 0's window | 133 ms (127–142) | 50 MiB |

What these numbers are **not**: proof of content or of presentation. A GTK window's first
buffer carries its first full frame, which is why it serves for the two references; the native
Settings is held to more (below). Phase 0's 133 ms registered its fonts by file
(`system_fonts: false`), so it says nothing yet about resolving the user's font collection.
**No content budget is assumed** from 473 − 133.

### The milestone and the probe

- **Milestone: the first presented frame that contains Appearance with authoritative values**
  (from a `Snapshot`, never a cache). The native Settings logs `CONTENT_READY` with that frame's
  commit serial; Hyalo's presentation time for that commit is the end of the measurement. Image
  thumbnails may still be placeholders (named "Loading"), nothing else may.
- The probe is fixed before it measures anything: it refuses an already-open matching window,
  ties the window to the launched process (pid lineage), waits for its event subscription to be
  live before launching, and cleans up only what it launched.
- **Phase 0's 840 ms presentation-feedback gap** is explained first, in Hyalo (a timeline of
  commit, render, feedback), since the milestone depends on that feedback.

### Before the page is built: a measured slice

Sol's first piece: a window with the sidebar, one group of Appearance rows and its real data —
`Snapshot` over D-Bus, the user's fonts through fontique with `system_fonts: true`, the visible
icons through resvg, the real renderer — timed per component. Then the budget is set from that
measurement, not before. Rules it must already follow: the bus connection and `Snapshot` never
block the first layout serially with font resolution; font families for the chooser are
enumerated lazily, off the first frame; SVGs rasterised only when visible, cached by
name/theme/size/scale; thumbnails decoded at preview size with bounded concurrency, obsolete
results dropped; a D-Bus or portal call has a deadline and an error state.

## The gate's tests `[A7]`

Automated ones run in the `hyalo` job (vkms, the shell running). For every control: the fault is
**proven applied** (it logs that it ran) and **its own assertion** fails; a timeout, crash or
setup failure is not a caught control.

| Gate | Oracle | Discriminating control |
|---|---|---|
| 1 Parity | every row of D1's operation table: operated in the native Settings → the value read back through `getConfig`, applied by the service (the effect: GSettings key / Hyalo config / wallpaper daemon), shown by the legacy Settings; and written by another path → shown by the native one via `Updated` | separately: drop `Updated` handling; break one control's `Apply`; remove one custom builder; each must fail its own row |
| 2 Keyboard + Orca | the real-Orca harness walks every control and dialog of Appearance: `SPEECH OUTPUT` with role, name, value; each change made by keyboard alone and its effect verified; focus restored after the font dialog and the file chooser | suppress one control's value-changed event; break one keyboard action; break focus return — each fails its own assertion |
| 3 D3 fallback | a non-allowlisted page opens in the legacy process on that page: cold, with the native running, with the legacy already running | route to the wrong page; route to the native endpoint — each fails |
| 4 Measured | installed builds, same probe and milestone, 6 launches, median of 2–6: start-up **< 473 ms**; PSS after 5 s settled **< 157 MiB**; p95 frame interval over a scripted 2 s scroll and a 2 s slider drag **≤ the legacy Settings' p95** measured the same way. CI records the same numbers as a trend; the decisive run is the owner's session | test-only flags: a startup delay, extra retained memory, a stalled frame — each must fail its own comparison |
| 5 Live | the owner's explicit acceptance, with the revisions and the environment recorded | none — it is a person's judgement, not a test |

The exports are tightened too: #855's check compares **values** and Appearance's items and
predicates, not only key sets; #856's compares every token value of a set with an independent
computation of a sample of sets.

## Order of the work

1. **Claude** — this contract; `Config1` additions (`Snapshot`/`Apply`/`Updated`, the new
   keys of D1's table, `SettingsNative` trust with a cached owner, `available:false`,
   re-read enums, icon names); the probe fixes; the presentation-feedback timeline in Hyalo;
   the export checks tightened; installation of the exports.
2. **Sol** — the measured slice (above); then `nk-widgets` component by component, each with
   its AT-SPI acceptance and a control; then the Settings app (D2 renderer, the custom
   builders, D3 routing, D5 fallbacks).
3. **Owner** — gate 5, after gates 1–4 pass.

## Out of phase 1, said so

The other pages (after the takeover, one at a time with gates 1–3); moving `Config1` out of
the shell; a foreign-compositor CI run (owner, 2026-10-18); enforcement beyond cooperative
consent (#840); the shell (phase 2); the C interface and bindings (phase 3); GPU rendering
beyond phase 0's measurement (experiment 6).
