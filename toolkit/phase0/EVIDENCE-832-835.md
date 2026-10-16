# Real fcitx5 and Orca evidence — #832 / #835

The gates run in the `hyalo` job on vkms. Local nested results alone do not pass
either gate. The implementation includes a control for every assertion;
the generated CI reports are the authoritative pass/fail record for each revision. Raw reports retain binary hashes,
versions, actual speech, wire traces, Editor state and screenshots.

## Acceptance decisions (Claude, #841; provider fix #842)

- Mozc/Pinyin Escape cancels and preserves `base`. Hangul follows the Korean
  engine's policy: Escape flushes `하` as a commit, producing `base하` without
  preedit; one Ctrl+Z removes exactly that commit. The Hangul control **drops
  the real commit**, and must fail. This is not implemented by suppressing an
  engine commit in the baseline.
- With focus on a combo, Orca presents its value on the state change. Space
  speaks Japanese; Down speaks Chinese; Enter speaks Chinese. Orca does not
  use literal “expanded”/“collapsed” words for this focused role. The expanded
  and collapse faults remove the event and leave only key echo, which fails the
  value assertion. #842 supplies Selection and SelectionChanged on the combo.
- Paste says “Pasted contents from clipboard.”. The Unicode content is verified
  separately by Tab out and Shift+Tab back: “Name entry 日本🙂 word”.
- An ordinary Atspi.Device listener is refused. An explicit WatchKeyboard call
  must return AccessDenied; real Orca key/editing echo is the positive delivery
  evidence. Capability bits alone do not demonstrate delivery.

## Reproduce without touching the desktop session

Build Hyalo and `nk-phase0` as described in README.md. On Arch, install `bwrap`,
`cage`, `python-gobject`, `at-spi2-core`, `wl-clipboard`, `nidara-input`, `fcitx5`,
`fcitx5-mozc`, `fcitx5-chinese-addons`, `fcitx5-hangul`, `orca`,
`speech-dispatcher` and `libao`.

```sh
NK_PHASE0_LOG=/tmp/ni toolkit/phase0/check-prerequisites.sh ime
NK_PHASE0_LOG=/tmp/no toolkit/phase0/check-prerequisites.sh orca
```

The launcher uses private PID/IPC/network namespaces, D-Bus, runtime, Wayland,
preferences and input-method profiles, with cage → nested Hyalo. This isolates
Mozc's abstract socket/process discovery too. Orca uses real speech-dispatcher
with `sd_dummy` and libao's null audio driver, set in an `/etc` overlay. There is
no audio-server or host-preference dependency. Short evidence paths are required
for the Unix speech socket. Missing packages can be extracted into a temporary
root named by `NK_PREFLIGHT_SYSROOT`; `NK_PREFLIGHT_PACKAGE_MANIFEST` optionally
records their versions. The wrapper merges and compiles Orca's private schemas.

The observed local package set is fcitx5 5.1.23, Mozc 3.34.6345.2, Chinese addons
5.1.15, Hangul 5.1.11, Orca 51.1 (244bdadd9), AT-SPI 2.62.1,
speech-dispatcher 0.12.1 and libao 1.2.2. CI installs the real Arch packages and
records its own versions. Do not mistake a local extracted root for the runner.

## IME assertions and discriminating controls

Every engine runs at **1 and 1.25**. Mozc/Pinyin have 22 assertion/control pairs
per scale; Hangul has 19 (ordinary Hangul composition has no candidate list).

| Assertion | Real fault in the test window |
| --- | --- |
| Changing, underlined preedit | Ignore real preedit batches; require incoming wire evidence still present |
| Candidate next to the cursor | Send a cursor rectangle displaced by 80 logical pixels |
| Exact commit, empty preedit | Drop the engine's real commit |
| Backspace in composition | Ignore the preedit update |
| Replacement of composing text | Ignore the replacement update |
| Escape | Ignore cancellation for Mozc/Pinyin; drop the real commit for Hangul |
| One undo after Escape | Ignore the actual Ctrl+Z |
| UTF-8 surrounding context at byte 7 in `日🙂尾` | Send cursor/anchor 0 while the Editor caret is 7 |
| Interior insertion | Append the commit to the end instead of the caret |
| Selection replacement | Insert at the caret without removing the selected emoji; arm before Hangul's first partial commit |
| Focus loss | Ignore the real focus-out |
| Fresh composition after focus-in | Keep text input disabled on focus-in |
| Restart with the same focused client | Drop the restarted engine's commit |
| Compose, dead acute | Replace the composed `é` with `e` |
| Repeat delay | Insert an extra character before the repeat delay |
| Repeat rate | Suppress three of each four repeated keys |
| Stop on release | Continue adding text after release |
| Repeated Backspace | Ignore its actual key events |
| Stop on focus loss | Continue adding text after focus-out |
| Candidates after field scroll | Omit the field scroll from the sent cursor rectangle |
| Candidates after document scroll | Omit the document scroll from the sent cursor rectangle |

Fault files exist only for this test binary, in the private evidence directory.
Each is armed after normal setup and immediately before its target action. The
Editor evidence records that the mutation actually ran. A timeout, missing
mutation, failed setup or dead client cannot satisfy a control. A failed
baseline blocks its corresponding control. Initial wire reception and a positive
field-scroll offset are setup conditions, not substitute passes for painted
preedit or candidate placement.

Candidate detection floods the diagnostic classicui panel's fill, excluding the
caret rectangle. Adjacent rows can touch after #839, so flooding the caret too
would manufacture an overlap. The oracle requires both horizontal alignment
and vertical proximity to the protected caret, not merely non-overlap.

Compose/dead-key checks stop fcitx5 so the native client's XKB code does the work.
Repeat samples use the delivered key counter, client monotonic timestamps, the
600 ms / 25 Hz seat settings, release and a second window. Output scale is
persisted in the private settings layer: changing the keyboard reapplies output
configuration and would reset a transient IPC scale. The original keyboard,
scale and workspace are restored.

## Orca assertions and controls

The oracle is the real reader's **SPEECH OUTPUT**, at its final speech boundary
next to sending text to the speech server. Each action retains the full debug
interval, utterances and screenshot. The actual reader, client and speech server
must all stay alive. Password silence is measured for the full settling interval
after a positive speaking baseline; the leak fault must speak `s e c r e t`.

The baseline has 25 assertions. Its 23 fault runs cover the entire Tab order,
role/name/state, clipboard acknowledgment and Unicode readback, insertion,
deletion, caret, selection, privacy, dropdown, checkbox, dialog/error, rejected
Save, correction and both closing paths. Repeated Password/Language focus
preconditions share the corresponding Tab role control. The denied ordinary
keyboard listener is the negative access-control case, paired with Orca's
positive key echo. The JSON report records that coverage explicitly.

Dynamic controls preserve stable semantic roles. The three wrong-role fixtures
are fixed before registration; changing a live node's role would violate the
provider's stable-ID invariant and crash, which cannot count as a caught oracle.
Dialog controls demonstrate both missing invalid-entry speech and focus restored
to Name instead of Review. Correction and edit controls ignore real keyboard
edits; their failed speech assertions are retained in each child report.

## Harness findings corrected during CI verification

The first #841 run exercised the drivers on vkms but was **not green**:

- Editor JSON interleaved with Wayland debug output, and fixed-delay snapshots
  could precede a delivered state. Editor JSON now has a separate append-only
  file, and the repeat clock starts after delivery of the initial key. Positive
  setup and first real preedit are checked before their dependent actions.
- Candidate assertions originally accepted a pane arbitrarily far below the
  cursor. Field/document-scroll controls exposed this; proximity is now checked.
- CI's artifact uploader could not traverse fcitx's 0700 profile directories.
  The disposable artifact copy is made readable before upload.
- KP Enter read the complete control locally but yielded only its key echo in
  that CI run. Unicode readback uses normal keyboard focus return, which is part
  of the required walk. The separate keypad-command discrepancy is retained as
  an observation for follow-up, not a claimed keyboard-command pass.
- The #842 main run failed the earlier test-5 cursor oracle: a 93-pixel solid
  span estimated scale 1.1625, then rejected a correct outward-rounded cursor
  rectangle `(144, 62, 4, 16)` by 0.05 pixels. Test 5 now carries the scanline's
  physical-pixel uncertainty through the top/bottom rounding instead of treating
  its integer span as exact scale. Captures include the numerical bounds. Replay
  accepts both main captures and rejects unscaled, misplaced and wrong-height
  rectangles. The full isolated native test-5 run (`/tmp/q5/check.log`) passes
  at both scales, including missing-association, missing-parent-commit and
  client-motion controls. The real missing-association control stays mandatory.
- Runs `38851510725` and `38852370207` pass the entire Orca matrix on vkms
  (**25/25** speech assertions, **23/23** fault runs). IME remains failed:
  preparation sent Ctrl+V before the client's new clipboard offer arrived.
  In the first run, one release snapshot also preceded the received `keyup`.
  The wire shows no repeated edits after that release. Preparation now requires
  the new client offer plus an independent exact-byte clipboard read, then one
  real paste. Release snapshots wait for the client's real keyboard release
  event. Neither handshake retries the tested edit or relaxes its assertion.
- Run `38920374708` then passed both complete matrices on vkms (IME 126/126
  assertion/control pairs; Orca 25/25 assertions and 23/23 controls). Repeating
  the final-head run `38923021229` still exposed asynchronous IME sampling:
  Hangul's flush arrived after the snapshot and completed the correct text;
  a Pinyin control sampled before its second preedit update; and Mozc's first
  `n` after focus return preceded the new input-method activation/grab, reaching
  the field as literal text (`basen異本語`). Those failures remain in the reports.
  Orca stayed complete and green, including its stronger actual-application guard.
- The IME driver now waits for the received key release and for all received
  text-input done/leave events to be processed by Editor. The fixture records
  independent event counters, incremented even when a fault discards a batch.
  Hangul flush waits for a real commit batch, without checking its text.
- The pinned input-method-v2 XML defines activation as double-buffered through
  done, and keyboard grab as a separate request. The pre-grab `n` therefore does
  not by itself establish a protocol violation. Startup, restart and focus
  return wait for activation/done and the grab's keymap before composing; focus
  return additionally identifies the fresh field by its seeded surrounding text.
  If that context/grab never arrives, the focus-return assertion fails, including
  the control that prevents re-enabling it. Both windows remain alive until the
  assertion. Text expectations are unchanged and no action is retried. The
  original pre-activation interval remains reported to Claude for UX/latency
  review, with no claim that a compositor buffering bug has been fixed.
- A snapshot nonce is acknowledged by the test window at idle after dispatch.
  This makes native key/chord snapshots wait for their queued Application
  callbacks too; it only reports state and never injects input or changes Editor.
  Seed preparation also checks that a new Paste callback ran, even for an empty
  seed. Copy waits for the new selection offer and checks both clipboard bytes
  and Editor text. Repeat timing starts at the first delivered key's counter,
  so unrelated evidence snapshots cannot shift the measured delay.

## Debt outside the gate: flat-review range geometry

KP Up flat review finds the complete Unicode line, but reports
`Unknown method GetRangeExtents` and speaks only `日本🙂 `. The provider has no
text-range geometry implementation. Claude explicitly took this separately in
#841; the gate's keyboard/form walk does not require flat review. The debt stays
in the Nidara skill.

#839 resolved the original candidate overlap, missing active-window semantics
and absent keyboard monitor. #842 resolved the combo Selection gap. Hangul's
Escape behaviour is now an explicit accepted engine policy. Earlier reports and
exact traces remain in this file's history and the #832/#835/#841 discussions.

## Verification records

The local post-#842 Orca run (`/tmp/p3/orca-report.json`) passes all **25/25**
speech assertions and catches all **23/23** fault runs. The complete matrix is
also green in both vkms runs listed above, including explicit Tab/Backspace
echo. `complete_matrix` is true and coverage accounts for every assertion.
The full local IME run (`/tmp/s3/fcitx5-preflight/report.json`, driver revision
`3e602bed`) passes all **126/126** assertions and catches all **126/126** controls
across all three engines and both scales; `complete_matrix` is true. It includes
the stricter applied-preedit marker and the clipboard/release handshakes.

Final review also restored the normal test window's original 1000 ms idle poll
interval when no fault file is supplied; only fault-file runs poll at 50 ms.
The vkms CI reports carry the exact tested revision and binary hashes; consult
the PR checks and uploaded artifacts for the authoritative current result.

Workspace fmt, clippy with `-D warnings`, unit/corpus tests, Python and shell
syntax, skill-docs-check and diff checks pass. A clean build is not a substitute
for either real-component integration report.
