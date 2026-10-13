# #742: float-return investigation — not reproduced

Measured on 2026-10-13 at `cb405718f23d39bdfcf7835a7fc8333e097d4413` (fresh `origin/main`).
Refs #742. This is an investigation, not a fix or a regression test: no failing case was found,
so the handoff's phase-1 stop condition applies. The issue remains open.

## What was exercised

A freshly built, unchanged debug compositor ran inside headless cage,
with the real shell in `sandboxed-shell.sh` (private HOME, runtime directory and session bus).
`msg outputs` confirmed **2560×1440 at 0,0, scale 1**. A Calculator born floating shared the
workspace with `hyalo-window-controls-probe`, explicitly tiled so both could enter the layout.
The workspace was tested in both floating and tiling mode.

The real bar menu was opened with `nidara-ipc openWindowMenu` **on the private bus**. Its
Tiling and Floating rows were clicked through `HYALO_CONTROL`, at (100,244) and (100,204),
after inspecting a screenshot of this shell. These coordinates are specific to this English
shell/configuration; the output explicitly verifies the first menu action tiled the target.

The first cycle matched the reported starting and intermediate geometry exactly:

| Step | x,y | width×height |
|---|---|---|
| Floating | 1100,382 | 360×616 |
| Tiled from the menu | 5,41 | 1272×1298 |
| Floated from the menu | **1100,382** | 360×616 |

Thus a second layout member explains the observed half-screen tile in this controlled run;
it does not explain the historical displacement to 1827,394.

Each workspace mode then repeated the menu cycle after a verified Super+left-button drag
and after an IPC resize. While tiled, an additional bar/left dock was mapped with the existing
layer probe and removed before restoring. This changed the tile from x=5,width=1272 to
x=85,width=1232; the saved floating rectangle still returned intact. This exercises changes
of exclusive zones, not removal/recreation of the actual shell's own surfaces.

Literal comparison output (`rg '^COMPARE|^MATRIX_COMPLETE' matrix.out`):

```text
COMPARE floating-menu-two-windows before=[1100,382,360,616] after=[1100,382,360,616]
COMPARE floating-after-drag before=[1220,412,360,616] after=[1220,412,360,616]
COMPARE floating-after-resize before=[1220,412,400,616] after=[1220,412,400,616]
COMPARE floating-zones-appear-disappear before=[1220,412,400,616] after=[1220,412,400,616]
COMPARE tiling-menu-two-windows before=[1220,412,400,616] after=[1220,412,400,616]
COMPARE tiling-after-drag before=[1340,442,400,616] after=[1340,442,400,616]
COMPARE tiling-after-resize before=[1340,442,440,616] after=[1340,442,440,616]
COMPARE tiling-zones-appear-disappear before=[1340,442,440,616] after=[1340,442,440,616]
MATRIX_COMPLETE
```

The earlier handoff drag script used `press 272`. `control.rs` requires `press X Y BUTTON`;
that attempt did not exercise moving. This run used `press X Y 272`, moved, released, and
verified the changed geometry (1100,382 → 1220,412; then 1220,412 → 1340,442).

## Separate observation: born tiled

At a verified **1280×720**, the sandboxed shell initially reported workspace 1 as tiling.
A newly launched Calculator tiled at (5,41), 1270×578, then floated at (5,41), **1270×616**.
That is the handoff's separate wide-window behavior; its earlier 1262-pixel measurement is
not the width measured here. No fix or product decision is proposed for it.

## Validation and limits

Executed against unchanged main, with an independent Cargo target directory:

- `cargo build --locked --offline`: passed; rebuilt `nidara-hyalo` from the isolated worktree.
- `cargo clippy --locked --all-targets -- -D warnings`: passed without warnings.
- `cargo test --locked`: **73 passed**, 0 failed.
- The diagnostic scripts passed `bash -n`; the matrix reached `MATRIX_COMPLETE`.

This is not a clean CI smoke result: the nested run logged EGL `BAD_SURFACE` messages,
an existing NetworkAgent registration conflict and an accessibility registration CRITICAL.
The geometry reads and menu actions completed, but these logs prevent claiming a clean shell
boot. Two cage wrappers remained after their nested Hyalo exited and were stopped by their
individual PIDs. No live compositor or GJS process was stopped.

Not tested: tty/DRM backend, the owner's live session, the exact 2026-10-05 binary,
multi-output/nonzero output origins, arbitrary timing/client commit races, X11 clients,
manual pointer resizing, or changes that leave the saved rectangle outside a new usable area.
The real menu was opened through its shell action, not by clicking the bar capsule. The test
uses the current menu implementation, not a reconstruction of its historical popup.
There was no temporary Rust instrumentation and no code change to the compositor, shell or CI.
No failing-on-main test exists from this investigation, and no passing check is presented as one.

## Repeat the diagnostic procedure

Use the repository's headless cage and sandboxed-shell harnesses only. Give the shell a
private HOME, runtime directory and session bus, as `sandboxed-shell.sh` does. Verify the
nested output with `msg outputs`; a host resolution alone does not establish its size.

1. Start workspace 1 in floating mode and launch Calculator, then the existing
   `hyalo-window-controls-probe` client built by the smoke harness.
2. Tile the probe, float and focus Calculator. Read its complete rectangle.
3. Open the real bar menu through `openWindowMenu` on the sandbox's private session bus.
   Inspect a screenshot, click Tiling through the control FIFO, and verify `floating=false`.
   Reopen the menu, click Floating, and compare the full rectangle, not just its size.
4. Hold Super (evdev 125), use `press X Y 272` inside Calculator, move the pointer, release
   button 272 and Super. Verify the window actually moved before repeating step 3.
5. Send `resize 40 0 ID` and repeat step 3.
6. Tile Calculator, launch `hyalo-layers-probe.js left bar-first`, verify the changed tile,
   stop that probe by its PID, and float Calculator. Compare against its saved floating box.
7. Switch the workspace to tiling mode, float Calculator again and repeat steps 2–6.

Require each expected state transition and a final completion marker. The existing
headless wrapper's exit status alone is insufficient because it ends in `|| true`.

The owner-local handoff contains the exact scripts, commands, screenshots and literal
full output. Those machine-local artifacts are intentionally not included in the public PR;
the comparison lines above are verbatim and contain only test labels and window geometry.
