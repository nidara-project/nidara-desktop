<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# Native displays and projection selector

The native Settings sidebar draws `display` directly from Display1 and
DisplayBrightness1. These are hardware services, not Config1 keys. Appearance
still comes only from the Settings portal and the existing complete exports.
There is no TS bridge or takeover of the legacy Settings entry point.

`page::Page` owns retained rows in the existing nk-widgets Tree. Its output LIST
publishes selection and the compositor's snapshot numbers/names; the diagram uses
the same logical coordinates. Select an output, drag it beside another, or use the
X/Y spin buttons and before/after controls with keyboard or AT-SPI. Changing a
mode, scale, transform, VRR, enablement or primary updates a draft. Internal-only,
external-only, extend and duplicate presets are drafts in Settings; the selector
previews the chosen preset directly. Unsupported presets are disabled. No preview
is made on discovery, selection, styling or a draft edit.

Apply sends Validate and then Preview using the captured unique owner, epoch and
revision. Geometry/resource validation and durable profiles remain Hyalo's job.
Observed layout changes replace stale drafts. A preview becomes a compact
confirmation view near the leading edge, with Revert as the initial focus. Its
accessible countdown reads the compositor's CLOCK_MONOTONIC deadline; receipt time
never restarts the lease. Only the token returned to this client's own connection
can be confirmed or cancelled. Save failure retains that token for retry. A foreign
preview can be observed but not adopted. Closing, unmounting, navigation away or an
uncertain Preview closes the dedicated lease connection, including replies that
arrive late. Hyalo owns rollback and the timeout, not a UI timer.

`client::Client` subscribes to changes/owner changes before GetState and runs
bounded calls on one worker. Its connection is separate from Config1/SettingsNative;
Drop closes it immediately, ending subscription iterators as well as the lease.
Brightness uses observed raw ranges and only renders a slider for an available,
writable channel. Pending slider values coalesce per device/generation, retaining
the final value. The worker rechecks generation/device/epoch/availability before
SetBrightness; sessiond still owns the rate gate, policy and hardware readback.
No UI error or timeout retries a mutation. There is no OSD or software brightness.

`nidara-display-selector` is a separate nk-wayland toplevel with app-id
`nidara-display-selector`, an ordinary retained Tree and one shared AT-SPI Bridge.
Escape closes it and releases its lease. Hyalo's `display-selector` action refuses
while locked and focuses an existing mapped instance, otherwise starting the
selector. It does not mint activation tokens or create compositor-owned controls
without semantics.

This cut runs in the separate Rust session. Build `nk-settings` and
`nidara-display-selector` and run `scripts/dev/rust-session.sh`, optionally with
`HYALO_BIN`, `SESSIOND_BIN`, `NK_SETTINGS_BIN`, `DISPLAY_SELECTOR_BIN` and
`NK_SETTINGS_DATA` selecting exact development binaries/exports. If the selector is
available the script replaces Super+P only in its private Hyalo configuration;
factory `hyalo.toml` and packaging/installation are unchanged. The wrapper records
shortcut-launched selector PIDs in the session's existing child cleanup list.
Shipping the native Settings or factory selector shortcut needs a separate owner
decision. The existing TS Display page is unchanged.

Verification uses pure preset/geometry/deadline tests, private Display1/brightness
services, and retained Tree actions with real exports. The manual
`scripts/dev/check-display-settings-headless.sh` runs the actual clients inside
rust-session.sh, headless Cage, a private PID namespace, bus, runtime, configuration
and portal fixture. It requires a final success marker, has a bounded lifetime and
tears down all children; a timeout or setup exception fails, never counts as a
negative control. Evidence is stored under target/display-settings. One nested
winit output does not validate physical multi-monitor, KMS, EDID, DDC, docks, lid,
Orca speech or installed-package behavior.
