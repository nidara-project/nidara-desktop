# nk-a11y — phase 0, test 3 (#830)

The window owns a `Tree` of `Node`s: stable nonzero IDs, roles, labels,
descriptions, states, allowed actions, model bounds and child IDs. IDs belong to
the control for the entire window lifetime, including while absent from the
projection. `Snapshot` validates reachability, a single focused node and role
identity. The application is responsible for allocating IDs without reusing them
for another control. `Tree::filtered` is the reader-filter seam for phase 1;
there is no agent-facing endpoint in phase 0.

`TextInfo` is plain data, **all indices in UTF-8 bytes**. The app fills its text,
caret, anchor, word ranges and painted line ranges from `Editor`/`Layout`.
`nk-a11y` imports neither `nk-text`, rendering nor Wayland. `characters()`
converts to Unicode scalar offsets; incoming AT-SPI character selections are
converted back to bytes before the shared `Callback` queues a `Request` to the
application thread. A caret request is a degenerate selection. The app checks
that the control still exists, is enabled in the active modal context and allows
the operation. Its editor enforces grapheme boundaries.

Both default features, `accesskit` and `atspi`, implement `A11yBackend::update`:

- `accesskit_backend::Backend`: AccessKit 0.25.1, accesskit_unix 0.24.0; real
  text-run children with UTF-8 character lengths, word starts, per-layout-line
  runs and selection positions. AccessKit derives and sends platform events.
- `atspi_backend::Backend`: independent zbus provider, Accessible, Application,
  Component, Action, Text and EditableText. It discovers the AT-SPI bus through
  `org.a11y.Bus`, embeds the application in the registry, serves current model
  values and emits focus/property/state/text/caret/selection/children events.
  The optional Cache endpoint returns an empty initial cache: consumers use
  Accessible queries. This prototype does not implement a cache optimization.

Both redact a password's `TextInfo` **before** retaining a platform snapshot or
computing events. The password has no value, runs, boundaries, caret, selection
or length. The direct backend omits Text; AccessKit may expose a zero-length
Text interface for its password role. Neither permits reading or editing a
password via accessibility. Unit tests query both projections, including a
malformed caller that supplies password text, and the mutation check removes the
shared redaction and requires **both** tests to fail. Password content also stays
out of the IME's surrounding text and the clipboard copy/cut path.

Bounds are logical model coordinates in the containing native window. Wayland
does not supply global window origins; these are not claimed as desktop-screen
coordinates. The direct provider explicitly refuses other coordinate frames;
AccessKit receives no invented root-window screen position.

## Checks

From the repository root:

```sh
cargo test --manifest-path toolkit/Cargo.toml --locked -p nk-a11y
cargo test --manifest-path toolkit/Cargo.toml --locked -p nk-a11y --no-default-features
cargo test --manifest-path toolkit/Cargo.toml --locked -p nk-a11y --no-default-features --features accesskit
cargo test --manifest-path toolkit/Cargo.toml --locked -p nk-a11y --no-default-features --features atspi
python3 scripts/ci/nk-a11y-control.py
```

The `toolkit` CI job runs those, the workspace build/clippy/unit tests and the
existing text/render controls. The `hyalo` job installs `python-gobject` and
`at-spi2-core` and runs `scripts/ci/nk-a11y-check.py` on its vkms compositor,
after the existing text/IME/glass check. No desktop installation is needed.

Locally, build `nk-phase0`, Hyalo and `hyalo-ime-probe` as described in
`toolkit/phase0/README.md`, then run the private compositor/bus harness:

```sh
NK_PHASE0_CHECK=nk-a11y-check.py NK_PHASE0_LOG=/tmp/nk-a11y-evidence \
  toolkit/phase0/check-headless.sh
```

`HYALO_BIN` and `NK_PHASE0_BIN` override the binaries. `hyalo-ime-probe` must be
in PATH. The driver starts the registry explicitly inside the private bus
instead of allowing a development machine's user systemd instance to activate
it. `IsEnabled` activates AccessKit. Input enters through `HYALO_CONTROL` and
the existing input-method-v2 probe; the **oracle is libatspi**, as used by Orca,
not the application's state or log. Do not run the driver against a live bus.

The driver disables client caching for both providers, refreshes current queries
and verifies events separately; this does not prove Orca cache behavior.

The driver walks roles/names/states and Component model bounds, tabs the whole form, inserts `日本🙂 word`,
corrects its final letter, checks insert/delete/caret **character** offsets and
word selection, and verifies password queries and events. It opens, chooses and
closes a dropdown, toggles a checkbox, corrects a modal error, tests rejected
Save and Escape, verifies restored focus and invokes AT actions. Each named
oracle has a separate `--control-a11y=NAME` fault in the test app and must fail at
its own assertion. A fault caught when the baseline fails too is **not** evidence
that the oracle discriminates: the report labels that separately.

`a11y/report.json`, per-run trees/events/client/IME logs and captures are retained
under `NK_PHASE0_LOG`; CI uploads them with `hyalo-artifacts`. A non-passing
backend leaves the command and CI **failing**. There is no expected-failure list,
no automatic backend choice and no claim that a scripted walk replaces Orca.

`NK_A11Y_BACKENDS=atspi` can isolate a backend while investigating;
`NK_A11Y_CONTROLS=0` isolates the baseline. Neither is used by CI. Costs compare
mapped idle RSS to the identical `--a11y none` form, include tree-build and
backend-initialization times, and count the platform events observed for one
Backspace. AccessKit initialization is asynchronous, so its synchronous
constructor time alone is not an activation-time comparison. The report records
build mode and environment; nested/headless CPU figures are not GPU benchmarks.

## Comparison

The committed `EVIDENCE.md` records the actual run, version/build details, one
check-by-backend table and the measured costs. It records failures as failures.
The owner chooses a backend after the live Orca walk below; this change does not
choose one or declare test 3 passed.

## Owner's live Orca walk (both backends)

Use a Hyalo session with Orca enabled, keyboard echo of characters and selection
announcements enabled, and a terminal to launch each backend in turn:

```sh
wl-copy '日本🙂 word'
toolkit/target/release/nk-phase0 --a11y accesskit
# Repeat the entire walk after closing the app:
toolkit/target/release/nk-phase0 --a11y atspi
```

The quoted content below is what must be conveyed. Roles can be translated by
Orca's locale; speech order depends on its verbosity. Record the actual speech
and Orca version, and mark a missing role/state/change as a failure.

| Keyboard action | What Orca must convey |
| --- | --- |
| On opening | “Nidara accessibility form”, “Name”, entry, blank; focus is in Name. |
| Tab four times, then Tab once more | “Password”, protected/password entry; “Language”, combo box, Japanese; “Remember me”, checkbox, not checked; “Review”, button; then “Name”, entry. |
| Ctrl+V | The nonsecret content “日本🙂 word”; caret is after the final `d`. |
| Backspace, then `d` | Removal of `d`, then insertion of `d`, with no extra text removed. |
| Ctrl+Shift+Left | “word”, selected. Left/Right clear/move selection and announce the intended character. |
| Tab; type `secret` | “Password”, protected entry. It must never speak or expose `secret` or any of its individual letters, caret positions or length. |
| Tab; Space | “Language”, combo box, expanded; Japanese selected. |
| Down; Enter | Chinese selected, then collapsed; selected value remains Chinese. |
| Tab; Space | “Remember me”, checkbox, checked. Shift+Tab and Tab recover the same order. |
| Tab; Enter | New dialog “Correct error”; “Confirmation”, entry, invalid, “Enter correct to fix this error”, initial value “wrong”. |
| Tab; Enter on Save | Invalid Save keeps the dialog open. Shift+Tab returns to Confirmation. |
| Ctrl+A; type `correct`; Tab; Enter | Replacement announced; invalid state clears. Dialog closes; “Review”, button, focused again. |
| Enter; Escape | Dialog opens and closes; focus returns to Review again. |

Use Alt+F4 to close the main window. Preserve results separately for each
backend, including any AT-SPI warnings. The `fcitx5` matrix remains its own owner
gate; only the form's name field is used by the scripted Unicode test here.
