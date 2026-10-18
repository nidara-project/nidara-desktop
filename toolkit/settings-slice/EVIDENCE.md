# #862 evidence — 2026-10-18

Base: upstream `3245a2a2`, PHASE1 revision 2. Arch Linux x86_64, Rust 1.99.0,
release profile, real fontique system collection, Parley 0.12, resvg 0.45.1.
The development transport runs on the owner's existing Hyalo session. This is
not an installed build or a full phase-1 acceptance run.

## Required measurement: blocked, not passed

The exact requested command was attempted against the **real** session:

```text
python3 scripts/dev/startup-probe.py --ready '^CONTENT_READY' nk-settings-slice 6 -- toolkit/target/release/nk-settings-slice
nk-settings-slice: no ready line and mapped window in 30 s
```

Direct invocation explains the failure:

```text
TIMING bus_connect=0.468
TIMING font_collection=32.728
SLICE_ERROR org.freedesktop.DBus.Error.ServiceUnknown: The name is not activatable
```

A direct call to `org.nidara.Config1.Snapshot` at `/org/nidara/Config` returned
ServiceUnknown too: the session's currently running shell does not publish
`org.nidara.Config`. The checked-out main does contain the service; changing or
restarting the installed desktop is not part of this slice. No Config1/file/cache
fallback was added. The slice exits without CONTENT_READY.

Consequently there is **no authoritative median of runs 2–6, PSS, presentation
measurement, or conclusion about <473 ms**. Those are acceptance blockers, not
zeroes or inferred budgets. The decisive run needs the current Config1 service
and current Settings portal running in the same Hyalo session.

## Local verification

- Locked release build: passes.
- Clippy, all targets, `-D warnings`: passes.
- Seven Rust tests: pass. They cover all 72 portal input tuples, unknown/missing
  authoritative data, invalid font refusal, actual pixel changes under the default
  control at 1 and 1.25, opaque fallback, missing fractional-scale capabilities,
  visible-only SVG loading, and cache reuse/separation at both scales.
- Both Python files compile; `git diff --check` passes.
- A frame was inspected visually: both groups, four controls, sidebar text and
  resvg icons are drawn. This frame used explicitly synthetic service values.

The explicit private-bus fixture ran on real Hyalo, with the real direct AT-SPI
provider and a real private AT-SPI registry. The fixture serves Snapshot and Get
independently at their public signatures; it is **not the real shell**:

```text
PASS assert-values: pixels == Config1.Get {'appearance.darkMode': True, 'appearance.windowTransparency': False, 'appearance.windowBlur': False, 'appearance.windowControls': 'left'}
PASS control applied; assert-values rejected painted defaults {'appearance.darkMode': False, 'appearance.windowTransparency': True, 'appearance.windowBlur': True, 'appearance.windowControls': 'right'}
```

The check decodes the buffer's track/segment pixels rather than trusting
DRAWN_VALUES. It requires the control's application marker and a complete frame;
crashes, timeouts and missing AT-SPI registration fail setup. An initial private
bus setup without an explicitly launched registry failed and was **not** counted
as a caught control. AT-SPI's absent systemd activation in a private session is
handled by starting its registry inside that fixture only.

Two additional private-fixture faults were exercised:

- Snapshot delayed 10 s: process exits 1 at 3.004 s with `initial data deadline`,
  without CONTENT_READY.
- Unsupported red portal RGB (outside the exported red): process exits 1 in
  0.037 s with `unknown portal accent`, without CONTENT_READY.

## One fixture-only timing breakdown

This final one-off release run is diagnostic, **not** a six-launch benchmark or
proof that the live target is met. Export data and fonts are real; Config1/portal
values and their response costs are from the private fixture. Font collection is
the largest measured component here; the corresponding live largest component
cannot be determined until the actual service is available.

| Component | ms |
|---|---:|
| Kernel process start → main (clock-tick estimate) | 8.753 |
| Bus connect | 0.535 |
| Config1.Snapshot (fixture) | 0.663 |
| Portal ReadAll (fixture) | 0.577 |
| Font collection (`system_fonts: true`) | 33.543 |
| Wayland connect + globals | 0.143 |
| First layout + scene construction | 18.473 |
| Icon raster (13 visible cache misses, total) | 0.808 |
| First paint (includes those icons) | 2.676 |
| First commit enqueue + flush | 0.009 |
| Main → complete first commit | 58.171 |

The first complete frame was local surface commit 2 and emitted CONTENT_READY
once. This is a commit measurement; it is not a claim that feedback for that
particular commit was presented. The live contract requires presentation evidence.

## CI: check supplied, integration not done

`check.py` can run for a few seconds inside the existing Hyalo smoke, with real
Config1/Get and portal, after the new binary and exports have been built. The
smoke's setup must ensure at least one non-default slice value (through a normal
external writer); an all-default session is refused as non-discriminating.

It is **not wired into CI**: `scripts/ci/hyalo-smoke.sh` and the workflows are not
among #862's authorised file paths. They were not changed. The check therefore
has not passed in vkms CI; the private fixture does not replace that requirement.
This draft must not close #862 until the real smoke check and measurement pass.

Workspace Cargo.toml/Cargo.lock changes are the metadata needed for the issue's
new workspace member. All implementation, checks and documentation are inside
`toolkit/settings-slice/`. No phase-0 crate, shell, export, protocol or skill file
was changed; skill documentation was left untouched under the explicit scope cap.
