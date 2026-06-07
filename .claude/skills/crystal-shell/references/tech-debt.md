# Crystal Shell — Known tech debt

Read this before a refactor or before "fixing" something that feels weird — many odd
patterns are known tradeoffs with reasons. **Keep this file honest:** when you resolve an
item, remove it (or move it to "Resolved — rules that still apply"); when you create or find
debt, add it. It must match reality.

## Active debt

### 1. `@mixin glass()` underused
Defined in `_base.scss` (levels `surface`, `raised`, `floating`) but only ~2 call sites use
it, vs ~20 manual glass blocks scattered across components. **Don't add new manual glass
blocks** — use the mixin. Migrate manual blocks opportunistically. (For contrast,
`@mixin crystal-reset` is well-adopted, ~45 sites.)

### 2. Anti-Adwaita resets still dense in two files
`_control-center.scss` (~33 reset rules) and `_settings.scss` (~24). High reset counts signal
these surfaces are fighting Adwaita widgets they shouldn't use. **Don't add more resets** —
use `@mixin crystal-reset` or switch the widget to base GTK4 / `ui/lib/crystal-ui/`.

### 3. CC row typography doesn't scale with the font picker
`_control-center.scss` overrides `.crystal-row-title` / `.crystal-row-subtitle` to fixed
`$fs-small` **px**, while the shared component (and Settings) use the `$fse-*` **em** ramp that
follows the Settings font-size picker. Intentional for chrome (must not reflow) but worth a
look when polishing the CC — decide whether CC text should track the picker like Settings.

### 4. HyprlandState effective-config is read-once, not reactive
`HyprlandState.getOptionInt()` / `availableModesByName` read effective Hyprland config
(`hyprctl getoption` / `monitors -j`), but consumers read **once** (e.g. the Settings page
build, which is cached). An external change (terminal / `hyprland-user.lua` reload) isn't
reflected until a UI reload. Deferred fix: have HyprlandState listen to Hyprland's
`configreloaded` event to refresh its caches, and consumers re-sync. This is also the path for
reading gaps/rules so the UI (e.g. dock spacing) can adapt to user overrides instead of our
own `hyprland.lua` defaults.

### 5. i18n has no hot-reload
`detectLanguage()` runs once at startup; a locale change needs `Super+Shift+R`. Out of scope
for most PRs, but know it when testing locale changes.

### 6. Architecture/skill docs are intentionally git-ignored
`CRYSTAL_SHELL_ARCHITECTURE.md` and `docs/crystal-shell-skill-brief.md` are local-only by the
owner's decision. Record architectural decisions there and/or in this skill's `references/`,
not in a tracked repo doc.

### 7. `pageHeader()` removed — RESOLVED
Settings page titles live in the **window header** as a breadcrumb (driven by
`Settings.tsx`, shown via `CrystalWindow`'s `headerTitle`). The in-body `pageHeader()`
stub, all ~19 `page.append(pageHeader(...))` call sites + their imports, and the
`.settings-page-title`/`-subtitle` CSS have been swept. Only leftover: the
`settings.*.subtitle` i18n keys are now dead (left in place per the bulk-i18n workflow).

### 8. Settings subpages: the framework still builds them once
A subpage pushed via `SettingsNav.pushSubpage` is built once (fresh on each push, but static
after) — `pushSubpage` itself has no live-rebuild story, so a subpage that needs reactivity
must wire its own signals. The Wi-Fi AP detail page now does exactly that (it subscribes via
`NetworkService.watchWifi` + the AP's `notify::strength` and updates its labels in place, with
the IPv4 group shown only while that AP is the active connection). So the *pattern* for a
reactive subpage exists; the generic framework convenience does not.

### 9. Bluetooth pairing has no agent (passkey/PIN UI missing)
Settings → Bluetooth pairs via a bare `device.pair()`, with **no `org.bluez.Agent1`
registered**, so it's "just works" only: devices that need a 6-digit passkey confirmation
or a PIN have no UI and will pair blind or fail. AstalBluetooth offers no agent helper —
implementing it means raw Gio D-Bus: register an `Agent1` (capability `KeyboardDisplay`)
via `AgentManager1.RegisterAgent` + `RequestDefaultAgent`, handle `RequestConfirmation` /
`RequestPasskey` / `RequestPinCode` / `DisplayPasskey` / `DisplayPinCode` → drive a Crystal
dialog. Agent registration belongs in `BluetoothService`, the dialog in the page. **Testing
caveat:** the python-dbusmock bluez5 template's `Pair` never calls back into the agent, so
the passkey flow can't be exercised with the fake-bluetooth mock — needs real hardware or
manual D-Bus invocation of the agent methods.

## Resolved — rules that still apply

These were paid down; the *rule* remains:
- **Dock H/V** is deduplicated — fix dock logic in `DockCore.tsx` / `DockAxis.ts`, never the
  7-line wrappers.
- **Accent colors** live only in `ui/lib/accent.ts` — add/change them there.
- **Greeter ↔ lockscreen** share `ui/lib/accent.ts` + `ui/lib/users.ts`; `lib/i18n.ts` stays
  separate per bundle on purpose (different config paths / superset).
- **`Status.ts` exclusion** — add a new overlay's `_field → notify` to `EXCLUSIVE` and call
  `closeExclusive(...)`; don't touch the other setters.
- **Repo weight** — history was rewritten (.git 342→95 MiB); old clones must re-clone. Don't
  commit binaries beyond the 3 release bundles; verify pngs / build artifacts stay git-ignored.
- **Sliders** — one Cairo `makeSlider` (`widget/common/Slider.ts`); no native `Gtk.Scale`,
  no `PillSlider`. See `design-system.md`.
- **Monitor config** — applies via `hyprctl eval "hl.monitor({...})"`, NOT `hyprctl keyword`
  (rejected by the Lua parser). See `architecture.md`.

---

## Meta: how to interpret "tech debt" here

Not a bug list — conscious tradeoffs to pay down opportunistically:
1. If you're already in a file, prefer the "right fix" direction — but only if small and
   self-contained.
2. If it would balloon your change, leave it and add a comment linking here.
3. **Don't refactor as a side-effect of an unrelated change** — drive-by fixes tend to be
   partial and create drift.
