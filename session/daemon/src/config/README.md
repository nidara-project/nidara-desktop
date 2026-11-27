# Config1 ordinary pages (#1103, 7b)

`ordinary.rs` adds fourteen keys to the existing registry. The Settings AppWindow
entry is unchanged: its manifest admission rule now admits Dock, Notifications,
Accessibility and Input/Devices against the native service. Desktop/workspaces,
AI policy and installation are outside this step.

| Key | Home and canonical value | Existing consumer |
| --- | --- | --- |
| `notifications.doNotDisturb` | `org.nidara.notifications/do-not-disturb`, bool | Rust shell `prefs::watch_notifications`, banner policy |
| `notifications.popupTimeout` | Same schema, `popup-timeout`, 2–15 seconds, nearest integer | Same preference watch, banner timeout |
| `accessibility.textScale` | `org.gnome.desktop.interface/text-scaling-factor`, .75–1.5, two decimal places | Settings portal appearance; nk-platform/AppWindow |
| `accessibility.cursorSize` | Same schema, `cursor-size`, 16–96 px, nearest integer | Existing Config1 GTK/cursor follower → Hyalo |
| `accessibility.reduceMotion` | Same schema, inverse of `enable-animations` | Rust shell/toolkit motion policy and Config1 follower → Hyalo animations |
| `input.mouse.speed` | Hyalo `input.pointer.accel_speed` **and** `input.touchpad.accel_speed`, −1–1 | Hyalo backend input reconfiguration |
| `input.mouse.accel` | Both `accel_profile` fields, `adaptive` or `flat` | Same |
| `input.mouse.natural` | Hyalo `input.pointer.natural_scroll`, bool | Same |
| `input.touchpad.natural` | Hyalo `input.touchpad.natural_scroll`, bool | Same |
| `input.touchpad.tap` | Hyalo `input.touchpad.tap`, bool | Same |
| `input.keyboard.layout` | Hyalo keyboard `layout` and `variant`, one atomic patch | Hyalo `set_xkb_config` |
| `input.keyboard.numlock` | Hyalo keyboard `numlock`, bool | Hyalo startup/reload policy; false does not forcibly toggle an already-on lock |
| `input.keyboard.repeatDelay` | Hyalo keyboard `repeat_delay`, 100–2000 ms, nearest integer | Hyalo `change_repeat_info` |
| `input.keyboard.repeatRate` | Hyalo keyboard `repeat_rate`, 1–100, nearest integer | Same |

Types, bounds, translation keys and canonicalization follow
`ui/shell/config-entries.ts` and its existing services. GSettings remains the
single home for the first five keys. Input goes through Hyalo's `settings` IPC;
this service never writes Hyalo TOML. After each write it reads the merged
configuration and checks **all** affected fields, including the pointer/touchpad
pair. A user configuration overriding the patch returns `Failed`, rather than
claiming the requested value took effect.

The bounded graphical keyboard catalogue reads XKB `base.lst` once. IDs match
`ui/lib/keyboards.ts`: `layout` or `layout-variant`; variant names may contain
hyphens. `custom` is excluded. Labels are XKB descriptions; console keymaps,
localed, installer bridges and extra localization machinery are not introduced.
Missing schemas/keys, missing XKB data or unavailable compositor fields leave the
corresponding key unavailable, without inventing an effective value.

The existing compositor monitor reads idle and input in one request. Its shared
serial guard prevents an older read from overwriting a completed local write.
The reduce-motion lane uses the existing effect/reset machinery: apply at startup,
on home changes, after compositor reload/hotplug and on reconnect. Reducing writes
`animations.enabled: false`; restoring removes the override with `null`, preserving
lower/user-layer choices instead of forcing animations on. Hyalo's idempotent merge
prevents feedback from its own reload notification. The lane retains existing retry
and error deduplication behavior. Each key's Describe description matches the TS
registry, including these behavior details.

GSettings changes use the existing key watches; cursor-size now uses its registry
watch to publish the existing follower snapshot rather than adding another watch.

## Validation and limits

`tests/config.rs` exercises all fourteen writes through Config1, exact homes,
canonical replies, invalid values, user-layer overrides, external input changes,
and missing homes. Unit tests cover layout variants and unified pointer patches.
These tests use the existing private-bus test infrastructure; no CI checker or
workflow is changed.

The separate private nested-Hyalo run reads actual effective configuration after
pointer, layout and repeat writes, checks GSettings and notifications homes, and
waits for the existing cursor follower to update Hyalo. The unchanged AppWindow
entry is opened against this real 57-key service, with four eligible pages and no
simulated Config1 keys. Its appearance portal is the existing private fixture. Both scales, 1 and 1.25,
are captured; the keyboard selector is revealed with PageDown and checked for
nonempty geometry contained within the window. A focus request alone was not
sufficient evidence of visibility in this run.
The driver starts during compositor initialization and must wait for the first
successful IPC reply before checking capabilities.

A nested winit backend does not prove libinput behavior on physical hardware,
notification delivery in the installed shell, real portal propagation, or Orca.
Those acceptance checks remain pending; the installed session is untouched.

The real XKB catalogue exposed a 7a layout limit: a dropdown reserved the widest
option without allowing it to shrink. Its trigger now uses the existing
single-line fitting mechanism: reserved room stays stable when it fits and gives
way within a constrained row. Only the closed painted label is ellipsized; full
options and accessible names are retained. A two-scale, two-width regression
checks containment, stable selection geometry and complete semantic options.

## Workspace modes (#1103, 7c)

`desktop.rs` adds the Desktop page's six keys: `workspaces.defaultMode`
(`floating`/`tiling`) and `workspaces.workspace1Mode`–`workspace5Mode`
(`default`/`floating`/`tiling`). Their home is Hyalo's settings layer, `[workspaces]`
`default_mode` and `modes`, the same patch as `saveWorkspaceModes` in
`hyalo-settings.ts`; `default` writes `null`, which takes the workspace out of the
layer. TS also kept a copy in its own `workspaces` file. Nothing reads that copy in the
Hyalo session, so it is not a home here.

Hyalo reorganizes the windows of each workspace whose configured mode changed. A mode
toggled at runtime (`set-workspace-mode`, the keybinding) would hide that change, so after
a write the service sends `set-workspace-mode N default` for each affected workspace:
- for a single workspace's key, that workspace;
- for the default, every workspace that follows it.

A mode chosen in Settings therefore wins over a runtime toggle, as `pushAll` did in TS.
The read-back and the `Failed` reply when the user's layer wins work as for Input; the
existing monitor also refreshes `[workspaces]`.

## Performance profile (#1103)

`profile.rs` serves `power.profile`, a single-selection list of the profiles
power-profiles-daemon advertises. Its home is PPD's `ActiveProfile`, the property TS set
with `powerprofilesctl`, read and written on the system bus. Power1 sees such a write as
a manual choice and the automatic saver stands aside (`power/README.md`).

PPD's `PropertiesChanged` and its `NameOwnerChanged` re-read the profile and announce the
key; there is no polling. Without PPD the key is unavailable, and so is the Power page.
The tests point `DBUS_SYSTEM_BUS_ADDRESS` at their private bus, so the host's PPD never
leaks in.

## Region (#1103 8b)

`region.rs` serves these keys:

- `region.timezone` is the system's, systemd-timedated's `Timezone`. When timedated cannot
  be asked, it falls back to `/etc/localtime`'s link. A write is `SetTimezone` with
  interactive polkit, and it is asynchronous because the password prompt waits for the
  person. `Apply` answers the zone still in force, and the new one is announced once
  timedated has set it. A refused or cancelled prompt changes nothing and announces nothing.
  Valid zones are `timedatectl list-timezones`' (tzdata.zi's zones and links), offered as
  `catalogue`. There is no generic control for it: the Region page draws its own city search.
- `region.regionalFormat` is this user's `~/.config/environment.d/nidara-locale.conf`. It
  sets the seven format `LC_*` variables for the next login. "" removes those assignments
  and follows the language. Values come from `locale -a` spelled `.UTF-8`, plus a saved one
  the system stopped listing.
- `region.language` reads `LANG` in the same file and falls back to the session environment.
  A write sets `LANG` and `LANGUAGE` for the next login. Both writers preserve the other
  key's assignments. Config1 announces its writes and watches the file for external changes.
  The shell follows `region.language` live. Settings installs a required missing input engine
  before applying the selection. Config1 checks the engine package at the
  write boundary and refuses the change when it is missing.

## Top bar (#1103 8e)

`bar.rs` serves the keys of Settings → Top bar, in the homes the TS shell used:

- `bar.appTitle` and `bar.launcherIcon` are `org.nidara.bar`'s `show-app-title` and
  `launcher-icon`. The icon is `"nidara"` (the mark) or an absolute path to an SVG, PNG,
  JPEG or WebP image. A stored file that is gone, or an old preset, reads as `"nidara"`.
- `bar.trayHidden` is the first **list** key (`type: "list"`, `Value::List`, `as` on the
  wire). Its `Apply` takes a JSON array of strings, and its value is the members of
  `values` it names, each once and in the order of `values`. The members are tray icon
  Ids, stored as `tray:<Id>` in `org.nidara.widgets` `bar-hidden`. A write replaces only
  the offered Ids and keeps every other member: `shell:search`, and an app that is not
  installed now. `values` are the icons in `tray-known` whose app is still installed
  (or that no app was matched to). `ui.items` gives each one's title, icon and app.
- sessiond's tray service writes `tray-known` (`config::remember_tray`) when an item
  registers. The app is the first candidate from the process's unit that has a desktop
  file. It writes only when something changed.
- The clock's `region.timeFormat`, `region.dateFormat` and `region.showSeconds` are
  `org.nidara.region`'s. Settings shows them on the Clock subpage of Top bar.

Where each control appears (Wi-Fi, volume and the rest) is not here: #1144. The Rust bar
follows these homes in #1177.
