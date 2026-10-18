# nk-settings-slice (#862)

A read-only start-up specimen for `../PHASE1.md` revision 2. It does not replace
Settings, claim its bus name, or change a preference. There is no Apply or routing.

From the repository root:

```sh
node --experimental-strip-types scripts/export-settings-data.mjs
node --experimental-strip-types scripts/export-tokens.mjs
cargo build --manifest-path toolkit/Cargo.toml --locked --release -p nk-settings-slice
toolkit/target/release/nk-settings-slice
scripts/dev/startup-probe.py --ready '^CONTENT_READY' nk-settings-slice 6 -- toolkit/target/release/nk-settings-slice
```

`NK_SETTINGS_DATA` overrides `build/settings-data`. Labels use the session language
(`LANGUAGE`, then `LC_ALL`/`LC_MESSAGES`/`LANG`), with per-key English fallback.
Every manifest page appears in the scrollable sidebar; subpages without an icon
inherit their parent's icon. Appearance is selected; other pages are draw-only.
The interface icon theme is resolved under `ui/shell/assets/icons/<theme>/`, with
the reference theme as the last link for partial themes, like `Icons.ts`.

The four controls come from the two manifest groups, with their labels, subtitles,
control kinds, options, availability and current values from Snapshot. Unknown enum
values get a segment labelled with the raw value. Predicate dependencies also come
from Snapshot. The only hardcoded preference values are the **test-only mutation**
behind `--control-default-values` (light, transparent, blur enabled, controls right).
Production never falls back to them.

The bus worker starts before the real fontique system collection. It uses one
connection, installs Updated/SettingChanged/owner subscriptions before Snapshot,
and rereads authoritative state on changes (no event replay across epochs).
Initial data has a three-second overall deadline; each method call also has a
three-second timeout. Errors terminate with `SLICE_ERROR`, rather than displaying
cached/default values. The phase-0 direct AT-SPI provider runs off the first-frame
path, with an explicit setup deadline; the tree is read-only and follows updates.
This is not the full phase-1 widget/Orca acceptance tree.

The window is the toolkit's transport, `nk-wayland` (`src/host.rs` is only the
`Application`): its own app-id and title through `Options`, readiness logged from
`Application::committed`, i.e. **after** its buffer's commit and flush, and the
window's background (D6) from `Application::window_background`. With material,
Hyalo draws the window's background; without it (`Frame::material` false), the
client draws an opaque base from the same tokens. Row/state overlays keep their
alpha. Without viewporter + fractional-scale, `nk-wayland` falls back to integer
buffer scale (D5). Buffers remain immutable until release.

`TIMING` durations are milliseconds. `process_start_to_main` includes loader time,
using `/proc/self/stat` and CLOCK_BOOTTIME (quantised to kernel clock ticks).
`first_layout` includes shaping and scene construction; `first_paint` includes CPU
rasterisation and icons, whose individual cache misses also print `icon_raster`.
`main_to_first_commit` is the total, not the sum of overlapping worker durations.
`CONTENT_READY commit=N` is emitted once, only after a frame containing all four
complete rows is committed. Commit numbers include the initial empty xdg commit;
`PRESENTED commit=N` pairs compositor feedback with individual buffer commits.
The existing probe's `--ready` milestone is the later of mapping and stderr
readiness; do not call that a presentation-time measurement without matching
feedback. A discarded feedback is not evidence of presentation.

## Checks

```sh
cargo test --manifest-path toolkit/Cargo.toml --locked -p nk-settings-slice
cargo clippy --manifest-path toolkit/Cargo.toml --locked -p nk-settings-slice --all-targets -- -D warnings
python toolkit/settings-slice/check.py toolkit/target/release/nk-settings-slice
```

`check.py` is the short smoke check, intended for the **existing** Hyalo session
inside CI, with the real shell and Settings portal. It calls Config1.Get, starts
baseline and control, requires CONTENT_READY and A11Y_READY, and decodes control
states from the exact shm pixels submitted. It never accepts a crash, missing
marker, deadline, or unrelated error as a caught control. It changes no preferences.
If all four values are defaults, it refuses the setup: disposable CI must seed at
least one non-default value through an external writer first. The sample decoder
uses the exported accents' chroma against neutral tracks; it is specific to this
specimen's tokens, not an image recognition API.

`NK_SLICE_FRAME` is an optional test-only destination for that committed frame's
native-endian ARGB8888 bytes and pixel sample locations, reported by FRAME_EVIDENCE.
It is not used by normal launches or the startup probe.

For development when the installed shell lacks Config1, the explicit fixture is:

```sh
GIO_USE_VFS=local dbus-run-session -- python toolkit/settings-slice/fixture.py -- \
  python toolkit/settings-slice/check.py toolkit/target/release/nk-settings-slice
```

The fixture refuses existing service owners, owns services on the private bus, and
starts a real private AT-SPI registry. Its values are synthetic and its results are
**not** the owner's start-up evidence. `NK_FIXTURE_STALL=1` delays Snapshot ten
seconds; `NK_FIXTURE_UNKNOWN_ACCENT=1` returns an unsupported portal accent.

## Outstanding acceptance

See [EVIDENCE.md](EVIDENCE.md). The check is not connected to
`scripts/ci/hyalo-smoke.sh`: that path is not among the files #862 authorises.
The necessary workspace-member and lockfile changes accompany this new member;
no shell, exporter, protocol, transport crate, skill or workflow is edited.
