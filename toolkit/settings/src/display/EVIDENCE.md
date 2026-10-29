<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# Display settings cut (d), local evidence

Base: `59ba997efe89acd6c1f896761395ecb99442d4fe` (#968).
Branch: `codex/959-display-settings`. Verification date: 2026-10-29.
These are local results; no remote CI or physical hardware acceptance is claimed.

## Automated checks

Settings: 115 passed, one existing wallpaper timing test ignored. The library and
application tests were rerun after the final source edits: 65 + 11 passed. The 39
integration tests cover bus, chooser, font descriptions, page lifecycle, render,
retained images, routing, thumbnail strips, wallpaper builders and window behavior.
New Display coverage includes private typed Display1/brightness services, token and
sender ownership, failed confirmation retry, brightness coalescing/stale generation,
owner loss, unmount, stale semantic targets, epoch changes with identical IDs,
mirror follower restrictions, presets, deadlines and logical coordinate ordering.

Hyalo: 133 tests passed. Settings and Hyalo all-target Clippy passed with
`-D warnings`; Settings formatting, shell syntax, Python compilation,
`skill-docs-check.mjs` and `git diff --check` passed.

The first integration run failed routing fixture setup because the worktree's
Unix socket pathname exceeded sockaddr_un. The fixture now uses a private Linux
abstract socket; all six routing tests passed on rerun. One final library invocation
omitted NK_SETTINGS_DATA and failed seven export-dependent tests; the corrected
invocation with complete generated exports passed all 65 library tests.

Build/test targets were reused with CARGO_INCREMENTAL=0 for Settings and a free
disk floor of 10 GiB. Generated data, logs and screenshots are ignored artifacts
under `target/display-settings/`, not checked-in binaries.

## Actual native clients in the isolated Rust session

`scripts/dev/check-display-settings-headless.sh` runs the production
`rust-session.sh` inside headless Cage and a private PID namespace, bus, runtime,
configuration, settings store and portal fixture. The test does not use the owner's
live compositor, bus or hardware. It requires result.json with passed=true and
tears down all children. Exact binary paths and SHA-256 hashes are saved per run.

The final normal D7 run, `headless-normal-final`, passed:

- Opening/observing and editing the draft caused no Display1 mutation.
- Real retained AT-SPI selection and Scale edits drove Validate/Preview.
- The accessible countdown used the server deadline; Revert restored the layout.
- Keep changes retained the new layout; navigation away cancelled another lease.
- Actual Super+P launched the separately identified selector. Unsupported modes
  were disabled. A repeated shortcut raised the same instance.
- Physical key events Down/Enter selected and previewed Extend; Escape closed the
  selector and restored the confirmed layout.

Screenshots `display-initial.png`, `display-confirmation.png`, `display-page.png`
and `selector.png` were inspected. The compact confirmation is visible near the
leading content edge. Confirmation capture waits for the callback of its exact
root frame (`DISPLAY_CONFIRMATION_FRAME ... deadline=...`), not just GetState.
That is a nested capture barrier, not KMS presentation evidence. The D5 opaque run
`headless-final` also passed the full functional sequence and was visually inspected.

Some earlier D7 attempts timed out during screenshot capture; they are failed runs,
not acceptance. A separate Appearance-only D7 capture succeeded, followed by the
successful complete D7 run above. EGL BAD_SURFACE diagnostics and an awww BrokenPipe
panic occur during nested teardown, including the Appearance baseline. They are
retained in logs and are not evidence of clean shutdown of every dependency.
The private namespace bounds their lifetime; no nested Hyalo is left running.

Final D7 binary SHA-256 values:

| Binary | SHA-256 |
| --- | --- |
| nidara-hyalo | 5dff30c26b57a7fa6adab646655be8f7aa8d0cf4c2c959b874e28334b480db43 |
| nk-settings | ea419830b14dc5bdfd899300481ee61bf4c22ce785fa3643fdf15c09c7574c5b |
| nidara-display-selector | 11b7afa83922fef54578ea29721507951c2ffb47d9898ee6025191baf5f66569 |
| nidara-sessiond | 2361686416e3cdc35723bc72212de7a6d30297ea0a1619194651b8ba69df459a |

Reproduce with exact built binaries and complete exported data:

```sh
HYALO_BIN=/absolute/path/nidara-hyalo \
SESSIOND_BIN=/absolute/path/nidara-sessiond \
NK_SETTINGS_BIN=/absolute/path/nk-settings \
DISPLAY_SELECTOR_BIN=/absolute/path/nidara-display-selector \
NK_SETTINGS_DATA="$PWD/build/settings-data" \
scripts/dev/check-display-settings-headless.sh
```

Add NK_SETTINGS_OPAQUE_PREVIEW=1 for D5. Settings tests require the same complete
NK_SETTINGS_DATA export. No CI configuration was added or changed.

## Limits

One winit output does not prove physical multi-monitor mirroring, EDID/DDC, docks,
lid, multi-GPU or real backlight behavior. Brightness transport is covered with a
private provider, not a real screen. AT-SPI actions are not Orca speech evidence.
Packaging, installation and the factory Super+P binding remain a separate decision.
