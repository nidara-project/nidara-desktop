# Real fcitx5 and Orca evidence — 2026-10-16

**Tests 2 and 3 remain unpassed.** #839 fixed the original placement,
active-window and keyboard-monitor bugs below. The updated probes now test the
real matrices in CI and keep new baseline failures visible. This is a draft
handoff, not evidence that either issue can close.

## Current findings after #839

Built from main `9b294500` plus this PR's phase-0 diagnostics. The new test-window
flags only log Editor state (`--ime-evidence`) or inject an explicit faulty
cursor (`--control-ime-cursor`); no compositor/provider behaviour is changed.

### #835: the dropdown is not usable by speech

The real Orca 51.1 baseline says:

| Action | SPEECH OUTPUT | Result |
| --- | --- | --- |
| Space on Language | `space`, `Language` | FAIL: no expanded state/selected option |
| Down | none | FAIL: Chinese is not announced |
| Enter | `return`, `Language` | FAIL: no collapsed state/selected value |

Orca **does receive** `object:state-changed:expanded` and the options' selected
changes. Its debug source for Chinese has `enabled, selectable, selected,
sensitive, showing, visible`, but focus stays on the combo. Orca then logs
`The event is not from the locus of focus.` Its combo value generator finds no
selected descendant through the Selection interface; the provider currently
exposes no AT-SPI Selection interface. These are diagnostic leads for Claude,
not an assertion that one particular patch will fix the entire walk. Orca's
combo presentation also does not always speak literal expanded/collapsed words;
the acceptance requirement and platform semantics need review together. The
probe retains the requested state assertions instead of weakening them.

All other baseline steps speak as required, including the Unicode content
(read separately with KP Enter), edit/selection/caret, the whole Tab order,
password privacy, checkbox state, dialog/error/correction, and restored Review.
Faults for name, role, password leak, checkbox state, dialog, invalid-entry and
restored focus have been caught at their own speech assertions. The three
dropdown controls are reported **BLOCKED** because their baseline fails.

Flat review with KP Up is separate: Orca finds the complete Unicode line, but
logs `Unknown method 'GetRangeExtents'` and speaks only `日本🙂 `. The provider
has no text-range geometry implementation. KP Enter reads the complete control
without requiring that interface; the missing geometry is recorded here rather
than confused with paste's intentional silence.

### #832: Hangul Escape commits rather than cancels

Sequence: seed `base`, activate Hangul, type `gk` (하), Backspace (ㅎ), type `k`
(하), Escape. The wire then receives:

```text
zwp_text_input_v3.commit_string (Some("하"))
zwp_text_input_v3.done
IME_STATE ... "text":"base하", "preedit":null ...
```

The expected cancellation leaves `base`, so this row fails. Ctrl+Z undoes that
commit and leaves `base`, rather than undoing the seeded edit; it consequently
fails the cancelled-composition undo scenario too. This is a commit from the
real engine, not a spurious insertion invented by the toolkit. **Claude must
resolve the engine policy/contract question before the gate can pass.** The
probe does not suppress the commit or make Hangul an expected failure.

Mozc/Pinyin pass cancellation; all engines are exercised at 1 and 1.25. The
matrix checks underline pixels, UTF-8 byte cursor 7 in `日🙂尾`, insertion at
that cursor and replacement of the emoji selection, two-window focus, restart,
scrolling, Compose, dead acute and repeat timings. Baseline observations are
not gate passes: only the ignored-preedit and displaced-cursor controls have
been implemented for IME so far. Remaining per-row IME controls are explicitly
pending and keep the command nonzero, independently of the Hangul failure.

### Evidence and CI

Local runs use private namespaces, cage → nested Hyalo and the real Arch
components. Reports include binary SHA-256s, version information, per-action
speech/debug records, Editor/wire logs, screenshots and the row tables. These
local results **do not claim vkms evidence**. The same drivers are wired into
`hyalo-smoke.sh`; that job retains both reports even when either one fails.
The PR stays draft until the findings and remaining controls are resolved.

### Local verification of this draft

| Baseline | Scale 1 | Scale 1.25 |
| --- | --- | --- |
| Mozc | 24/24 | 24/24 |
| Pinyin | 24/24 | 24/24 |
| Hangul | 19/21 (Escape and its dependent undo fail) | 19/21 (same) |

Ignored-preedit controls: **6/6 caught**; displaced-cursor controls: **4/4
caught** (Mozc/Pinyin). These are only the two implemented IME controls, not a
claim that every row has its control. The candidate pane follows both field and
document scrolling for Mozc/Pinyin at both scales. Compose/dead acute and all
repeat timing/release/focus checks pass for all engines with the IME stopped.

Orca: **22/25 baseline assertions pass**, **7 fault controls caught**, **3 blocked
by their failing dropdown baseline**. Remaining per-assertion speech controls
are pending too. Baseline and controls are different columns: these numbers do
not declare either gate passed.

Local evidence folders: `/tmp/i6` (all engines/scales), `/tmp/i7` and `/tmp/i8`
(Pinyin rechecked at 1 and 1.25 after the first-preedit readiness fix), `/tmp/o6`
(Orca baseline and controls). The initial Pinyin snapshot in i6 was taken before
its asynchronous first preedit arrived; the corrected driver waits for that
first event, rather than assuming a fixed 150 ms. Both targeted reruns include
the full 24-assertion baseline and both implemented controls. The diagnostic
client SHA-256 is `7e91b82df4424a292e275a253d92028e2e8f6b391e8ab7c863375bcbc8ba9a63`;
Hyalo's is `07117896e917e6544f8d11a35110eb10b71e2a12f05b1d2702b1b1c837b39c7b`.

`cargo fmt --check`, workspace clippy with `-D warnings`, all workspace tests,
Python syntax checks, shell syntax checks and `skill-docs-check.mjs` pass.

## Historical findings before #839

The following records the original investigation. Its observations and FAIL
rows are historical; #839 fixes them, with the three probe-expectation changes
explained in the current README.

## Reproduce without changing the desktop session

Build `nk-phase0` and Hyalo as in [README.md](README.md). On Arch the probes need
`bwrap`, `cage`, `python-gobject`, `at-spi2-core`, `wl-clipboard`, `fcitx5`,
`fcitx5-mozc`, `fcitx5-chinese-addons`, `fcitx5-hangul`, `orca`,
`speech-dispatcher`, and `libao`.

```sh
# From the repository root. Requires unprivileged user namespaces and overlayfs.
NK_PHASE0_LOG=/tmp/nk-ime-prerequisites toolkit/phase0/check-prerequisites.sh ime
NK_PHASE0_LOG=/tmp/nk-orca-prerequisites toolkit/phase0/check-prerequisites.sh orca
```

`check-prerequisites.sh` runs the existing cage → nested Hyalo harness inside
bwrap, with private network/IPC/PID namespaces and `/proc`. It keeps D-Bus,
Wayland, XDG preferences, input-method profiles and logs private. The Orca run
selects libao's **null** driver in an `/etc` overlay, and uses speech-dispatcher's
real `sd_dummy` module. It neither changes the host's audio configuration nor
requires a running audio server. Each invocation needs its own evidence folder.

Missing packages can instead be extracted into a temporary directory without
installing them: `NK_PREFLIGHT_SYSROOT=/absolute/path/to/extracted-root` overlays
its `usr/` read-only. Optional `NK_PREFLIGHT_PACKAGE_MANIFEST` names a text file
of the extracted packages' names/versions. The wrapper compiles a private merged
schema set for Orca 51's GSettings preferences. It never writes into `/usr` or
`/etc` on the host.

The observed versions were fcitx5 **5.1.23**, Mozc **3.34.6345.2**, Chinese addons
**5.1.15**, Hangul **5.1.11**, Orca **51.1** (revision `244bdadd9`), AT-SPI
**2.62.1**, speech-dispatcher **0.12.1**, libao **1.2.2**. Source base:
`ee5841ae69d454dc498d614e946b1d76b57ef3ef`. The reports retain binary SHA-256s.
These are local Arch/nested-compositor observations, **not vkms/tty CI evidence**.

## #832: composition works; candidate panes cover the protected cursor

| Engine | Scale 1 commit | Scale 1.25 commit | Candidate placement |
| --- | --- | --- | --- |
| Mozc | `日本語` | `日本語` | FAIL at both scales |
| Pinyin | `中文` | `中文` | FAIL at both scales |
| Hangul | `한글` | `한글` | Not exercised; normal Hangul composition has no candidate list |

All six runs receive preedit through the real input-method-v2 → text-input-v3
bridge. The commit oracle independently copies the field through Wayland's
clipboard and requires the exact string. This is preliminary transport evidence,
not the matrix's future assertion on logged `Editor` state or its underline.

Mozc's first Space converts; a second opens the list and advances to Katakana.
The probe goes Up to select the first candidate (`日本語`) before confirming.
Hangul is finished by deactivating the engine; Enter also inserts a newline and
must not be mistaken for a failed syllable conversion.

The candidate oracle reads the client's actual `set_cursor_rectangle` request
from `WAYLAND_DEBUG` and measures the **entire connected candidate pane** in the
screenshot, using a private diagnostic classicui theme. Measuring only the
selected row would miss Mozc's overlap when its second candidate is selected.

| Scale | Protected caret in physical pixels | Mozc candidate pane | Pinyin candidate pane |
| --- | --- | --- | --- |
| 1 | `(200,111)–(201,147)` | `(200,111)–(411,404)` | `(200,111)–(502,147)` |
| 1.25 | `(91.25,138.75)–(92.5,183.75)` | `(91,139)–(355,505)` | `(91,139)–(469,183)` |

The panes begin at the top of the caret and cover it. This is shared Hyalo
placement, not missing engine support. `handlers.rs::new_popup` calls
`PopupSurface::set_text_input_rectangle`; Smithay's implementation also sets
`location` to `(x,y)`. Hyalo does not subsequently place the ordinary popup
outside the protected rectangle. The explicit animated-layer cursor path does
not correct ordinary text-input-v3 popup placement either.

Artifacts: `fcitx5-preflight/report.json`, `summary.md`, per-engine/scale client
and fcitx5 wire logs, candidate PNG/PPM captures, committed text and screenshots.
A pane failing placement does not prevent the independent commit assertion.

Still unrun: underline/replace, composition backspace/cancel/undo, interior-caret
UTF-8 surrounding text, selection replacement, second-window focus, restart,
scrolling, Compose/dead keys, repeat timing, fault controls, and vkms CI. A
passing prerequisite probe would still not establish the full test-2 matrix.

## #835: real Orca does not announce focus or typing

The oracle is Orca's **`SPEECH OUTPUT`** debug records, not generated speech
candidates, the app log or an AT-SPI tree query. Orca logs this exact string at
its final speech output boundary, adjacent to sending it to the speech server.
The dummy server connection is checked before asserting silence. Each step
retains its complete debug interval and exact utterances.

| Prerequisite step | Observed speech | Result |
| --- | --- | --- |
| Tab Password, Language, Remember me, Review, Name | none, for each control | FAIL |
| Paste `日本🙂 word` | none | FAIL |
| Delete `d`, insert `d` | none, for either step | FAIL |
| Left, Right | none, for either step | FAIL |
| Ctrl+Shift+Left | `word`, `selected` | PASS |
| Normal libatspi device key watcher | zero key-pressed events | FAIL |

Two separate gaps explain the failures:

1. **The form's frame lacks AT-SPI `active`.** Orca receives the focus signals
   but logs `lacks active state` and rejects that frame as its active window.
   The form's semantic root does not carry active-window state, and the direct
   provider's state mapping never emits it. The earlier libatspi walk checked
   control focus, not this Orca requirement. This needs real window activation
   semantics; permanently forcing `active` would conceal focus-loss errors.
2. **No compositor accessibility keyboard monitor delivers keys.** Neither
   private bus advertises the a11y Manager/KeyboardMonitor service. libatspi
   reports capabilities **5**, consistent with its legacy fallback, but the
   normal device watcher sees no keys during the walk. Orca classifies text
   events as `TextEventReason.UNKNOWN`, logs `Not speaking inserted string due
   to lack of cause`, and does not announce the edits. The successful word
   selection utterance demonstrates that Orca and its speech output are alive.

Artifacts: `orca-preflight/report.json`, `summary.md`, `orca-debug.log`, each
step's debug interval, `diagnostics.log`, both bus inventories, the form capture,
client/registry logs and speech-dispatcher's dummy logs.

Still unrun: password silence with a speaking baseline, expanded/selected/closed
dropdown speech, dialog/error/correction/restored-opener speech, their fault
controls, and vkms CI. Silence in the present broken focus path cannot establish
password privacy. No fault control is claimed caught while its baseline fails.

## Scope of the original prerequisite investigation

The new `scripts/dev/nk-*-preflight.py` probes and isolated launcher preserve the
findings for the compositor/provider fixes. No product source, provider choice,
contract, or existing manual gate was changed. The full automation and README
replacement in #832/#835 remain pending those fixes.
