# The toolkit, phase 1 — the contract (DRAFT)

**Status: draft for the owner and for review (Astra) before anything is built.** Phase 0's
contract is [CONTRACT.md](CONTRACT.md): its five gates passed on 2026-10-17 (#818). This file
does not amend it. Component names follow [CATALOG.md](CATALOG.md) and are still proposals;
`nk` stays the working name (the public name is the owner's, still open — `ntk` is taken in
Arch's own repositories by the Non ToolKit).

## The gate (#818)

> **Phase 1 — foundations + Settings.** The new Settings covers the daily-use pages and is
> measured against the current one (memory, start-up, smoothness), then replaces it.

With the owner's rules (2026-10-15): a new piece replaces the old one **as soon as it covers
daily use**; what is missing comes back later; a phase is never lengthened.

**Daily use, decided by the owner (2026-10-17): Appearance first — it is the page used most.
No other page is needed for the takeover (D3 accepted).**

## Decisions this draft proposes

Each is a proposal until the owner (product) or the review (architecture) accepts it.

### D1 — Settings changes settings through ONE service, the one agents already use

The current Settings runs the shell's TypeScript managers in its own process
(`registerConfigEntries()` in `ui/settings/app.ts`). Appearance alone is ~2,000 lines of that
logic (`ThemeManager`, `WallpaperManager`, `NightLightManager`, `WindowButtons`, the
compositor's settings), writing to GSettings, Hyalo's config and the wallpaper daemon. A Rust
Settings cannot import it, and rewriting it would double phase 1 for no visible gain.

Agents already reach all of it through one registry (`core/ConfigRegistry.ts`:
`describeConfig`, `getConfig`, `setConfig`, per-key `subscribe`), today only over `nidara-ipc`.

**Proposal:** that registry is served on the session bus as **`org.nidara.Config1`**:

| Member | Shape | Meaning |
|---|---|---|
| `Describe() → s` | JSON | every key: type, enum/range, default, `ui` (i18n key, options' i18n), `available` |
| `Get(as keys) → a{sv}` | | current values |
| `Set(s key, v value) → ()` | | applies through the registry's own `set`; errors as D-Bus errors with the registry's message |
| `Changed(a{sv})` signal | | emitted from each key's `subscribe`, whoever changed it (Settings, an agent, the shell) |

- **Served by the shell first** (it already owns the registry). Later it can move to
  `nidara-sessiond` (#574) with no change to any client — that move is NOT phase 1.
- The new Settings implements **no setting logic**: it renders what `Describe` says and calls
  `Set`. Agents and Settings see exactly the same keys — the "one tree, two views" the owner
  confirmed in #848, applied to settings.
- Shell not running → the new Settings says so and offers nothing to change. Accepted: Settings
  is part of the desktop session.
- MCP keeps working unchanged; moving `nidara-mcp`'s config tools onto `Config1` is optional.

### D2 — the manifest is the page

`ui/shell/surfaces/settings/manifest.ts` is already pure data (no `gi://`, imported by CI under
`node --experimental-strip-types`). **Proposal:** a build step exports it to
`build/settings/manifest.json`; the new Settings builds every `kind: "preference"` page
**generically** from manifest + `Describe` (group, row, switch, dropdown, slider by the key's
type; `visibleWhen`/`sensitiveWhen` from the same declarations). Only the manifest's named
`custom`/`decoration` items get hand-written builders, under the same names:
`wallpaperPreview`, `wallpaperGallery`, `wallpaperPicker`, `accentPicker`,
`nightScheduleTimes`, `interfaceFont`, `monoFont`. The manifest stays the single description of
both Settings until the old one is gone.

### D3 — replace the entry point when Appearance is done, page by page after that

**Accepted by the owner (2026-10-17).** the new Settings lists **every** page of the manifest in its sidebar from day one.
A page it does not draw yet opens the current Settings on that page (the existing
`org.nidara.Settings.Request(["page", id])`). So the new Settings can take over `nidara-settings`
as soon as Appearance passes the gate below, and nothing is lost meanwhile: the rest move one
page at a time, each with the same gate. This is the owner's rule ("replace as soon as it covers
daily use") without losing a page.

### D4 — one source for strings, icons and design tokens

No number or string is typed twice:
- **Translations:** the locale files (`ui/shell/core/i18n/locales/*.ts`, flat key → string)
  become JSON, imported by the TypeScript side and read by the Rust side. Parity and the ledger
  (`scripts/ci/i18n-check.mjs`) keep checking one set.
- **Icons:** the same `nd-` SVGs (`ui/shell/assets/icons/nidara/`), rendered with `resvg`.
- **Tokens:** phase 0 reads `--nidara-*` out of `ui/shell/styles/_base.scss` with
  `include_str!` (`phase0/src/palette.rs`). Phase 1 keeps one source and generates what Rust
  reads; the token contract check covers both ends.

### D5 — works on any Wayland compositor, best on Hyalo

Confirmed by the owner in #848. Phase 0's window refuses to run without `nidara-material-v1`;
phase 1's must not: without it the panes are opaque (the same tokens, no glass) and without
`nidara-layers-v1` the client animates itself. Accessibility, input and text are identical.

## Foundations (the toolkit pieces Appearance needs)

Promoted from phase 0's invariants (retained tree, stable ids, two-step layout, per-kind
invalidation, one focused node, pointer capture) into a library crate, **`nk-widgets`**. The
names are CATALOG's proposals:

| Component | Used by | Note |
|---|---|---|
| Window with sidebar + content (split workspace) | the app | sidebar = page list + search |
| Scroll region | content | kinetic/wheel scrolling, scroll-into-view on focus |
| Grouped list, row (title, subtitle, trailing control) | every page | the manifest's group/row |
| Switch, dropdown, slider, button | generic rows | dropdown exists in phase 0's form |
| Image + thumbnail strip | wallpaper preview/gallery | decode PNG/JPEG/WebP off the main thread |
| Swatch choice | accent | one-of-N, each swatch named for Orca |
| Time choice | night-light schedule | hour/minute fields, keyboard first |
| Font choice (dialog) | interface/mono font | families from fontique (what Parley uses), live preview |
| File choice | wallpaper picker | the FileChooser portal (`org.freedesktop.portal.FileChooser`) |
| Search input | sidebar | phase 0's text field + the search purpose |

Every component ships with: its AT-SPI role, name, state and events (the phase 0 provider);
its agent view — declared actions + risk `none`/`reversible`/`destructive` (CATALOG's
vocabulary, owner's answer to #848 Q2); keyboard operation; and a CI check that can fail.

## The gate's tests

Each automated in the `hyalo` job (vkms, the shell running), each with a control seen failing:

1. **Parity** — every Appearance key in the manifest is drawn and operable; a change made in
   the new Settings is read back by `getConfig` and shown by the current Settings, and a change
   made by an agent (`setConfig`) appears in the new Settings through `Changed` without a
   reload. Control: a Settings that drops `Changed` must fail.
2. **Keyboard + Orca** — the real-Orca harness of phase 0 walks Appearance: every control
   announced with role, name and value; the accent and the theme changed by keyboard alone.
3. **Fallback** — an unported page opens the current Settings on that page.
4. **Measured** — in the owner's live session (presentation feedback is real there, not in
   nested Hyalo), same machine, warm caches, the median of several launches; CI records the
   same numbers as a trend:
   - **Start-up: launch → first presented frame of the window, with Appearance drawn.** The
     owner (2026-10-17): since Settings became its own process (#813) it opens slower than
     Nautilus, and start-up must count. So the bar is **absolute, not only relative**: faster
     than the current Settings AND faster than Nautilus (GTK4, measured the same way). The
     references, measured below, are the bar.
   - **Memory:** PSS after open and after visiting Appearance — lower than the current Settings.
   - **Smoothness:** frame times while scrolling Appearance and while dragging the night-light
     slider — no worse than the current Settings.
5. **Live** — the owner uses it in their session and judges the look (warned first).

## Start-up: the references (measured 2026-10-17)

Owner's machine, live Hyalo session, 2560×1440. **Launch → the window's first buffer in
Hyalo**, from Hyalo's own event stream (`scripts/dev/startup-probe.py` over `msg events`: a window is listed only once mapped,
`ipc/server.rs` `window_infos`); PSS 2 s after. Median of runs 2–6 (run 1 warms caches); every
Nautilus run started with no Nautilus process left.

| What | First buffer | PSS |
|---|---|---|
| Current Settings, **dev mode** (`~/.config/nidara/.dev`: sass + two bundles + the C host rebuilt on EVERY launch) | 1539 ms (1493–1612) | 165 MiB |
| Current Settings, **installed** (`/usr/share/nidara/ui/settings/build/nidara-settings`) | 959 ms (916–974) | 157 MiB |
| Nautilus, cold (`nautilus --new-window ~`) | 473 ms (470–491) | 77 MiB |
| Phase 0's window (`nk-phase0`: corpus, form, fonts) | **133 ms** (127–142) | 50 MiB |

- **The bar for test 4:** the new Settings with Appearance drawn below Nautilus's **473 ms**
  (and so below the current Settings' 959 ms); PSS below 157 MiB. Phase 0's window already
  maps in 133 ms with fonts and text, so the budget for Appearance's content is ~340 ms.
- The owner's "slower than Nautilus" is half dev mode: ~580 ms of every dev launch is the
  rebuild, not Settings. (A dev launcher that rebuilds only when sources changed is a separate
  fix, outside the toolkit.)
- **Phase 0's `FIRST_FRAME_MS=840` was not the user's wait:** the buffer is in Hyalo at
  ~133 ms; what comes ~700 ms later is the `wp_presentation` feedback. Probably Hyalo delays
  the feedback while the output is idle — **to check in Hyalo** (a timeline of commit,
  render and feedback), since test 4's smoothness numbers rely on that feedback.

Start-up costs are then budgeted per piece: font collection (fontique), the `Describe` round
trip (D1: one call, cached schema), image decoding (off the first frame: the gallery appears
when ready), SVG icons (only the visible ones).

## Out of phase 1, said so

The other pages (after the takeover, one at a time with gates 1–3); moving the `Config1`
service out of the shell; the shell itself (phase 2); the C interface and bindings (phase 3);
GPU rendering beyond what phase 0 measured (experiment 6).

## Who builds what (proposal)

- **Claude:** `org.nidara.Config1` in the shell (D1), the manifest/locale/token exports (D2, D4),
  integration with Hyalo, review of every PR.
- **GPT 6.1 Sol:** `nk-widgets` and the Settings app, one issue per closed piece.
- **GPT 6 Astra:** reviews this contract before building (a design mistake here costs most).

## The owner's answers (2026-10-17)

1. D3: **yes** — take over `nidara-settings` once Appearance passes; unported pages open the
   current Settings.
2. Daily use: **Appearance only**; no other page for the takeover.
3. The bar: **start-up must count** — the current Settings opens slower than Nautilus since it
   became its own process. Test 4 now requires beating both (above).
